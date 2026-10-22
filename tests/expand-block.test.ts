import "./helpers/storage-env"
import assert from "node:assert/strict"
import test from "node:test"
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

test("expand_block requires housekeeping and leaves ordinary messages uncompressed", async (t) => {
    const h = await createHousekeepingHarness(t)
    await commitBlock(h)

    await assert.rejects(
        h.run("expand_block", { blockId: 1, endId: "m0004" }),
        /enter_housekeeping/i,
    )

    const rendered = await h.render()
    for (const id of ["source-3", "source-4"]) {
        assert.ok(rendered.some((message) => message.info.id === id))
    }
    assert.match(await contextText(h), /Parser findings\./)
    h.assertSessionReads()
})

for (const endId of ["m0003", "m0004"]) {
    test(`expand_block stages coverage through ${endId} and replaces added messages with the summary on leave`, async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)
        await h.enter()

        await h.run("expand_block", { blockId: 1, endId })

        const before = await h.render()
        for (const id of ["source-3", "source-4"]) {
            assert.ok(before.some((message) => message.info.id === id))
        }
        assert.match(
            await h.run("recall_compressed", {
                action: "search",
                blockId: 1,
                query: "Keep the newline constraint",
            }),
            /Keep the newline constraint/,
        )
        assert.match(await contextText(h), /Parser findings\./)
        await h.leave()

        const after = await h.render()
        for (const id of ["source-1", "source-2", "source-3"]) {
            assert.ok(!after.some((message) => message.info.id === id))
        }
        assert.equal(
            after.some((message) => message.info.id === "source-4"),
            endId === "m0003",
        )
        const text = await contextText(h)
        assert.match(text, /Parser findings\./)
        assert.doesNotMatch(text, /Keep the newline constraint\./)
        assert.equal(text.includes("Use the documented parser API."), endId === "m0003")
        assert.match(await h.versions(), /1 version\(s\) available/)
        h.assertSessionReads()
    })
}

test("successive expansions accumulate and commit together with an appended summary", async (t) => {
    const h = await createHousekeepingHarness(t)
    await commitBlock(h)
    await h.enter()
    await h.run("expand_block", { blockId: 1, endId: "m0003" })
    await h.run("append_summary", { blockId: 1, text: " Preserve the newline constraint." })
    await h.run("expand_block", { blockId: 1, endId: "m0004" })
    await h.run("append_summary", { blockId: 1, text: " Use the documented API." })

    const draft = await h.versions()
    assert.match(
        draft,
        /Parser findings\. Preserve the newline constraint\. Use the documented API\./,
    )
    const before = await h.render()
    assert.ok(before.some((message) => message.info.id === "source-3"))
    assert.ok(before.some((message) => message.info.id === "source-4"))
    assert.doesNotMatch(await contextText(h), /Preserve the newline constraint\./)

    await h.leave()

    const after = await h.render()
    for (const id of ["source-1", "source-2", "source-3", "source-4"]) {
        assert.ok(!after.some((message) => message.info.id === id))
    }
    assert.match(
        await contextText(h),
        /Parser findings\. Preserve the newline constraint\. Use the documented API\./,
    )
    assert.match(await h.versions(), /Active version: v2\b/)
    assert.match(await h.versions(), /2 version\(s\) available/)
    h.assertSessionReads()
})

test("a block staged in the current transaction can be expanded before leave", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await stageBlock(h)

    await h.run("expand_block", { blockId: 1, endId: "m0004" })

    const before = await h.render()
    for (const id of ["source-1", "source-2", "source-3", "source-4"]) {
        assert.ok(before.some((message) => message.info.id === id))
    }
    assert.doesNotMatch(await contextText(h), /Parser findings\./)
    await h.leave()

    const after = await h.render()
    for (const id of ["source-1", "source-2", "source-3", "source-4"]) {
        assert.ok(!after.some((message) => message.info.id === id))
    }
    assert.match(await contextText(h), /Parser findings\./)
    h.assertSessionReads()
})

test("expand retries after restart return the recorded result without duplicating coverage", async (t) => {
    const h = await createHousekeepingHarness(t)
    await commitBlock(h)
    await h.enter()
    const args = { blockId: 1, endId: "m0003" }
    const first = await h.run("expand_block", args, { callID: "expand-retry" })
    await h.restart()
    assert.equal(await h.run("expand_block", args, { callID: "expand-retry" }), first)
    await h.run("append_summary", { blockId: 1, text: " Retried expansion." })
    await h.leave()
    assert.match(await h.versions(1, 2), /Retried expansion\./)
    h.assertSessionReads()
})

