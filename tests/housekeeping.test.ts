import "./helpers/storage-env"
import assert from "node:assert/strict"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import test from "node:test"
import { tool } from "@opencode-ai/plugin"
import { getInvalidConfigKeys, validateConfigTypes } from "../lib/config"
import { renderMemo, type Memo } from "../lib/memo"
import { getSessionFilePath } from "../lib/paths"
import { createEditMemoTool } from "../lib/set-memo"
import type { PersistedSessionState } from "../lib/state/persistence"
import { createSessionState } from "../lib/state"
import {
    createHousekeepingHarness,
    ordinaryMessage,
    stageBlock,
    visibleText,
} from "./helpers/housekeeping"

async function readPersistedFixture(sessionID: string): Promise<PersistedSessionState> {
    return JSON.parse(
        await readFile(getSessionFilePath(sessionID), "utf-8"),
    ) as PersistedSessionState
}

async function writePersistedFixture(sessionID: string, fixture: PersistedSessionState) {
    await writeFile(getSessionFilePath(sessionID), JSON.stringify(fixture), "utf-8")
}

function replacePersistedMemoValues(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(replacePersistedMemoValues)
    if (typeof value !== "object" || value === null) return value
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
            key,
            key === "memo"
                ? entry === null
                    ? null
                    : typeof entry === "string"
                      ? entry
                      : renderMemo(entry as Memo)
                : replacePersistedMemoValues(entry),
        ]),
    )
}

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
    await h.run("edit_memo", { action: "append", content: "Keep this draft." })

    await h.guard("enter_housekeeping")
    await assert.rejects(h.enter(), /already|recursive|active/i)

    assert.equal(await h.readMemo(), "- Keep this draft.")
    await h.leave()
    assert.equal(await h.readMemo(), "- Keep this draft.")
    await h.enter()
    await h.leave()
    h.assertSessionReads()
})

test("required mode cannot be bypassed when an older config omits housekeeping settings", async (t) => {
    const h = await createHousekeepingHarness(t)
    h.config.housekeeping = undefined as never
    await assert.rejects(
        h.run("edit_memo", { action: "append", content: "Must stay committed." }),
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
    await first.run("edit_memo", { action: "append", content: "First session draft." })

    const second = await createHousekeepingHarness(t, {
        sharedState: state,
        messages: [ordinaryMessage("ses_second", "second-user", "user", "Ordinary session.")],
    })
    await second.guard("read", { filePath: "example.ts" })

    await assert.rejects(first.guard("read", { filePath: "example.ts" }), /housekeeping/i)
    assert.equal(await first.readMemo(), "- First session draft.")
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

test("leave reports an unchanged previously committed nested memo", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", {
        action: "append",
        content: { topic: "Plan", items: [{ topic: "Nested", items: ["keep"] }] },
    })
    await h.leave()

    await h.enter()
    const receipt = await h.leave()

    assert.match(receipt, /memo unchanged/i)
    const expectedMemo = "# Plan\n## Nested\n- keep"
    assert.equal(await h.readMemo(), expectedMemo)
    const memoInjections = (await h.render())
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text" && part.text.startsWith("[Memo]\n"))
        .map((part) => part.text)
    assert.deepEqual(memoInjections, [`[Memo]\n${expectedMemo}`])
    h.assertSessionReads()
})

test("leave reports an unchanged empty memo", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()

    const receipt = await h.leave()

    assert.match(receipt, /memo unchanged/i)
    assert.equal(await h.readMemo(), "(memo is empty)")
    const memoInjections = (await h.render())
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text" && part.text.startsWith("[Memo]\n"))
        .map((part) => part.text)
    assert.deepEqual(memoInjections, [])
    h.assertSessionReads()
})

test("retrying identical boundary calls is idempotent while a distinct second entry rejects", async (t) => {
    const h = await createHousekeepingHarness(t)
    const entryID = { callID: "enter-retry", messageID: "enter-retry-message" }
    const exitID = { callID: "leave-retry", messageID: "leave-retry-message" }
    const guidance = await h.run("enter_housekeeping", {}, entryID)
    assert.equal(await h.run("enter_housekeeping", {}, entryID), guidance)
    await assert.rejects(h.enter(), /already|recursive|active/i)
    await h.run("edit_memo", { action: "append", content: "Exactly once." })

    const receipt = await h.run("leave_housekeeping", {}, exitID)

    assert.equal(await h.run("leave_housekeeping", {}, exitID), receipt)
    assert.equal(await h.readMemo(), "- Exactly once.")
    await assert.rejects(h.leave(), /not.*housekeeping|enter_housekeeping|no.*active/i)
    h.assertSessionReads()
})

