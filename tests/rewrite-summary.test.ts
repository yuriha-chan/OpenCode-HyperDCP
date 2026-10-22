import "./helpers/storage-env"
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
    commitBlock,
    createHousekeepingHarness,
    stageBlock,
    visibleText,
    type HousekeepingHarness,
} from "./helpers/housekeeping"

async function contextText(h: HousekeepingHarness): Promise<string> {
    return visibleText(
        (await h.render()).map((message) => ({
            ...message,
            parts: message.parts.filter((part) => part.type === "text"),
        })),
    )
}

async function assertVersion(h: HousekeepingHarness, version: number, summary: string) {
    const result = await h.versions(1, version)
    assert.match(result, new RegExp(`v${version}\\b`))
    assert.ok(result.endsWith(`\n\n${summary}`), result)
}

function commandReply(h: HousekeepingHarness, previousCalls: number): string {
    assert.equal(h.client.session.prompt.mock.callCount(), previousCalls + 1)
    const call = h.client.session.prompt.mock.calls.at(-1)!
    const body = call.arguments[0].body as {
        noReply: boolean
        parts: { type: string; text: string; ignored: boolean }[]
    }
    assert.equal(body.noReply, true)
    assert.equal(body.parts.length, 1)
    assert.equal(body.parts[0].type, "text")
    assert.equal(body.parts[0].ignored, true)
    return body.parts[0].text
}

