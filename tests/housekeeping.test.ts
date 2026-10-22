import "./helpers/storage-env"
import assert from "node:assert/strict"
import { mkdir, rename, rm } from "node:fs/promises"
import test from "node:test"
import { getInvalidConfigKeys, validateConfigTypes } from "../lib/config"
import { getSessionFilePath } from "../lib/paths"
import { createSessionState } from "../lib/state"
import {
    createHousekeepingHarness,
    ordinaryMessage,
    stageBlock,
    visibleText,
} from "./helpers/housekeeping"

test("enter returns existing uncovered ranges and actionable housekeeping guidance", async (t) => {
    const h = await createHousekeepingHarness(t)
    const guidance = await h.enter()

    assert.match(guidance, /m0001[\s\S]*m0004/)
    assert.match(guidance, /4 messages/)
    for (const name of ["compress", "edit_memo", "read_memo", "leave_housekeeping"]) {
        assert.ok(guidance.includes(name), `guidance must describe ${name}`)
    }
    assert.match(guidance, /stag|draft|accumulat/i)
    assert.match(guidance, /block|restrict/i)
    assert.doesNotMatch(guidance, /save_summary/)
    h.assertSessionReads()
})

test("entry with no remaining eligible messages returns guidance and an empty range result", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await stageBlock(h, "All parser findings.", "m0001", "m0004")
    await h.leave()

    const guidance = await h.enter()

    assert.match(guidance, /no.*(uncovered|eligible)|(?:uncovered|eligible).*none/i)
    assert.match(guidance, /leave_housekeeping/)
    assert.doesNotMatch(guidance, /m0001\s*→\s*m0004/)
    await h.leave()
    h.assertSessionReads()
})

test("recursive entry rejects without replacing an accumulated memo", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { oldString: "", newString: "Keep this draft." })

    await h.guard("enter_housekeeping")
    await assert.rejects(h.enter(), /already|recursive|active/i)

    assert.equal(await h.readMemo(), "Keep this draft.")
    await h.leave()
    assert.equal(await h.readMemo(), "Keep this draft.")
    await h.enter()
    await h.leave()
    h.assertSessionReads()
})

test("required mode cannot be bypassed when an older config omits housekeeping settings", async (t) => {
    const h = await createHousekeepingHarness(t)
    h.config.housekeeping = undefined as never
    await assert.rejects(
        h.run("edit_memo", { oldString: "", newString: "Must stay committed." }),
        /enter_housekeeping/i,
    )
    assert.equal(await h.readMemo(), "(memo is empty)")
})

test("leave outside housekeeping rejects and normal tool execution remains available", async (t) => {
    const h = await createHousekeepingHarness(t)
    await assert.rejects(h.leave(), /not.*housekeeping|enter_housekeeping|no.*active/i)
    await h.guard("read", { filePath: "example.ts" })
    assert.equal(await h.readMemo(), "(memo is empty)")
})

test("tool-before session switching reloads each session's housekeeping access", async (t) => {
    const state = createSessionState()
    const first = await createHousekeepingHarness(t, { sharedState: state })
    await first.enter()
    await first.run("edit_memo", { oldString: "", newString: "First session draft." })

    const second = await createHousekeepingHarness(t, {
        sharedState: state,
        messages: [ordinaryMessage("ses_second", "second-user", "user", "Ordinary session.")],
    })
    await second.guard("read", { filePath: "example.ts" })

    await assert.rejects(first.guard("read", { filePath: "example.ts" }), /housekeeping/i)
    assert.equal(await first.readMemo(), "First session draft.")
    first.assertSessionReads()
    second.assertSessionReads()
})

test("leaving an empty transaction succeeds once and permits another independent transaction", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    assert.match(await h.leave(), /left|leave|complete|committ|applied/i)
    await assert.rejects(h.leave(), /not.*housekeeping|enter_housekeeping|no.*active/i)
    await h.enter()
    await h.guard("read_memo")
    await h.leave()
    await h.guard("read")
    h.assertSessionReads()
})