for (const { name, args, error } of [
    { name: "unknown block", args: { blockId: 999, endId: "m0004" }, error: /block.*not found/i },
    {
        name: "unknown message reference",
        args: { blockId: 1, endId: "m9999" },
        error: /message|reference|boundary/i,
    },
    {
        name: "malformed reference",
        args: { blockId: 1, endId: "not-a-reference" },
        error: /reference|boundary/i,
    },
    {
        name: "block reference instead of a message",
        args: { blockId: 1, endId: "b1" },
        error: /reference|boundary/i,
    },
]) {
    test(`expand_block rejects ${name} and preserves earlier draft coverage and summary edits`, async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)
        await h.enter()
        await h.run("expand_block", { blockId: 1, endId: "m0003" })
        await h.run("append_summary", { blockId: 1, text: " Keep staged details." })
        const before = await h.versions()

        await assert.rejects(h.run("expand_block", args), error)

        assert.equal(await h.versions(), before)
        const staged = await h.render()
        assert.ok(staged.some((message) => message.info.id === "source-3"))
        assert.ok(staged.some((message) => message.info.id === "source-4"))
        await h.leave()

        const after = await h.render()
        assert.ok(!after.some((message) => message.info.id === "source-3"))
        assert.ok(after.some((message) => message.info.id === "source-4"))
        assert.match(await contextText(h), /Parser findings\. Keep staged details\./)
        assert.match(await h.versions(), /Active version: v2\b/)
        h.assertSessionReads()
    })
}

test("expand_block rejects overlap with another staged block and leaves both drafts usable", async (t) => {
    const h = await createHousekeepingHarness(t)
    await commitBlock(h)
    await h.enter()
    await h.run("expand_block", { blockId: 1, endId: "m0003" })
    await h.run("append_summary", { blockId: 1, text: " Keep staged details." })
    await stageBlock(h, "Documented API findings.", "m0004", "m0004")
    const firstBefore = await h.versions(1)
    const secondBefore = await h.versions(2)

    await assert.rejects(h.run("expand_block", { blockId: 1, endId: "m0004" }), /overlap/i)

    assert.equal(await h.versions(1), firstBefore)
    assert.equal(await h.versions(2), secondBefore)
    assert.match(
        await h.run("recall_compressed", {
            action: "search",
            blockId: 1,
            query: "Keep the newline constraint",
        }),
        /Keep the newline constraint/,
    )
    assert.match(
        await h.run("recall_compressed", {
            action: "search",
            blockId: 1,
            query: "Use the documented parser API",
        }),
        /No matches found/i,
    )
    await h.run("rewrite_summary", { blockId: 2, summary: "Retained API findings." })
    await h.leave()

    const after = await h.render()
    for (const id of ["source-1", "source-2", "source-3", "source-4"]) {
        assert.ok(!after.some((message) => message.info.id === id))
    }
    const text = await contextText(h)
    assert.match(text, /Parser findings\. Keep staged details\./)
    assert.match(text, /Retained API findings\./)
    assert.match(await h.versions(1), /Active version: v2\b/)
    assert.match(await h.versions(2), /Active version: v2\b/)
    h.assertSessionReads()
})

test("expand_block rejects overlap with a committed block without publishing prior staged edits", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await stageBlock(h)
    await stageBlock(h, "Documented API findings.", "m0004", "m0004")
    await h.leave()
    await h.enter()
    await h.run("append_summary", { blockId: 1, text: " Retained pending detail." })
    const firstBefore = await h.versions(1)
    const secondBefore = await h.versions(2)

    await assert.rejects(h.run("expand_block", { blockId: 1, endId: "m0004" }), /overlap/i)

    assert.equal(await h.versions(1), firstBefore)
    assert.equal(await h.versions(2), secondBefore)
    assert.match(
        await h.run("recall_compressed", {
            action: "search",
            blockId: 1,
            query: "Use the documented parser API",
        }),
        /No matches found/i,
    )
    assert.ok((await h.render()).some((message) => message.info.id === "source-3"))
    assert.doesNotMatch(await contextText(h), /Retained pending detail\./)
    await h.leave()

    assert.ok((await h.render()).some((message) => message.info.id === "source-3"))
    assert.match(await contextText(h), /Parser findings\. Retained pending detail\./)
    assert.match(await contextText(h), /Documented API findings\./)
    h.assertSessionReads()
})