describe("rewrite_summary tool", () => {
    test("compression exposes its original summary as the only active version", async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)

        const versions = await h.versions()
        assert.match(versions, /Active version: v1\b/)
        assert.match(versions, /1 version\(s\) available/)
        await assertVersion(h, 1, "Parser findings.")
        assert.match(await contextText(h), /Parser findings\./)
        h.assertSessionReads()
    })

    test("rewrite requires housekeeping and preserves the committed summary", async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)

        await assert.rejects(
            h.run("rewrite_summary", { blockId: 1, summary: "Rejected rewrite." }),
            /enter_housekeeping/i,
        )

        assert.match(await h.versions(), /Active version: v1\b/)
        assert.doesNotMatch(await h.versions(), /Rejected rewrite\./)
        assert.match(await contextText(h), /Parser findings\./)
        h.assertSessionReads()
    })

    test("draft fetch sees a rewrite while ordinary context retains the committed summary until leave", async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)
        await h.enter()
        await h.run("rewrite_summary", { blockId: 1, summary: "The parser permits empty records." })

        assert.match(await h.versions(), /Active version: v2\b/)
        await assertVersion(h, 1, "Parser findings.")
        await assertVersion(h, 2, "The parser permits empty records.")
        const before = await contextText(h)
        assert.match(before, /Parser findings\./)
        assert.doesNotMatch(before, /The parser permits empty records\./)

        await h.leave()

        const after = await contextText(h)
        assert.match(after, /The parser permits empty records\./)
        assert.doesNotMatch(after, /Parser findings\./)
        await assertVersion(h, 1, "Parser findings.")
        await assertVersion(h, 2, "The parser permits empty records.")
        h.assertSessionReads()
    })

    test("a block created in the current draft can be rewritten before either operation is committed", async (t) => {
        const h = await createHousekeepingHarness(t)
        await h.enter()
        await stageBlock(h)
        await h.run("rewrite_summary", { blockId: 1, summary: "Draft parser findings." })

        await assertVersion(h, 1, "Parser findings.")
        await assertVersion(h, 2, "Draft parser findings.")
        const before = await h.render()
        for (const id of ["source-1", "source-2", "source-3", "source-4"]) {
            assert.ok(before.some((message) => message.info.id === id))
        }
        assert.doesNotMatch(await contextText(h), /Draft parser findings\./)

        await h.leave()

        const after = await h.render()
        for (const id of ["source-1", "source-2"]) {
            assert.ok(!after.some((message) => message.info.id === id))
        }
        assert.match(await contextText(h), /Draft parser findings\./)
        h.assertSessionReads()
    })

    test("multiple rewrites retain stable selectable versions and activate the latest", async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)
        await h.command("autotoggle on")
        await h.enter()
        await h.run("rewrite_summary", { blockId: 1, summary: "First rewrite." })
        await h.run("rewrite_summary", { blockId: 1, summary: "Second rewrite." })

        assert.match(await h.versions(), /Active version: v3\b/)
        assert.match(await h.versions(), /3 version\(s\) available/)
        await assertVersion(h, 1, "Parser findings.")
        await assertVersion(h, 2, "First rewrite.")
        await assertVersion(h, 3, "Second rewrite.")
        await h.run("toggle_summary_version", { blockId: 1, version: 2 })
        await h.leave()

        assert.match(await h.versions(), /Active version: v2\b/)
        const text = await contextText(h)
        assert.match(text, /First rewrite\./)
        assert.doesNotMatch(text, /Second rewrite\./)
        await assertVersion(h, 3, "Second rewrite.")
        h.assertSessionReads()
    })

    test("rewrite trims surrounding whitespace without altering the original version", async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)
        await h.enter()
        await h.run("rewrite_summary", { blockId: 1, summary: " \n  Trimmed findings.\t " })
        await h.leave()

        await assertVersion(h, 1, "Parser findings.")
        await assertVersion(h, 2, "Trimmed findings.")
        h.assertSessionReads()
    })

    for (const { name, args, error } of [
        {
            name: "missing block",
            args: { blockId: 999, summary: "Unknown block." },
            error: /block.*not found/i,
        },
        { name: "empty summary", args: { blockId: 1, summary: "" }, error: /empty/i },
        { name: "whitespace summary", args: { blockId: 1, summary: " \n\t " }, error: /empty/i },
    ]) {
        test(`rewrite rejects a ${name} and leaves the preceding draft usable`, async (t) => {
            const h = await createHousekeepingHarness(t)
            await commitBlock(h)
            await h.enter()
            await h.run("rewrite_summary", { blockId: 1, summary: "Retained draft." })

            await assert.rejects(h.run("rewrite_summary", args), error)

            assert.match(await h.versions(), /Active version: v2\b/)
            assert.match(await h.versions(), /2 version\(s\) available/)
            await assertVersion(h, 2, "Retained draft.")
            assert.match(await contextText(h), /Parser findings\./)
            await h.run("append_summary", { blockId: 1, text: " Still editable." })
            await h.leave()
            await assertVersion(h, 3, "Retained draft. Still editable.")
            assert.match(await contextText(h), /Retained draft\. Still editable\./)
            h.assertSessionReads()
        })
    }

    for (const tool of ["edit_summary", "append_summary"] as const) {
        test(`${tool} requires housekeeping and preserves the original summary`, async (t) => {
            const h = await createHousekeepingHarness(t)
            await commitBlock(h)
            const args =
                tool === "edit_summary"
                    ? { blockId: 1, oldString: "Parser", newString: "Changed", replaceAll: false }
                    : { blockId: 1, text: " Changed." }

            await assert.rejects(h.run(tool, args), /enter_housekeeping/i)

            assert.match(await h.versions(), /Active version: v1\b/)
            assert.doesNotMatch(await h.versions(), /pending/i)
            assert.match(await contextText(h), /Parser findings\./)
            h.assertSessionReads()
        })
    }

    test("consecutive edits and appends share a pending buffer and create one version on leave", async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)
        await h.enter()
        await h.run("edit_summary", {
            blockId: 1,
            oldString: "Parser",
            newString: "Lexer",
            replaceAll: false,
        })
        await h.run("append_summary", { blockId: 1, text: " Preserve newlines." })
        await h.run("edit_summary", {
            blockId: 1,
            oldString: "newlines",
            newString: "empty records",
            replaceAll: false,
        })

        const draft = await h.versions()
        assert.match(draft, /pending/i)
        assert.match(draft, /Lexer findings\. Preserve empty records\./)
        assert.match(await contextText(h), /Parser findings\./)
        assert.doesNotMatch(await contextText(h), /Lexer findings\./)

        await h.leave()

        assert.match(await h.versions(), /2 version\(s\) available/)
        assert.doesNotMatch(await h.versions(), /pending/i)
        await assertVersion(h, 2, "Lexer findings. Preserve empty records.")
        assert.match(await contextText(h), /Lexer findings\. Preserve empty records\./)
        h.assertSessionReads()
    })

    for (const replaceAll of [false, true]) {
        test(`edit_summary replaces ${replaceAll ? "all matching fragments" : "only the first matching fragment"}`, async (t) => {
            const h = await createHousekeepingHarness(t)
            await commitBlock(h, "Parser checks Parser output.")
            await h.enter()
            await h.run("edit_summary", {
                blockId: 1,
                oldString: "Parser",
                newString: "Lexer",
                replaceAll,
            })
            await h.leave()

            await assertVersion(
                h,
                2,
                replaceAll ? "Lexer checks Lexer output." : "Lexer checks Parser output.",
            )
            h.assertSessionReads()
        })
    }

    for (const version of [1, 2]) {
        test(`edit then toggle to version ${version} materializes the buffer without overriding the later selection`, async (t) => {
            const h = await createHousekeepingHarness(t)
            await commitBlock(h)
            await h.command("autotoggle on")
            await h.enter()
            await h.run("edit_summary", {
                blockId: 1,
                oldString: "Parser",
                newString: "Edited parser",
                replaceAll: false,
            })
            await h.run("toggle_summary_version", { blockId: 1, version })

            await assertVersion(h, 2, "Edited parser findings.")
            assert.match(await h.versions(), new RegExp(`Active version: v${version}\\b`))
            assert.match(await contextText(h), /Parser findings\./)

            await h.leave()

            assert.match(await h.versions(), new RegExp(`Active version: v${version}\\b`))
            assert.match(await h.versions(), /2 version\(s\) available/)
            assert.match(
                await contextText(h),
                version === 1 ? /Parser findings\./ : /Edited parser findings\./,
            )
            h.assertSessionReads()
        })
    }

    test("edit then rewrite preserves the edited buffer as an earlier version and activates the rewrite", async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)
        await h.enter()
        await h.run("edit_summary", {
            blockId: 1,
            oldString: "Parser",
            newString: "Edited parser",
            replaceAll: false,
        })
        await h.run("rewrite_summary", { blockId: 1, summary: "Later rewrite." })

        await assertVersion(h, 2, "Edited parser findings.")
        await assertVersion(h, 3, "Later rewrite.")
        assert.match(await h.versions(), /Active version: v3\b/)
        await h.leave()

        assert.match(await h.versions(), /3 version\(s\) available/)
        assert.match(await h.versions(), /Active version: v3\b/)
        assert.match(await contextText(h), /Later rewrite\./)
        assert.doesNotMatch(await contextText(h), /Edited parser findings\./)
        h.assertSessionReads()
    })

    test("rewrite then edit starts from the rewritten summary and retains both versions", async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)
        await h.enter()
        await h.run("rewrite_summary", { blockId: 1, summary: "Rewritten parser findings." })
        await h.run("edit_summary", {
            blockId: 1,
            oldString: "Rewritten",
            newString: "Refined",
            replaceAll: false,
        })
        await h.run("append_summary", { blockId: 1, text: " Preserve newlines." })

        assert.match(await h.versions(), /Refined parser findings\. Preserve newlines\./)
        assert.match(await contextText(h), /Parser findings\./)
        await h.leave()

        await assertVersion(h, 1, "Parser findings.")
        await assertVersion(h, 2, "Rewritten parser findings.")
        await assertVersion(h, 3, "Refined parser findings. Preserve newlines.")
        assert.match(await h.versions(), /Active version: v3\b/)
        assert.match(await contextText(h), /Refined parser findings\. Preserve newlines\./)
        h.assertSessionReads()
    })

    test("a rejected rewrite leaves the preceding pending buffer intact without allocating a version", async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)
        await h.enter()
        await h.run("append_summary", { blockId: 1, text: " Retained pending detail." })
        const before = await h.versions()

        await assert.rejects(h.run("rewrite_summary", { blockId: 1, summary: " \n " }), /empty/i)

        assert.equal(await h.versions(), before)
        await h.run("append_summary", { blockId: 1, text: " Continued." })
        await h.leave()

        await assertVersion(h, 2, "Parser findings. Retained pending detail. Continued.")
        assert.match(await h.versions(), /2 version\(s\) available/)
        assert.match(await contextText(h), /Retained pending detail\. Continued\./)
        h.assertSessionReads()
    })

    test("a user turn and repeated renders do not autosave a pending summary buffer", async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)
        await h.enter()
        await h.run("append_summary", { blockId: 1, text: " Pending detail." })
        const before = await h.versions()
        assert.match(before, /pending/i)
        h.addText("working-user-turn", "Continue the summary maintenance.", "user")

        await h.render()
        await h.render()

        assert.equal(await h.versions(), before)
        assert.match(await contextText(h), /Parser findings\./)
        assert.doesNotMatch(await contextText(h), /Pending detail\./)
        await h.run("edit_summary", {
            blockId: 1,
            oldString: "Pending",
            newString: "Final",
            replaceAll: false,
        })
        await h.leave()

        await assertVersion(h, 2, "Parser findings. Final detail.")
        assert.match(await h.versions(), /2 version\(s\) available/)
        assert.match(await contextText(h), /Parser findings\. Final detail\./)
        h.assertSessionReads()
    })

    for (const { name, args, error } of [
        {
            name: "missing fragment",
            args: { blockId: 1, oldString: "absent", newString: "replacement", replaceAll: false },
            error: /not found/i,
        },
        {
            name: "unchanged replacement",
            args: { blockId: 1, oldString: "Parser", newString: "Parser", replaceAll: false },
            error: /differ/i,
        },
        {
            name: "missing block",
            args: { blockId: 999, oldString: "Parser", newString: "Lexer", replaceAll: false },
            error: /block.*not found/i,
        },
    ]) {
        test(`edit_summary rejects a ${name} without discarding earlier pending edits`, async (t) => {
            const h = await createHousekeepingHarness(t)
            await commitBlock(h)
            await h.enter()
            await h.run("append_summary", { blockId: 1, text: " Retained detail." })
            const before = await h.versions()

            await assert.rejects(h.run("edit_summary", args), error)

            assert.equal(await h.versions(), before)
            await h.leave()
            await assertVersion(h, 2, "Parser findings. Retained detail.")
            h.assertSessionReads()
        })
    }

    test("append_summary rejects an unknown block while retaining another block's pending buffer", async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)
        await h.enter()
        await h.run("append_summary", { blockId: 1, text: " Retained detail." })
        const before = await h.versions()

        await assert.rejects(
            h.run("append_summary", { blockId: 999, text: "Wrong block." }),
            /block.*not found/i,
        )

        assert.equal(await h.versions(), before)
        await h.leave()
        await assertVersion(h, 2, "Parser findings. Retained detail.")
        h.assertSessionReads()
    })

    for (const replacement of ["", " \n\t "]) {
        test(`leave rejects a ${replacement === "" ? "zero-length" : "whitespace-only"} summary buffer and permits repair`, async (t) => {
            const h = await createHousekeepingHarness(t)
            await commitBlock(h)
            await h.enter()
            await h.run("edit_summary", {
                blockId: 1,
                oldString: "Parser findings.",
                newString: replacement,
                replaceAll: false,
            })

            await assert.rejects(h.leave(), /empty|summary|buffer/i)

            assert.match(await contextText(h), /Parser findings\./)
            assert.match(await h.versions(), /pending/i)
            await h.run("append_summary", { blockId: 1, text: "Repaired findings." })
            await h.leave()

            await assertVersion(h, 2, "Repaired findings.")
            assert.match(await h.versions(), /2 version\(s\) available/)
            assert.match(await contextText(h), /Repaired findings\./)
            h.assertSessionReads()
        })
    }
})