test("retrying identical boundary calls is idempotent while a distinct second entry rejects", async (t) => {
    const h = await createHousekeepingHarness(t)
    const entryID = { callID: "enter-retry", messageID: "enter-retry-message" }
    const exitID = { callID: "leave-retry", messageID: "leave-retry-message" }
    const guidance = await h.run("enter_housekeeping", {}, entryID)
    assert.equal(await h.run("enter_housekeeping", {}, entryID), guidance)
    await assert.rejects(h.enter(), /already|recursive|active/i)
    await h.run("edit_memo", { oldString: "", newString: "Exactly once." })

    const receipt = await h.run("leave_housekeeping", {}, exitID)

    assert.equal(await h.run("leave_housekeeping", {}, exitID), receipt)
    assert.equal(await h.readMemo(), "Exactly once.")
    await assert.rejects(h.leave(), /not.*housekeeping|enter_housekeeping|no.*active/i)
    h.assertSessionReads()
})

for (const input of ["", " ", "\n\t"]) {
    test(`read_memo reports empty after committing ${JSON.stringify(input)}`, async (t) => {
        const h = await createHousekeepingHarness(t)
        await h.enter()
        await h.run("edit_memo", { oldString: "", newString: "Temporary memo." })
        await h.run("edit_memo", { oldString: "Temporary memo.", newString: input })
        assert.equal(await h.readMemo(), "(memo is empty)")
        await h.leave()
        assert.equal(await h.readMemo(), "(memo is empty)")
        await h.restart()
        assert.equal(await h.readMemo(), "(memo is empty)")
        h.assertSessionReads()
    })
}

test("edit_memo requires entry even for an otherwise valid empty-memo insertion", async (t) => {
    const h = await createHousekeepingHarness(t)
    await assert.rejects(
        h.run("edit_memo", { oldString: "", newString: "Do not publish." }),
        /enter_housekeeping/i,
    )
    assert.equal(await h.readMemo(), "(memo is empty)")
})

for (const replaceAll of [false, true]) {
    test(`memo edits read the preceding accumulated result with replaceAll=${replaceAll}`, async (t) => {
        const h = await createHousekeepingHarness(t)
        await h.enter()
        await h.run("edit_memo", { oldString: "", newString: "alpha alpha" })
        await h.run("edit_memo", { oldString: "alpha", newString: "beta", replaceAll })
        assert.equal(await h.readMemo(), replaceAll ? "beta beta" : "beta alpha")
        await h.run("edit_memo", { oldString: "beta", newString: "gamma" })
        const expected = replaceAll ? "gamma beta" : "gamma alpha"
        assert.equal(await h.readMemo(), expected)
        await h.leave()
        assert.equal(await h.readMemo(), expected)
        await h.restart()
        assert.equal(await h.readMemo(), expected)
        h.assertSessionReads()
    })
}

for (const { name, args, error } of [
    {
        name: "an absent fragment",
        args: { oldString: "absent", newString: "replacement" },
        error: /not found/i,
    },
    {
        name: "an unchanged replacement",
        args: { oldString: "Draft", newString: "Draft" },
        error: /differ/i,
    },
]) {
    test(`edit_memo rejects ${name} without losing earlier accumulated edits`, async (t) => {
        const h = await createHousekeepingHarness(t)
        await h.enter()
        await h.run("edit_memo", { oldString: "", newString: "Draft memo." })
        await assert.rejects(h.run("edit_memo", args), error)
        assert.equal(await h.readMemo(), "Draft memo.")
        await h.run("edit_memo", { oldString: "Draft", newString: "Repaired" })
        await h.leave()
        assert.equal(await h.readMemo(), "Repaired memo.")
        h.assertSessionReads()
    })
}

test("draft memo inspection does not publish the memo to ordinary model context", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await stageBlock(h)
    await h.run("edit_memo", { oldString: "", newString: "Committed parser memo." })
    await h.leave()
    await h.enter()
    await h.run("edit_memo", { oldString: "Committed", newString: "Staged" })
    assert.equal(await h.readMemo(), "Staged parser memo.")
    const ordinaryText = (await h.render())
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
    assert.match(ordinaryText, /Committed parser memo\./)
    assert.doesNotMatch(ordinaryText, /Staged parser memo\./)

    await h.leave()
    await h.restart()
    assert.equal(await h.readMemo(), "Staged parser memo.")
    h.assertSessionReads()
})