test("read_memo reports empty after removing the last topic and committing", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", {
        action: "append",
        content: { topic: "Temporary", items: ["memo"] },
    })
    await h.run("edit_memo", { action: "remove", path: "Temporary" })
    assert.equal(await h.readMemo(), "(memo is empty)")
    await h.leave()
    assert.equal(await h.readMemo(), "(memo is empty)")
    await h.restart()
    assert.equal(await h.readMemo(), "(memo is empty)")
    h.assertSessionReads()
})

for (const { name, legacyMemo, expected } of [
    {
        name: "plain text",
        legacyMemo: "Legacy notes\ncontinued line",
        expected: "- Legacy notes\n  continued line",
    },
    {
        name: "markdown with an empty header",
        legacyMemo: "# Setup\n- step\n## Empty",
        expected: "# Setup\n- step\n## Empty",
    },
    {
        name: "empty text",
        legacyMemo: "",
        expected: "(memo is empty)",
    },
    {
        name: "whitespace-only text",
        legacyMemo: " \n\t ",
        expected: "(memo is empty)",
    },
    { name: "null", legacyMemo: null, expected: "(memo is empty)" },
]) {
    test(`session restart migrates legacy persisted ${name} memo`, async (t) => {
        const h = await createHousekeepingHarness(t)
        const persisted = await readPersistedFixture(h.sessionID)
        persisted.memo = legacyMemo
        await writePersistedFixture(h.sessionID, persisted)

        await h.restart()

        assert.equal(await h.readMemo(), expected)
        h.assertSessionReads()
    })
}

test("session restart migrates legacy memos in open and completed transaction snapshots", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", {
        action: "append",
        content: { topic: "Plan", items: ["committed"] },
    })
    await h.leave()

    await h.enter()
    await h.run("edit_memo", {
        action: "append",
        content: { topic: "Draft", items: ["staged"] },
    })
    const openFixture = await readPersistedFixture(h.sessionID)
    await writePersistedFixture(
        h.sessionID,
        replacePersistedMemoValues(openFixture) as PersistedSessionState,
    )
    await h.restart()

    const draftView = "# Plan\n- committed\n# Draft\n- staged"
    assert.equal(await h.readMemo(), draftView)
    const openMemoInjections = (await h.render())
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text" && part.text.startsWith("[Memo]\n"))
        .map((part) => part.text)
    assert.deepEqual(openMemoInjections, ["[Memo]\n# Plan\n- committed"])
    await assert.rejects(h.enter(), /already|recursive|active/i)
    await h.leave()

    const completed = structuredClone(h.history)
    const completedFixture = await readPersistedFixture(h.sessionID)
    await writePersistedFixture(
        h.sessionID,
        replacePersistedMemoValues(completedFixture) as PersistedSessionState,
    )
    await h.restart()
    assert.equal(await h.readMemo(), draftView)
    const completedMemoInjections = (await h.render())
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text" && part.text.startsWith("[Memo]\n"))
        .map((part) => part.text)
    assert.deepEqual(completedMemoInjections, [`[Memo]\n${draftView}`])

    const latestLeaveCallID = completed
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool" && part.tool === "leave_housekeeping")
        .at(-1)?.callID
    assert.ok(latestLeaveCallID)
    h.setHistory(
        completed.map((message) => ({
            ...message,
            parts: message.parts.filter(
                (part) => part.type !== "tool" || part.callID !== latestLeaveCallID,
            ),
        })),
    )
    await h.render()
    assert.equal(await h.readMemo(), draftView)
    await assert.rejects(h.enter(), /already|recursive|active/i)

    h.setHistory(completed)
    await h.render()
    assert.equal(await h.readMemo(), draftView)
    const restoredMemoInjections = (await h.render())
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text" && part.text.startsWith("[Memo]\n"))
        .map((part) => part.text)
    assert.deepEqual(restoredMemoInjections, [`[Memo]\n${draftView}`])
    h.assertSessionReads()
})