describe("/dcp toggle command", () => {
    test("toggle without a version lists the original and its active selection through the host API", async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)
        const calls = h.client.session.prompt.mock.callCount()

        await h.command("toggle 1")

        const reply = commandReply(h, calls)
        assert.match(reply, /Block #1 versions:/)
        assert.match(reply, /1 v1.*Parser findings\./)
        assert.match(reply, /Active: v1\b/)
        assert.match(await h.versions(), /Active version: v1\b/)
        h.assertSessionReads()
    })

    for (const version of [0, 1, 2]) {
        test(`command toggle selects version ${version} outside housekeeping without requiring autotoggle`, async (t) => {
            const h = await createHousekeepingHarness(t)
            await commitBlock(h)
            await h.enter()
            await h.run("rewrite_summary", { blockId: 1, summary: "Command-selected rewrite." })
            await h.leave()
            const calls = h.client.session.prompt.mock.callCount()

            await h.command(`toggle 1 ${version}`)

            const label = version === 0 ? "disabled" : `v${version}`
            assert.match(commandReply(h, calls), new RegExp(`summary set to ${label}\\b`))
            assert.match(await h.versions(), new RegExp(`Active version: ${label}\\b`))
            const text = await contextText(h)
            if (version === 0) {
                assert.doesNotMatch(text, /Parser findings\.|Command-selected rewrite\./)
            } else {
                assert.match(
                    text,
                    version === 1 ? /Parser findings\./ : /Command-selected rewrite\./,
                )
                assert.doesNotMatch(
                    text,
                    version === 1 ? /Command-selected rewrite\./ : /Parser findings\./,
                )
            }
            await assertVersion(h, 1, "Parser findings.")
            await assertVersion(h, 2, "Command-selected rewrite.")
            h.assertSessionReads()
        })
    }

    test("an out-of-range command version reports an error and preserves the selected rewrite", async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)
        await h.enter()
        await h.run("rewrite_summary", { blockId: 1, summary: "Retained rewrite." })
        await h.leave()
        const calls = h.client.session.prompt.mock.callCount()

        await h.command("toggle 1 5")

        assert.match(commandReply(h, calls), /Version 5 does not exist/i)
        assert.match(await h.versions(), /Active version: v2\b/)
        assert.match(await contextText(h), /Retained rewrite\./)
        h.assertSessionReads()
    })

    test("a command toggle during housekeeping joins the draft and publishes on leave", async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)
        await h.enter()
        await h.run("rewrite_summary", { blockId: 1, summary: "Unselected draft rewrite." })
        const calls = h.client.session.prompt.mock.callCount()

        await h.command("toggle 1 1")

        assert.match(commandReply(h, calls), /summary set to v1\b/)
        assert.match(await h.versions(), /Active version: v1\b/)
        await assertVersion(h, 2, "Unselected draft rewrite.")
        assert.match(await contextText(h), /Parser findings\./)
        await h.leave()

        assert.match(await h.versions(), /Active version: v1\b/)
        assert.match(await contextText(h), /Parser findings\./)
        assert.doesNotMatch(await contextText(h), /Unselected draft rewrite\./)
        h.assertSessionReads()
    })

    test("a command edit persists only in the recoverable draft until leave", async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)
        await h.command("autotoggle on")
        await h.enter()
        await h.command("toggle 1 0")
        await h.restart()
        assert.match(await h.versions(), /Active version: disabled/)
        assert.match(await contextText(h), /Parser findings\./)
        await h.leave()
        assert.doesNotMatch(await contextText(h), /Parser findings\./)
        h.assertSessionReads()
    })

    test("summary mutation call identities replay the original outcome without applying twice", async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)
        await h.enter()
        const first = await h.run(
            "append_summary",
            { blockId: 1, text: " Retry-safe detail." },
            { callID: "append-once" },
        )
        assert.equal(
            await h.run(
                "append_summary",
                { blockId: 1, text: " Retry-safe detail." },
                { callID: "append-once" },
            ),
            first,
        )
        const edited = await h.run(
            "edit_summary",
            { blockId: 1, oldString: "Parser findings.", newString: "Syntax findings." },
            { callID: "edit-once" },
        )
        assert.equal(
            await h.run(
                "edit_summary",
                { blockId: 1, oldString: "Parser findings.", newString: "Syntax findings." },
                { callID: "edit-once" },
            ),
            edited,
        )
        await h.leave()
        assert.match(await h.versions(1, 2), /Syntax findings\. Retry-safe detail\./)
        assert.doesNotMatch(await h.versions(1, 2), /Retry-safe detail\. Retry-safe detail\./)
    })

    test("rewrite retries after restart return the recorded operation result", async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)
        await h.enter()
        const args = { blockId: 1, summary: "Single durable rewrite." }
        const first = await h.run("rewrite_summary", args, { callID: "rewrite-retry" })
        await h.restart()
        assert.equal(await h.run("rewrite_summary", args, { callID: "rewrite-retry" }), first)
        assert.match(await h.versions(), /2 version\(s\) available/)
        await h.leave()
        await assertVersion(h, 2, "Single durable rewrite.")
    })
})