test("restart restores an open transaction's draft and tool restrictions until leave", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await stageBlock(h, "Recovered parser summary.")
    await h.run("edit_memo", { oldString: "", newString: "Recovered draft memo." })
    await h.restart()

    assert.equal(await h.readMemo(), "Recovered draft memo.")
    assert.match(await h.versions(1, 1), /Recovered parser summary\./)
    await assert.rejects(h.guard("bash"), /housekeeping/i)
    await assert.rejects(h.enter(), /already|recursive|active/i)
    assert.match(visibleText(await h.render()), /Investigate the parser boundary\./)
    await h.leave()
    await h.restart()
    assert.equal(await h.readMemo(), "Recovered draft memo.")
    assert.doesNotMatch(visibleText(await h.render()), /Investigate the parser boundary\./)
    await h.guard("bash")
    h.assertSessionReads()
})

test("leave applies compression and memo together and reopening after revert undoes both", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await stageBlock(h, "Transaction summary.")
    await h.run("edit_memo", { oldString: "", newString: "Transaction memo." })
    const beforeLeave = structuredClone(h.history)
    await h.leave()
    const committed = structuredClone(h.history)
    assert.doesNotMatch(visibleText(await h.render()), /Investigate the parser boundary\./)
    assert.equal(await h.readMemo(), "Transaction memo.")

    h.setHistory(beforeLeave)
    await h.render()
    await h.restart()
    assert.equal(await h.readMemo(), "Transaction memo.")
    assert.match(visibleText(await h.render()), /Investigate the parser boundary\./)
    await assert.rejects(h.guard("read"), /housekeeping/i)

    h.setHistory(committed)
    await h.render()
    assert.doesNotMatch(visibleText(await h.render()), /Investigate the parser boundary\./)
    assert.equal(await h.readMemo(), "Transaction memo.")
    await h.guard("read")
    h.assertSessionReads()
})

test("failed entry host read leaves the session outside mode and allows retry", async (t) => {
    const h = await createHousekeepingHarness(t)
    const calls = h.client.session.messages.mock.callCount()
    h.client.session.messages.mock.mockImplementationOnce(async () => {
        throw new Error("entry transcript unavailable")
    })

    await assert.rejects(h.enter(), /entry transcript unavailable/)

    assert.equal(h.client.session.messages.mock.callCount(), calls + 1)
    await h.guard("read")
    await h.enter()
    await h.leave()
    h.assertSessionReads()
})

test("concurrent entry attempts enable one transaction and reject the other without losing its draft", async (t) => {
    const h = await createHousekeepingHarness(t)
    const results = await Promise.allSettled([h.enter(), h.enter()])
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
    const rejected = results.find((result) => result.status === "rejected")
    assert.ok(rejected && rejected.status === "rejected")
    assert.match(String(rejected.reason), /already|recursive|active/i)
    await h.run("edit_memo", { oldString: "", newString: "Single transaction." })
    await h.leave()
    assert.equal(await h.readMemo(), "Single transaction.")
    h.assertSessionReads()
})

test("leave rejects an invalid summary without publishing an otherwise valid memo edit", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await stageBlock(h, "Committed parser summary.")
    await h.run("edit_memo", { oldString: "", newString: "Committed parser memo." })
    await h.leave()
    await h.enter()
    await h.run("edit_memo", { oldString: "Committed", newString: "Staged" })
    await h.run("edit_summary", {
        blockId: 1,
        oldString: "Committed parser summary.",
        newString: "",
    })
    await assert.rejects(h.leave(), /empty|non-empty|blank/i)
    await h.restart()
    assert.equal(await h.readMemo(), "Staged parser memo.")
    const ordinaryText = (await h.render())
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
    assert.match(ordinaryText, /Committed parser memo\./)
    assert.match(ordinaryText, /Committed parser summary\./)
    assert.doesNotMatch(ordinaryText, /Staged parser memo\./)
    await h.run("append_summary", { blockId: 1, text: "Repaired parser summary." })
    await h.leave()
    await h.restart()
    assert.equal(await h.readMemo(), "Staged parser memo.")
    assert.match(await h.versions(1, 2), /Repaired parser summary\./)
    h.assertSessionReads()
})