test("injected memo preserves nested sections and unindented bullets", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", {
        action: "append",
        content: {
            topic: "Plan",
            items: ["first", { topic: "Nested", items: ["child"] }, "last"],
        },
    })
    await h.leave()

    const memoInjections = (await h.render())
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text" && part.text.startsWith("[Memo]\n"))
        .map((part) => part.text)
    assert.deepEqual(memoInjections, ["[Memo]\n# Plan\n- first\n- last\n## Nested\n- child"])
    h.assertSessionReads()
})

test("edit_memo requires entry even for an otherwise valid empty-memo insertion", async (t) => {
    const h = await createHousekeepingHarness(t)
    await assert.rejects(
        h.run("edit_memo", { action: "append", content: "Do not publish." }),
        /enter_housekeeping/i,
    )
    assert.equal(await h.readMemo(), "(memo is empty)")
})

test("edit_memo public input schema accepts six topic levels and rejects seven", async (t) => {
    const h = await createHousekeepingHarness(t)
    const editMemo = createEditMemoTool(h.ctx)
    const schema = tool.schema.object(editMemo.args)
    const sixTopics = {
        topic: "Level 1",
        items: [
            {
                topic: "Level 2",
                items: [
                    {
                        topic: "Level 3",
                        items: [
                            {
                                topic: "Level 4",
                                items: [
                                    {
                                        topic: "Level 5",
                                        items: [{ topic: "Level 6", items: ["leaf string"] }],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        ],
    }
    const validArgs = { action: "append", content: sixTopics }
    assert.deepEqual(schema.parse(validArgs), validArgs)
    assert.deepEqual(schema.parse({ action: "append", content: "root string" }), {
        action: "append",
        content: "root string",
    })
    assert.deepEqual(
        schema.parse({
            action: "append",
            content: { topic: "Shallow", items: ["topic string"] },
        }),
        {
            action: "append",
            content: { topic: "Shallow", items: ["topic string"] },
        },
    )
    const sevenTopics = {
        ...sixTopics,
        items: [
            {
                topic: "Level 2",
                items: [
                    {
                        topic: "Level 3",
                        items: [
                            {
                                topic: "Level 4",
                                items: [
                                    {
                                        topic: "Level 5",
                                        items: [
                                            {
                                                topic: "Level 6",
                                                items: [{ topic: "Level 7", items: [] }],
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        ],
    }
    assert.throws(() => schema.parse({ action: "append", content: sevenTopics }))
})

for (const content of ["beta", { topic: "Plan", items: ["beta"] }]) {
    test(`memo append accumulates structured content ${JSON.stringify(content)}`, async (t) => {
        const h = await createHousekeepingHarness(t)
        await h.enter()
        await h.run("edit_memo", { action: "append", content: "alpha" })
        await h.run("edit_memo", { action: "append", content })
        const expected = typeof content === "string" ? "- alpha\n- beta" : "- alpha\n# Plan\n- beta"
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
        name: "a missing topic path",
        args: { action: "remove", path: "Missing" },
        error: /not found/i,
    },
    {
        name: "a string removal without its delimiter",
        args: { action: "remove", path: "Draft" },
        error: /not found|delimiter/i,
    },
]) {
    test(`edit_memo rejects ${name} without losing earlier accumulated edits`, async (t) => {
        const h = await createHousekeepingHarness(t)
        await h.enter()
        await h.run("edit_memo", { action: "append", content: "Draft memo." })
        await assert.rejects(h.run("edit_memo", args), error)
        assert.equal(await h.readMemo(), "- Draft memo.")
        await h.run("edit_memo", { action: "append", content: "Repaired memo." })
        await h.leave()
        assert.equal(await h.readMemo(), "- Draft memo.\n- Repaired memo.")
        h.assertSessionReads()
    })
}

test("draft memo inspection does not publish the memo to ordinary model context", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await stageBlock(h)
    await h.run("edit_memo", { action: "append", content: "Committed parser memo." })
    await h.leave()
    await h.enter()
    await h.run("edit_memo", { action: "append", content: "Staged parser memo." })
    assert.equal(await h.readMemo(), "- Committed parser memo.\n- Staged parser memo.")
    const ordinaryText = (await h.render())
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
    assert.match(ordinaryText, /Committed parser memo\./)
    assert.doesNotMatch(ordinaryText, /Staged parser memo\./)

    await h.leave()
    await h.restart()
    assert.equal(await h.readMemo(), "- Committed parser memo.\n- Staged parser memo.")
    h.assertSessionReads()
})

test("restart restores an open transaction's draft and tool restrictions until leave", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await stageBlock(h, "Recovered parser summary.")
    await h.run("edit_memo", {
        action: "append",
        content: { topic: "Recovered", items: ["draft memo"] },
    })
    await h.restart()

    assert.equal(await h.readMemo(), "# Recovered\n- draft memo")
    assert.match(await h.versions(1, 1), /Recovered parser summary\./)
    await assert.rejects(h.guard("bash"), /housekeeping/i)
    await assert.rejects(h.enter(), /already|recursive|active/i)
    assert.match(visibleText(await h.render()), /Investigate the parser boundary\./)
    await h.leave()
    await h.restart()
    assert.equal(await h.readMemo(), "# Recovered\n- draft memo")
    assert.doesNotMatch(visibleText(await h.render()), /Investigate the parser boundary\./)
    await h.guard("bash")
    h.assertSessionReads()
})

test("leave applies compression and memo together and reopening after revert undoes both", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await stageBlock(h, "Transaction summary.")
    await h.run("edit_memo", {
        action: "append",
        content: { topic: "Transaction", items: ["memo"] },
    })
    const beforeLeave = structuredClone(h.history)
    await h.leave()
    const committed = structuredClone(h.history)
    assert.doesNotMatch(visibleText(await h.render()), /Investigate the parser boundary\./)
    assert.equal(await h.readMemo(), "# Transaction\n- memo")

    h.setHistory(beforeLeave)
    await h.render()
    await h.restart()
    assert.equal(await h.readMemo(), "# Transaction\n- memo")
    assert.match(visibleText(await h.render()), /Investigate the parser boundary\./)
    await assert.rejects(h.guard("read"), /housekeeping/i)

    h.setHistory(committed)
    await h.render()
    assert.doesNotMatch(visibleText(await h.render()), /Investigate the parser boundary\./)
    assert.equal(await h.readMemo(), "# Transaction\n- memo")
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
    await h.run("edit_memo", { action: "append", content: "Single transaction." })
    await h.leave()
    assert.equal(await h.readMemo(), "- Single transaction.")
    h.assertSessionReads()
})

test("leave rejects an invalid summary without publishing an otherwise valid memo edit", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await stageBlock(h, "Committed parser summary.")
    await h.run("edit_memo", { action: "append", content: "Committed parser memo." })
    await h.leave()
    await h.enter()
    await h.run("edit_memo", { action: "append", content: "Staged parser memo." })
    await h.run("edit_summary", {
        blockId: 1,
        oldString: "Committed parser summary.",
        newString: "",
    })
    await assert.rejects(h.leave(), /empty|non-empty|blank/i)
    await h.restart()
    assert.equal(await h.readMemo(), "- Committed parser memo.\n- Staged parser memo.")
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
    assert.equal(await h.readMemo(), "- Committed parser memo.\n- Staged parser memo.")
    assert.match(await h.versions(1, 2), /Repaired parser summary\./)
    h.assertSessionReads()
})

test("leave persistence failure keeps all effects staged and permits a durable retry", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await stageBlock(h, "Durable parser summary.")
    await h.run("edit_memo", { action: "append", content: "Durable parser memo." })
    const file = getSessionFilePath(h.sessionID)
    const backup = `${file}.test-backup`
    await rename(file, backup)
    await mkdir(file)
    try {
        await assert.rejects(h.leave(), /persist|write|directory|EISDIR|EEXIST|rename/i)
        assert.equal(await h.readMemo(), "- Durable parser memo.")
        assert.match(visibleText(await h.render()), /Investigate the parser boundary\./)
        await assert.rejects(h.guard("read"), /housekeeping/i)
    } finally {
        await rm(file, { recursive: true, force: true })
        await rename(backup, file)
    }
    await h.leave()
    await h.restart()
    assert.equal(await h.readMemo(), "- Durable parser memo.")
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
                { action: "append", content: "Uncommitted draft." },
                { callID: "memo-retry" },
            ),
            /persist|write|directory|EISDIR|EEXIST|rename/i,
        )
        assert.equal(await h.readMemo(), "(memo is empty)")
    } finally {
        await rm(file, { recursive: true, force: true })
        await rename(backup, file)
    }
    const firstResult = await h.run(
        "edit_memo",
        { action: "append", content: "Durable draft." },
        { callID: "memo-retry" },
    )
    const retryResult = await h.run(
        "edit_memo",
        { action: "append", content: "Durable draft." },
        { callID: "memo-retry" },
    )
    assert.ok(firstResult.length > 0)
    assert.equal(retryResult, firstResult)
    assert.equal(await h.readMemo(), "- Durable draft.")
    await h.leave()
})

test("edit_memo appends into a selected topic, inserts after a sibling, removes by prefix, and clears in place", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { action: "append", content: { topic: "Plan", items: ["first"] } })
    await h.run("edit_memo", {
        action: "append",
        parent: "Plan",
        content: { topic: "Details", items: [] },
    })
    await h.run("edit_memo", {
        action: "append",
        parent: "Plan/Details",
        content: "temporary",
    })
    const relocated = await h.run("edit_memo", {
        action: "append",
        parent: "Plan",
        after: "Plan/Details",
        content: "relocated string",
    })
    assert.match(relocated, /relocat|string portion/i)
    await h.run("edit_memo", {
        action: "append",
        parent: "Plan",
        after: "Plan/Details",
        content: { topic: "Follow-up", items: ["later"] },
    })
    await h.run("edit_memo", {
        action: "remove",
        path: "Plan//fir",
    })

    assert.equal(
        await h.readMemo(),
        "# Plan\n- relocated string\n## Details\n- temporary\n## Follow-up\n- later",
    )

    await h.run("edit_memo", { action: "clear", path: "Plan/Details" })
    assert.equal(
        await h.readMemo(),
        "# Plan\n- relocated string\n## Details\n## Follow-up\n- later",
    )
    await h.run("edit_memo", { action: "clear", path: "Plan/Follow-up" })
    assert.equal(await h.readMemo(), "# Plan\n- relocated string\n## Details\n## Follow-up")
    await h.leave()
    assert.equal(await h.readMemo(), "# Plan\n- relocated string\n## Details\n## Follow-up")
})

test("edit_memo normalizes recursively misordered supplied sections with a visible warning", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    const result = await h.run("edit_memo", {
        action: "append",
        content: {
            topic: "Outer",
            items: [{ topic: "Inner", items: ["child"] }, "late string"],
        },
    })

    assert.match(result, /normaliz|order/i)
    assert.equal(await h.readMemo(), "# Outer\n- late string\n## Inner\n- child")
    await h.leave()
})

test("invalid memo actions reject without corrupting the draft", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { action: "append", content: "Keep me." })
    await h.run("edit_memo", { action: "append", content: "Keep more." })
    await h.run("edit_memo", {
        action: "append",
        content: { topic: "Plan", items: [{ topic: "Existing", items: [] }] },
    })
    let tooDeep: unknown = { topic: "Level 7", items: [] }
    for (let level = 6; level >= 1; level--) {
        tooDeep = { topic: `Level ${level}`, items: [tooDeep] }
    }

    for (const args of [
        {},
        { oldString: "", newString: "Unsupported legacy call." },
        { action: "clear" },
        { action: "remove", path: "Missing" },
        { action: "clear", path: "Missing" },
        { action: "remove", path: "//Keep" },
        { action: "append", content: "Keep me." },
        { action: "append", content: { topic: "Bad/Topic", items: [] } },
        { action: "append", content: { topic: "Plan", items: [] } },
        { action: "append", content: "misordered", parent: "Absent" },
        {
            action: "append",
            parent: "Plan",
            after: "Plan/Absent",
            content: { topic: "Missing sibling", items: [] },
        },
        {
            action: "append",
            parent: "Plan",
            after: "Plan",
            content: { topic: "Wrong parent", items: [] },
        },
        { action: "append", content: tooDeep },
    ]) {
        await assert.rejects(h.run("edit_memo", args))
        assert.equal(await h.readMemo(), "- Keep me.\n- Keep more.\n# Plan\n## Existing")
    }

    await h.leave()
})

test("leave and a concurrent mutation serialize without losing or leaking the mutation", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    const results = await Promise.allSettled([
        h.leave(),
        h.run(
            "edit_memo",
            { action: "append", content: "Serialized draft." },
            { callID: "concurrent-memo" },
        ),
    ])
    assert.equal(results[0].status, "fulfilled")
    const memoResult = results[1]
    let expectedMemo: string
    if (memoResult.status === "fulfilled") {
        expectedMemo = "- Serialized draft."
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