test("leave persistence failure keeps all effects staged and permits a durable retry", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await stageBlock(h, "Durable parser summary.")
    await h.run("edit_memo", { oldString: "", newString: "Durable parser memo." })
    const file = getSessionFilePath(h.sessionID)
    const backup = `${file}.test-backup`
    await rename(file, backup)
    await mkdir(file)
    try {
        await assert.rejects(h.leave(), /persist|write|directory|EISDIR|EEXIST|rename/i)
        assert.equal(await h.readMemo(), "Durable parser memo.")
        assert.match(visibleText(await h.render()), /Investigate the parser boundary\./)
        await assert.rejects(h.guard("read"), /housekeeping/i)
    } finally {
        await rm(file, { recursive: true, force: true })
        await rename(backup, file)
    }
    await h.leave()
    await h.restart()
    assert.equal(await h.readMemo(), "Durable parser memo.")
    assert.doesNotMatch(visibleText(await h.render()), /Investigate the parser boundary\./)
    await h.guard("read")
    h.assertSessionReads()
})

test("failed memo persistence leaves the previous draft intact and supports retry", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    const file = getSessionFilePath(h.sessionID)
    const backup = `${file}.mutation-backup`
    await rename(file, backup)
    await mkdir(file)
    try {
        await assert.rejects(
            h.run(
                "edit_memo",
                { oldString: "", newString: "Uncommitted draft." },
                { callID: "memo-retry" },
            ),
            /persist|write|directory|EISDIR|EEXIST|rename/i,
        )
        assert.equal(await h.readMemo(), "(memo is empty)")
    } finally {
        await rm(file, { recursive: true, force: true })
        await rename(backup, file)
    }
    assert.equal(
        await h.run(
            "edit_memo",
            { oldString: "", newString: "Durable draft." },
            { callID: "memo-retry" },
        ),
        "Memo edited (14 chars).",
    )
    assert.equal(
        await h.run(
            "edit_memo",
            { oldString: "", newString: "Durable draft." },
            { callID: "memo-retry" },
        ),
        "Memo edited (14 chars).",
    )
    assert.equal(await h.readMemo(), "Durable draft.")
    await h.leave()
})

test("leave and a concurrent mutation serialize without losing or leaking the mutation", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    const results = await Promise.allSettled([
        h.leave(),
        h.run(
            "edit_memo",
            { oldString: "", newString: "Serialized draft." },
            { callID: "concurrent-memo" },
        ),
    ])
    assert.equal(results[0].status, "fulfilled")
    const memoResult = results[1]
    let expectedMemo: string
    if (memoResult.status === "fulfilled") {
        expectedMemo = "Serialized draft."
    } else {
        assert.match(String(memoResult.reason), /enter_housekeeping|active|not.*housekeeping/i)
        expectedMemo = "(memo is empty)"
    }
    await h.restart()
    assert.equal(await h.readMemo(), expectedMemo)
    await h.guard("read")
})

for (const name of [
    "read",
    "write",
    "edit",
    "apply_patch",
    "bash",
    "shell",
    "glob",
    "grep",
    "webfetch",
    "task",
    "unknown_tool",
]) {
    test(`tool execution guard blocks ${name} by default only while housekeeping is active`, async (t) => {
        const h = await createHousekeepingHarness(t)
        const execute = t.mock.fn(async (_args: unknown) => "executed")
        const args = { path: "example.ts" }
        await h.guard(name, args)
        assert.equal(await execute(args), "executed")
        await h.enter()
        await assert.rejects(async () => {
            await h.guard(name, args)
            await execute(args)
        }, /housekeeping/i)
        assert.equal(execute.mock.callCount(), 1)
        await h.leave()
        await h.guard(name, args)
        await execute(args)
        assert.equal(execute.mock.callCount(), 2)
        for (const call of execute.mock.calls) assert.deepEqual(call.arguments, [args])
        h.assertSessionReads()
    })
}

for (const name of [
    "leave_housekeeping",
    "compress",
    "edit_memo",
    "rewrite_summary",
    "toggle_summary_version",
    "expand_block",
    "edit_summary",
    "append_summary",
    "read_memo",
    "fetch_summary_versions",
    "recall_compressed",
]) {
    test(`tool execution guard permits housekeeping API ${name} during mode`, async (t) => {
        const h = await createHousekeepingHarness(t)
        await h.enter()
        await h.guard(name)
        await h.leave()
        h.assertSessionReads()
    })
}

for (const name of ["read", "write", "bash", "custom_inspect"]) {
    test(`exact configured exception permits ${name} while unrelated tools remain blocked`, async (t) => {
        const h = await createHousekeepingHarness(t, { allowedTools: [name] })
        await h.enter()
        await h.guard(name)
        await assert.rejects(h.guard(`${name}_other`), /housekeeping/i)
        await assert.rejects(h.guard("unknown_tool"), /housekeeping/i)
        await h.leave()
        h.assertSessionReads()
    })
}

test("an allowed exception still fails when its host executor denies permission", async (t) => {
    const h = await createHousekeepingHarness(t, { allowedTools: ["bash"] })
    const execute = t.mock.fn(async (_args: unknown) => {
        throw new Error("host permission denied")
    })
    const args = { command: "pwd" }
    await h.enter()
    await assert.rejects(async () => {
        await h.guard("bash", args)
        await execute(args)
    }, /host permission denied/)
    assert.equal(execute.mock.callCount(), 1)
    assert.deepEqual(execute.mock.calls[0].arguments, [args])
    await h.leave()
    h.assertSessionReads()
})

test("parallel dispatch validates nested tools and cannot bypass the default block", async (t) => {
    const h = await createHousekeepingHarness(t, { allowedTools: ["multi_tool_use.parallel"] })
    await h.enter()
    await h.guard("multi_tool_use.parallel", {
        tool_uses: [{ recipient_name: "functions.read_memo", parameters: {} }],
    })
    await assert.rejects(
        h.guard("multi_tool_use.parallel", {
            tool_uses: [
                { recipient_name: "functions.read", parameters: { filePath: "example.ts" } },
            ],
        }),
        /read|housekeeping/i,
    )
    await assert.rejects(
        h.guard("multi_tool_use.parallel", {
            tool_uses: [{ recipient_name: "functions.unknown_tool", parameters: {} }],
        }),
        /housekeeping/i,
    )
    await h.leave()
    h.assertSessionReads()
})

test("tool-name suffixes do not grant unrelated namespaced tools access", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await assert.rejects(h.guard("vendor.compress"), /housekeeping/i)
    await assert.rejects(h.guard("multi_tool_use.parallel", null), /housekeeping/i)
    await h.leave()
})

test("parallel entry and read dispatch never executes read while housekeeping is active", async (t) => {
    const h = await createHousekeepingHarness(t, { allowedTools: ["multi_tool_use.parallel"] })
    const batch = {
        tool_uses: [
            { recipient_name: "functions.enter_housekeeping", parameters: {} },
            { recipient_name: "functions.read", parameters: { filePath: "source.ts" } },
        ],
    }
    const readExecutor = t.mock.fn(async (_args: unknown) => "read executed")
    let entered = false
    const hostExecutor = t.mock.fn(async (input: typeof batch) => {
        for (const child of input.tool_uses) {
            await h.guard(child.recipient_name, child.parameters)
            if (child.recipient_name.endsWith("enter_housekeeping")) {
                await h.enter()
                entered = true
            } else {
                await readExecutor(child.parameters)
            }
        }
    })
    let dispatchError: unknown
    try {
        await h.guard("multi_tool_use.parallel", batch)
        await hostExecutor(batch)
    } catch (error) {
        dispatchError = error
    } finally {
        if (entered) await h.leave()
    }

    assert.ok(dispatchError instanceof Error)
    assert.equal(readExecutor.mock.callCount(), 0)
    if (hostExecutor.mock.callCount() === 0) {
        assert.match(dispatchError.message, /parallel|separately/i)
    } else {
        assert.equal(hostExecutor.mock.callCount(), 1)
        assert.equal(entered, true)
        assert.match(dispatchError.message, /housekeeping|blocked/i)
    }
    h.assertSessionReads()
})

test("housekeeping exceptions are recognized by the public configuration validators", () => {
    for (const allowedTools of [[], ["read"], ["bash", "custom_inspect"]]) {
        const input = { housekeeping: { allowedTools } }
        assert.deepEqual(getInvalidConfigKeys(input), [])
        assert.deepEqual(validateConfigTypes(input), [])
    }
})

for (const allowedTools of ["read", null, [1], ["read", false]]) {
    test(`configuration rejects invalid allowedTools ${JSON.stringify(allowedTools)}`, () => {
        const errors = validateConfigTypes({ housekeeping: { allowedTools } })
        assert.ok(errors.some((error) => error.key.startsWith("housekeeping.allowedTools")))
    })
}
