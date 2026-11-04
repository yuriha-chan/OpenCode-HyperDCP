import "./helpers/storage-env"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import fsPromises, { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { join } from "node:path"
import test from "node:test"
import { gzipSync } from "node:zlib"
import { tool } from "@opencode-ai/plugin"
import { getConfig, getInvalidConfigKeys, validateConfigTypes } from "../lib/config"
import { STORAGE_DIR, getSessionFilePath } from "../lib/paths"
import { resolveProtectedTool } from "../lib/protected-tools"
import { createEditMemoTool } from "../lib/set-memo"
import { saveSessionStateStrict, type PersistedSessionState } from "../lib/state/persistence"
import { readHousekeepingDraft } from "../lib/state/housekeeping-draft-store"
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
    await h.run("edit_memo", { action: "append", textItems: ["Keep this draft."] })

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
        h.run("edit_memo", { action: "append", textItems: ["Must stay committed."] }),
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
    await first.run("edit_memo", { action: "append", textItems: ["First session draft."] })

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

test("leave reports an unchanged previously committed nested memo", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", {
        action: "append",
        topics: [{ topicTitle: "Plan", topics: [{ topicTitle: "Nested", textItems: ["keep"] }] }],
    })
    await h.leave()

    await h.enter()
    const receipt = await h.leave()

    assert.match(receipt, /memo unchanged/i)
    const expectedMemo = "# Plan\n## Nested\nkeep"
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
    h.todo.mock.mockImplementation(async () => ({ data: [{ id: "todo-entry" }] }))
    const entryID = { callID: "enter-retry", messageID: "enter-retry-message" }
    const exitID = { callID: "leave-retry", messageID: "leave-retry-message" }
    const guidance = await h.run("enter_housekeeping", {}, entryID)
    assert.equal(await h.run("enter_housekeeping", {}, entryID), guidance)
    await assert.rejects(h.enter(), /already|recursive|active/i)
    await h.run("edit_memo", { action: "append", textItems: ["Exactly once."] })

    const receipt = await h.run("leave_housekeeping", {}, exitID)

    assert.equal(await h.run("leave_housekeeping", {}, exitID), receipt)
    assert.equal(await h.run("enter_housekeeping", {}, entryID), guidance)
    assert.equal(await h.readMemo(), 'Exactly once.\n# Todo status\n[{"id":"todo-entry"}]')
    assert.equal(h.todo.mock.callCount(), 1)
    assert.deepEqual(h.todo.mock.calls[0].arguments[0], { path: { id: h.sessionID } })
    await assert.rejects(h.leave(), /not.*housekeeping|enter_housekeeping|no.*active/i)
    h.assertSessionReads()
})

test("entry stores the complete todo response as one topic item for a null memo", async (t) => {
    const h = await createHousekeepingHarness(t)
    const todos = [
        {
            id: "todo-001",
            content: "Review the deployment checklist",
            status: "pending",
            priority: "high",
            metadata: { owner: "alex", labels: ["release", "ops"], estimate: 3 },
        },
        {
            id: "todo-001",
            content: "Review the deployment checklist",
            status: "pending",
            priority: "high",
            metadata: { owner: "alex", labels: ["release", "ops"], estimate: 3 },
        },
        {
            id: "todo-002",
            content: "Update the API documentation",
            status: "in_progress",
            priority: "medium",
            metadata: { owner: "sam", startedAt: "2025-01-15T09:30:00Z" },
        },
        {
            id: "todo-003",
            content: "Add request validation",
            status: "completed",
            priority: "low",
            metadata: { owner: "lee", completedAt: "2025-01-14T16:45:00Z" },
        },
        {
            id: "todo-004",
            content: "Retire the legacy webhook",
            status: "cancelled",
            priority: "medium",
            metadata: { owner: "alex", cancellationReason: "replaced by event stream" },
        },
    ]
    h.todo.mock.mockImplementationOnce(async () => ({ data: todos }))

    await h.enter()

    const todoItem = JSON.stringify(todos)
    assert.equal(await h.readMemo(), `# Todo status\n${todoItem}`)
    assert.deepEqual(h.todo.mock.calls[0].arguments[0], { path: { id: h.sessionID } })
    await h.leave()
    assert.equal(await h.readMemo(), `# Todo status\n${todoItem}`)
    await h.restart()
    assert.equal(await h.readMemo(), `# Todo status\n${todoItem}`)
})

test("entry replaces the positioned todo topic and its nested notes only in the draft", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", {
        action: "append",
        topics: [{ topicTitle: "Before", textItems: ["keep before"] }],
    })
    await h.run("edit_memo", {
        action: "append",
        topics: [
            {
                topicTitle: "Todo status",
                textItems: ["old todo"],
                topics: [{ topicTitle: "Old notes", textItems: ["remove this"] }],
            },
        ],
    })
    await h.run("edit_memo", {
        action: "append",
        topics: [{ topicTitle: "After", textItems: ["keep after"] }],
    })
    await h.leave()
    h.todo.mock.mockImplementationOnce(async () => ({ data: [{ id: "fresh", status: "pending" }] }))

    await h.enter()

    const expected =
        '# Before\nkeep before\n# Todo status\n[{"id":"fresh","status":"pending"}]\n# After\nkeep after'
    assert.equal(await h.readMemo(), expected)
    const injected = (await h.render())
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text" && part.text.startsWith("[Memo]\n"))
        .map((part) => part.text)
    assert.deepEqual(injected, [
        "[Memo]\n# Before\nkeep before\n# Todo status\nold todo\n## Old notes\nremove this\n# After\nkeep after",
    ])
    await h.leave()
    assert.equal(await h.readMemo(), expected)
    await h.restart()
    assert.equal(await h.readMemo(), expected)
})

test("an empty todo response clears the existing topic while retaining its position", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", {
        action: "append",
        topics: [{ topicTitle: "Before", textItems: ["keep"] }],
    })
    await h.run("edit_memo", {
        action: "append",
        topics: [{ topicTitle: "Todo status", textItems: ["old"] }],
    })
    await h.run("edit_memo", {
        action: "append",
        topics: [{ topicTitle: "After", textItems: ["keep"] }],
    })
    await h.leave()
    h.todo.mock.mockImplementationOnce(async () => ({ data: [] }))

    await h.enter()

    assert.equal(await h.readMemo(), "# Before\nkeep\n# Todo status\n# After\nkeep")
    await h.leave()
    await h.restart()
    assert.equal(await h.readMemo(), "# Before\nkeep\n# Todo status\n# After\nkeep")
})

test("public entry with empty todo data retains an empty topic for a null memo", async (t) => {
    const h = await createHousekeepingHarness(t)
    h.todo.mock.mockImplementationOnce(async () => ({ data: [] }))

    await h.run("enter_housekeeping")

    assert.equal(await h.readMemo(), "# Todo status")
    await h.run("leave_housekeeping")
    await h.restart()
    assert.equal(await h.readMemo(), "# Todo status")
})

for (const { name, configure } of [
    {
        name: "a rejected todo request",
        configure: (h: Awaited<ReturnType<typeof createHousekeepingHarness>>) =>
            h.todo.mock.mockImplementationOnce(async () => {
                throw new Error("todo request failed")
            }),
    },
    {
        name: "a todo API error response",
        configure: (h: Awaited<ReturnType<typeof createHousekeepingHarness>>) =>
            h.todo.mock.mockImplementationOnce(async () => ({
                error: new Error("todo API failed"),
            })),
    },
    {
        name: "a todo response without data",
        configure: (h: Awaited<ReturnType<typeof createHousekeepingHarness>>) =>
            h.todo.mock.mockImplementationOnce(async () => ({ data: undefined })),
    },
]) {
    test(`failed ${name} leaves the memo untouched and permits entry`, async (t) => {
        const h = await createHousekeepingHarness(t)
        await h.enter()
        await h.run("edit_memo", { action: "append", textItems: ["Existing memo."] })
        await h.leave()
        configure(h)

        await h.enter()

        assert.equal(await h.readMemo(), "Existing memo.")
        assert.equal(h.todo.mock.callCount(), 2)
        await h.leave()
        await h.restart()
        assert.equal(await h.readMemo(), "Existing memo.")
    })
}

test("read_memo reports empty after removing the last topic and committing", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", {
        action: "append",
        topics: [{ topicTitle: "Temporary", textItems: ["memo"] }],
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
        expected: "Legacy notes\ncontinued line",
    },
    {
        name: "markdown with an empty header",
        legacyMemo: "# Setup\n- step\n## Empty",
        expected: "# Setup\nstep\n## Empty",
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

test("session restart reloads referenced open and completed snapshots for revert and restore", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", {
        action: "append",
        topics: [{ topicTitle: "Plan", textItems: ["committed"] }],
    })
    await h.leave()

    await h.enter()
    await h.run("edit_memo", {
        action: "append",
        topics: [{ topicTitle: "Draft", textItems: ["staged"] }],
    })
    await h.restart()

    const draftView = "# Plan\ncommitted\n# Draft\nstaged"
    assert.equal(await h.readMemo(), draftView)
    const openMemoInjections = (await h.render())
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text" && part.text.startsWith("[Memo]\n"))
        .map((part) => part.text)
    assert.deepEqual(openMemoInjections, ["[Memo]\n# Plan\ncommitted"])
    await assert.rejects(h.enter(), /already|recursive|active/i)
    await h.leave()

    const completed = structuredClone(h.history)
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

test("injected memo preserves nested sections and plain text items", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", {
        action: "append",
        topics: [
            {
                topicTitle: "Plan",
                textItems: ["first", "last"],
                topics: [{ topicTitle: "Nested", textItems: ["child"] }],
            },
        ],
    })
    await h.leave()

    const memoInjections = (await h.render())
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text" && part.text.startsWith("[Memo]\n"))
        .map((part) => part.text)
    assert.deepEqual(memoInjections, ["[Memo]\n# Plan\nfirst\nlast\n## Nested\nchild"])
    h.assertSessionReads()
})

test("edit_memo requires entry even for an otherwise valid empty-memo insertion", async (t) => {
    const h = await createHousekeepingHarness(t)
    await assert.rejects(
        h.run("edit_memo", { action: "append", textItems: ["Do not publish."] }),
        /enter_housekeeping/i,
    )
    assert.equal(await h.readMemo(), "(memo is empty)")
})

test("edit_memo public input schema accepts six topic levels, sixth-level strings, and root text arrays", async (t) => {
    const h = await createHousekeepingHarness(t)
    const editMemo = createEditMemoTool(h.ctx)
    const schema = tool.schema.object(editMemo.args)
    const nestedTopics = (
        depth: number,
        leafTextItems: string[],
    ): Array<Record<string, unknown>> => {
        let topics: Array<Record<string, unknown>> = [
            { topicTitle: `Level ${depth}`, textItems: leafTextItems },
        ]
        for (let level = depth - 1; level >= 1; level -= 1) {
            topics = [{ topicTitle: `Level ${level}`, topics }]
        }
        return topics
    }
    const sixTopics = {
        action: "append",
        textItems: ["root one", "root two"],
        topics: nestedTopics(6, ["leaf string"]),
    }
    assert.deepEqual(schema.parse(sixTopics), sixTopics)
    assert.deepEqual(schema.parse({ action: "append", textItems: ["root string"] }), {
        action: "append",
        textItems: ["root string"],
    })
    assert.deepEqual(
        schema.parse({
            action: "append",
            topics: [{ topicTitle: "Shallow", textItems: ["topic string"] }],
        }),
        {
            action: "append",
            topics: [{ topicTitle: "Shallow", textItems: ["topic string"] }],
        },
    )
    assert.throws(() => schema.parse({ action: "append", topics: nestedTopics(7, ["too deep"]) }))
    const wrongShapes: unknown[] = [
        { action: "append", textItems: "not an array" },
        { action: "append", textItems: [1] },
        { action: "append", textItems: ["ok"], topics: "not an array" },
        { action: "append", topics: [{ topicTitle: "Plan", textItems: "not an array" }] },
        { action: "append", topics: ['{"topicTitle":"Plan"}'] },
        { action: "append", topics: [{ textItems: ["missing title"] }] },
        { action: "append", topics: [{ topicTitle: 7 }] },
        {
            action: "append",
            topics: [{ topicTitle: "Plan", topics: ['{"topicTitle":"Nested"}'] }],
        },
    ]
    for (const wrong of wrongShapes) assert.throws(() => schema.parse(wrong))
})

for (const { name, edit, expected } of [
    {
        name: "text items",
        edit: { action: "append", textItems: ["beta"] },
        expected: "alpha\nbeta",
    },
    {
        name: "topics",
        edit: { action: "append", topics: [{ topicTitle: "Plan", textItems: ["beta"] }] },
        expected: "alpha\n# Plan\nbeta",
    },
]) {
    test(`memo append accumulates ${name}`, async (t) => {
        const h = await createHousekeepingHarness(t)
        await h.enter()
        await h.run("edit_memo", { action: "append", textItems: ["alpha"] })
        await h.run("edit_memo", edit)
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
        await h.run("edit_memo", { action: "append", textItems: ["Draft memo."] })
        await assert.rejects(h.run("edit_memo", args), error)
        assert.equal(await h.readMemo(), "Draft memo.")
        await h.run("edit_memo", { action: "append", textItems: ["Repaired memo."] })
        await h.leave()
        assert.equal(await h.readMemo(), "Draft memo.\nRepaired memo.")
        h.assertSessionReads()
    })
}

test("draft memo inspection does not publish the memo to ordinary model context", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await stageBlock(h)
    await h.run("edit_memo", { action: "append", textItems: ["Committed parser memo."] })
    await h.leave()
    await h.enter()
    await h.run("edit_memo", { action: "append", textItems: ["Staged parser memo."] })
    assert.equal(await h.readMemo(), "Committed parser memo.\nStaged parser memo.")
    const ordinaryText = (await h.render())
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
    assert.match(ordinaryText, /Committed parser memo\./)
    assert.doesNotMatch(ordinaryText, /Staged parser memo\./)

    await h.leave()
    await h.restart()
    assert.equal(await h.readMemo(), "Committed parser memo.\nStaged parser memo.")
    h.assertSessionReads()
})

test("restart restores an open transaction's draft and tool restrictions until leave", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await stageBlock(h, "Recovered parser summary.")
    await h.run("edit_memo", {
        action: "append",
        topics: [{ topicTitle: "Recovered", textItems: ["draft memo"] }],
    })
    await h.restart()

    assert.equal(await h.readMemo(), "# Recovered\ndraft memo")
    assert.match(await h.versions(1, 1), /Recovered parser summary\./)
    await assert.rejects(h.guard("bash"), /housekeeping/i)
    await assert.rejects(h.enter(), /already|recursive|active/i)
    assert.match(visibleText(await h.render()), /Investigate the parser boundary\./)
    await h.leave()
    await h.restart()
    assert.equal(await h.readMemo(), "# Recovered\ndraft memo")
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
        topics: [{ topicTitle: "Transaction", textItems: ["memo"] }],
    })
    const beforeLeave = structuredClone(h.history)
    await h.leave()
    const committed = structuredClone(h.history)
    assert.doesNotMatch(visibleText(await h.render()), /Investigate the parser boundary\./)
    assert.equal(await h.readMemo(), "# Transaction\nmemo")

    h.setHistory(beforeLeave)
    await h.render()
    await h.restart()
    assert.equal(await h.readMemo(), "# Transaction\nmemo")
    assert.match(visibleText(await h.render()), /Investigate the parser boundary\./)
    await assert.rejects(h.guard("read"), /housekeeping/i)

    h.setHistory(committed)
    await h.render()
    assert.doesNotMatch(visibleText(await h.render()), /Investigate the parser boundary\./)
    assert.equal(await h.readMemo(), "# Transaction\nmemo")
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
    await h.run("edit_memo", { action: "append", textItems: ["Single transaction."] })
    await h.leave()
    assert.equal(await h.readMemo(), "Single transaction.")
    h.assertSessionReads()
})

test("leave rejects an invalid summary without publishing an otherwise valid memo edit", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await stageBlock(h, "Committed parser summary.")
    await h.run("edit_memo", { action: "append", textItems: ["Committed parser memo."] })
    await h.leave()
    await h.enter()
    await h.run("edit_memo", { action: "append", textItems: ["Staged parser memo."] })
    await h.run("edit_summary", {
        blockId: 1,
        oldString: "Committed parser summary.",
        newString: "",
    })
    await assert.rejects(h.leave(), /empty|non-empty|blank/i)
    await h.restart()
    assert.equal(await h.readMemo(), "Committed parser memo.\nStaged parser memo.")
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
    assert.equal(await h.readMemo(), "Committed parser memo.\nStaged parser memo.")
    assert.match(await h.versions(1, 2), /Repaired parser summary\./)
    h.assertSessionReads()
})

test("leave persistence failure keeps all effects staged and permits a durable retry", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await stageBlock(h, "Durable parser summary.")
    await h.run("edit_memo", { action: "append", textItems: ["Durable parser memo."] })
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
                { action: "append", textItems: ["Uncommitted draft."] },
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
        { action: "append", textItems: ["Durable draft."] },
        { callID: "memo-retry" },
    )
    const retryResult = await h.run(
        "edit_memo",
        { action: "append", textItems: ["Durable draft."] },
        { callID: "memo-retry" },
    )
    assert.ok(firstResult.length > 0)
    assert.equal(retryResult, firstResult)
    assert.equal(await h.readMemo(), "Durable draft.")
    await h.leave()
})

test("edit_memo appends into a selected topic, inserts after a sibling, removes by prefix, and clears in place", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", {
        action: "append",
        topics: [{ topicTitle: "Plan", textItems: ["first"] }],
    })
    await h.run("edit_memo", {
        action: "append",
        parent: "Plan",
        topics: [{ topicTitle: "Details" }],
    })
    await h.run("edit_memo", {
        action: "append",
        parent: "Plan/Details",
        textItems: ["temporary"],
    })
    const relocated = await h.run("edit_memo", {
        action: "append",
        parent: "Plan",
        after: "Plan/Details",
        textItems: ["relocated string"],
    })
    assert.match(relocated, /relocat|string portion/i)
    await h.run("edit_memo", {
        action: "append",
        parent: "Plan",
        after: "Plan/Details",
        topics: [{ topicTitle: "Follow-up", textItems: ["later"] }],
    })
    await h.run("edit_memo", {
        action: "remove",
        path: "Plan//fir",
    })

    assert.equal(
        await h.readMemo(),
        "# Plan\nrelocated string\n## Details\ntemporary\n## Follow-up\nlater",
    )

    await h.run("edit_memo", { action: "clear", path: "Plan/Details" })
    assert.equal(await h.readMemo(), "# Plan\nrelocated string\n## Details\n## Follow-up\nlater")
    await h.run("edit_memo", { action: "clear", path: "Plan/Follow-up" })
    assert.equal(await h.readMemo(), "# Plan\nrelocated string\n## Details\n## Follow-up")
    await h.leave()
    assert.equal(await h.readMemo(), "# Plan\nrelocated string\n## Details\n## Follow-up")
})

test("edit_memo renders separated text items before topics without normalization warnings", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    const result = await h.run("edit_memo", {
        action: "append",
        topics: [
            {
                topicTitle: "Outer",
                textItems: ["first", "second"],
                topics: [{ topicTitle: "Inner", textItems: ["child"] }],
            },
        ],
    })

    assert.doesNotMatch(result, /normaliz|order/i)
    assert.equal(await h.readMemo(), "# Outer\nfirst\nsecond\n## Inner\nchild")
    await h.leave()
})

test("invalid memo actions reject without corrupting the draft", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { action: "append", textItems: ["Keep me."] })
    await h.run("edit_memo", { action: "append", textItems: ["Keep more."] })
    await h.run("edit_memo", {
        action: "append",
        topics: [{ topicTitle: "Plan", topics: [{ topicTitle: "Existing" }] }],
    })
    let tooDeep: unknown = { topicTitle: "Level 7" }
    for (let level = 6; level >= 1; level--) {
        tooDeep = { topicTitle: `Level ${level}`, topics: [tooDeep] }
    }

    for (const args of [
        {},
        { oldString: "", newString: "Unsupported legacy call." },
        { action: "clear" },
        { action: "remove", path: "Missing" },
        { action: "clear", path: "Missing" },
        { action: "remove", path: "//Keep" },
        { action: "append", textItems: ["Keep me."] },
        { action: "append", topics: [{ topicTitle: "Bad/Topic" }] },
        { action: "append", topics: [{ topicTitle: "Plan" }] },
        { action: "append", textItems: ["misordered"], parent: "Absent" },
        {
            action: "append",
            parent: "Plan",
            after: "Plan/Absent",
            topics: [{ topicTitle: "Missing sibling" }],
        },
        {
            action: "append",
            parent: "Plan",
            after: "Plan",
            topics: [{ topicTitle: "Wrong parent" }],
        },
        { action: "append", topics: [tooDeep] },
    ]) {
        await assert.rejects(h.run("edit_memo", args))
        assert.equal(await h.readMemo(), "Keep me.\nKeep more.\n# Plan\n## Existing")
    }

    await h.leave()
})

test("edit_memo appends multiple text items and topics at the root and beneath a parent", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", {
        action: "append",
        textItems: ["First", "Second"],
        topics: [{ topicTitle: "Verification", textItems: ["Run tests"], topics: [] }],
    })
    assert.equal(await h.readMemo(), "First\nSecond\n# Verification\nRun tests")
    await h.run("edit_memo", {
        action: "append",
        topics: [
            {
                topicTitle: "Plan",
                textItems: ["base"],
                topics: [{ topicTitle: "Existing" }],
            },
        ],
    })
    await h.run("edit_memo", {
        action: "append",
        parent: "Plan",
        textItems: ["Added one", "Added two"],
        topics: [
            { topicTitle: "Details", textItems: ["detail"] },
            { topicTitle: "Follow-up", textItems: ["later"] },
        ],
    })
    assert.equal(
        await h.readMemo(),
        "First\nSecond\n# Verification\nRun tests\n# Plan\nbase\nAdded one\nAdded two\n## Existing\n## Details\ndetail\n## Follow-up\nlater",
    )
    await h.leave()
})

test("edit_memo splits multiline text items at root and within nested topics", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", {
        action: "append",
        textItems: ["root one\nroot two\r\nroot three\rroot four"],
        topics: [
            {
                topicTitle: "Plan",
                textItems: ["nested one\nnested two\r\nnested three\rnested four"],
            },
        ],
    })

    const stagedDraft = await readHousekeepingDraft(h.sessionID, h.ctx.state.housekeeping!.draftRef)
    assert.deepEqual(stagedDraft.memo, [
        "root one",
        "root two",
        "root three",
        "root four",
        {
            topic: "Plan",
            items: ["nested one", "nested two", "nested three", "nested four"],
        },
    ])
    assert.equal(
        await h.readMemo(),
        "root one\nroot two\nroot three\nroot four\n# Plan\nnested one\nnested two\nnested three\nnested four",
    )
    await h.leave()
})

test("edit_memo removes split lines independently by prefix at the root and in a nested topic", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", {
        action: "append",
        textItems: ["alpha\nbeta"],
        topics: [{ topicTitle: "Plan", textItems: ["nested alpha\nnested beta"] }],
    })
    await h.run("edit_memo", { action: "remove", path: "//beta" })
    await h.run("edit_memo", { action: "remove", path: "Plan//nested beta" })

    const stagedDraft = await readHousekeepingDraft(h.sessionID, h.ctx.state.housekeeping!.draftRef)
    assert.deepEqual(stagedDraft.memo, ["alpha", { topic: "Plan", items: ["nested alpha"] }])
    assert.equal(await h.readMemo(), "alpha\n# Plan\nnested alpha")
    await h.leave()
})

test("edit_memo rejects a duplicate introduced by splitting without changing the earlier draft", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { action: "append", textItems: ["Draft memo."] })
    const staged = structuredClone(
        (await readHousekeepingDraft(h.sessionID, h.ctx.state.housekeeping!.draftRef)).memo,
    )

    await assert.rejects(
        h.run("edit_memo", { action: "append", textItems: ["Fresh line\nDraft memo."] }),
        /duplicate/i,
    )

    assert.deepEqual(
        (await readHousekeepingDraft(h.sessionID, h.ctx.state.housekeeping!.draftRef)).memo,
        staged,
    )
    assert.equal(await h.readMemo(), "Draft memo.")
    await h.leave()
})

test("edit_memo inserts multiple topics after an anchor in submitted order before following siblings", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", {
        action: "append",
        topics: [
            {
                topicTitle: "Plan",
                topics: [
                    { topicTitle: "Alpha", textItems: ["a"] },
                    { topicTitle: "Beta", textItems: ["b"] },
                    { topicTitle: "Gamma", textItems: ["c"] },
                ],
            },
        ],
    })
    await h.run("edit_memo", {
        action: "append",
        parent: "Plan",
        after: "Plan/Alpha",
        topics: [
            { topicTitle: "Inserted one", textItems: ["one"] },
            { topicTitle: "Inserted two", textItems: ["two"] },
        ],
    })
    assert.equal(
        await h.readMemo(),
        "# Plan\n## Alpha\na\n## Inserted one\none\n## Inserted two\ntwo\n## Beta\nb\n## Gamma\nc",
    )
    await h.leave()
})

test("edit_memo rejects a late duplicate or over-deep batch without changing the earlier draft", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { action: "append", textItems: ["Draft memo."] })
    for (const args of [
        { action: "append", textItems: ["fresh", "Draft memo."] },
        { action: "append", topics: [{ topicTitle: "Fresh" }, { topicTitle: "Fresh" }] },
    ]) {
        await assert.rejects(h.run("edit_memo", args))
        assert.equal(await h.readMemo(), "Draft memo.")
    }
    await h.run("edit_memo", {
        action: "append",
        topics: [
            {
                topicTitle: "L1",
                topics: [
                    {
                        topicTitle: "L2",
                        topics: [
                            {
                                topicTitle: "L3",
                                topics: [
                                    {
                                        topicTitle: "L4",
                                        topics: [
                                            {
                                                topicTitle: "L5",
                                                topics: [{ topicTitle: "L6" }],
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
    })
    const deepDraft = "Draft memo.\n# L1\n## L2\n### L3\n#### L4\n##### L5\n###### L6"
    assert.equal(await h.readMemo(), deepDraft)
    await assert.rejects(
        h.run("edit_memo", {
            action: "append",
            parent: "L1/L2/L3/L4/L5/L6",
            topics: [{ topicTitle: "L7" }],
        }),
    )
    assert.equal(await h.readMemo(), deepDraft)
    await h.leave()
})

test("edit_memo rejects malformed append fields including serialized nested topics", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { action: "append", textItems: ["Draft memo."] })
    for (const args of [
        { action: "append", textItems: "not an array" },
        { action: "append", textItems: [1] },
        { action: "append", textItems: ["ok"], topics: "not an array" },
        { action: "append", topics: [{ topicTitle: "Plan", textItems: "not an array" }] },
        { action: "append", topics: ['{"topicTitle":"Plan"}'] },
        {
            action: "append",
            topics: [{ topicTitle: "Plan", topics: ['{"topicTitle":"Nested"}'] }],
        },
        { action: "append", topics: [{ textItems: ["missing title"] }] },
        { action: "append", topics: [{ topicTitle: 7 }] },
        { action: "append", parent: 7, textItems: ["text"] },
        { action: "append", after: 7, textItems: ["text"] },
    ]) {
        await assert.rejects(h.run("edit_memo", args))
        assert.equal(await h.readMemo(), "Draft memo.")
    }
    await h.leave()
})

test("edit_memo rejects an append without any text item or topic", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { action: "append", textItems: ["Draft memo."] })
    for (const args of [
        { action: "append" },
        { action: "append", textItems: [] },
        { action: "append", topics: [] },
        { action: "append", textItems: [], topics: [] },
    ]) {
        await assert.rejects(h.run("edit_memo", args))
        assert.equal(await h.readMemo(), "Draft memo.")
    }
    await h.leave()
})

test("edit_memo rejects legacy content arguments even alongside valid text items", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { action: "append", textItems: ["Draft memo."] })
    for (const args of [
        { action: "append", content: "Legacy content." },
        { action: "append", textItems: ["valid text"], content: "Legacy content." },
        {
            action: "append",
            textItems: ["valid text"],
            content: { topic: "Legacy", items: ["nested"] },
        },
        { action: "append", topics: [{ topicTitle: "Valid" }], content: "Legacy content." },
    ]) {
        await assert.rejects(h.run("edit_memo", args))
        assert.equal(await h.readMemo(), "Draft memo.")
    }
    await h.leave()
})

test("edit_memo keeps JSON-looking and bullet-prefixed text items verbatim", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    const serialized = '{"topicTitle":"Not a topic"}'
    await h.run("edit_memo", {
        action: "append",
        textItems: [serialized, "- already bulleted"],
    })
    assert.equal(await h.readMemo(), `${serialized}\n- already bulleted`)
    await h.leave()
})

test("leave and a concurrent mutation serialize without losing or leaking the mutation", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    const results = await Promise.allSettled([
        h.leave(),
        h.run(
            "edit_memo",
            { action: "append", textItems: ["Serialized draft."] },
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

test("public configuration defaults and explicit compression tool protections", async (t) => {
    const h = await createHousekeepingHarness(t)
    const ctx = { ...h.ctx, directory: h.root } as any
    const defaults = getConfig(ctx)

    assert.deepEqual(Object.keys(defaults.compress.protectedTools), ["task", "skill"])
    assert.deepEqual(Object.keys(defaults.commands.protectedTools), [
        "task",
        "skill",
        "todowrite",
        "todoread",
        "compress",
        "batch",
        "plan_enter",
        "plan_exit",
        "write",
        "edit",
    ])

    await mkdir(`${h.root}/.opencode`, { recursive: true })
    const configPath = `${h.root}/.opencode/dcp.jsonc`
    await writeFile(
        configPath,
        JSON.stringify({
            compress: {
                protectedTools: {
                    todoread: { keepLast: 2 },
                    todowrite: { truncateSize: 100 },
                },
            },
        }),
        "utf-8",
    )

    const configured = getConfig(ctx)
    assert.deepEqual(configured.compress.protectedTools.todoread, { keepLast: 2 })
    assert.deepEqual(configured.compress.protectedTools.todowrite, { truncateSize: 100 })
    assert.equal(
        resolveProtectedTool(configured.compress.protectedTools, "todoread")?.protect,
        true,
    )
    assert.equal(
        resolveProtectedTool(configured.compress.protectedTools, "todowrite")?.protect,
        true,
    )
})

for (const allowedTools of ["read", null, [1], ["read", false]]) {
    test(`configuration rejects invalid allowedTools ${JSON.stringify(allowedTools)}`, () => {
        const errors = validateConfigTypes({ housekeeping: { allowedTools } })
        assert.ok(errors.some((error) => error.key.startsWith("housekeeping.allowedTools")))
    })
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined
}

type TestCheckpointRef =
    | { kind: "snapshot"; snapshotId: string }
    | { kind: "delta"; snapshotId: string; baseSnapshotId: string }

const CHECKPOINT_REFERENCE_ERROR = /housekeeping|checkpoint|draft|delta|metadata|reference|kind/i

function checkpointRef(value: unknown, label: string): TestCheckpointRef {
    const ref = recordOf(value)
    assert.ok(ref, `${label} must be persisted as a housekeeping draft reference`)
    assert.ok(
        ref.kind === "snapshot" || ref.kind === "delta",
        `${label} must persist its reference kind`,
    )
    assert.ok(
        typeof ref.snapshotId === "string" && ref.snapshotId.length > 0,
        `${label} must persist a non-empty identifier`,
    )
    if (ref.kind === "delta") {
        assert.ok(
            typeof ref.baseSnapshotId === "string" && ref.baseSnapshotId.length > 0,
            `${label} must persist its base snapshot identifier`,
        )
        return {
            kind: "delta",
            snapshotId: ref.snapshotId,
            baseSnapshotId: ref.baseSnapshotId,
        }
    }
    assert.equal(ref.baseSnapshotId, undefined, `${label} snapshot must not carry a base`)
    return { kind: "snapshot", snapshotId: ref.snapshotId }
}

function snapshotRefId(value: unknown, label: string): string {
    const ref = checkpointRef(value, label)
    assert.equal(ref.kind, "snapshot", `${label} must be a snapshot reference`)
    return ref.snapshotId
}

function deltaCheckpoint(value: unknown, label: string): TestCheckpointRef {
    const ref = checkpointRef(value, label)
    assert.equal(ref.kind, "delta", `${label} must be a delta reference`)
    return ref
}

function housekeepingCheckpoints(transaction: Record<string, unknown>): TestCheckpointRef[] {
    const refs = [
        checkpointRef(transaction.baseRef, "transaction baseRef"),
        checkpointRef(transaction.draftRef, "transaction draftRef"),
    ]
    const operationRefs = recordOf(transaction.operationDraftRefs)
    if (operationRefs) {
        for (const ref of Object.values(operationRefs))
            refs.push(checkpointRef(ref, "operationDraftRefs entry"))
    }
    const completed = recordOf(transaction.completed)
    if (completed) refs.push(checkpointRef(completed.committedDraftRef, "completedDraftRef"))
    const unique = new Map<string, TestCheckpointRef>()
    for (const ref of refs) unique.set(`${ref.kind}:${ref.snapshotId}`, ref)
    return [...unique.values()]
}

function checkpointKeys(refs: TestCheckpointRef[]): string[] {
    return refs
        .map(
            (ref) =>
                `${ref.kind}:${ref.snapshotId}${
                    ref.kind === "delta" ? `:${ref.baseSnapshotId}` : ""
                }`,
        )
        .sort()
}

function housekeepingSnapshotDirectory(sessionID: string): string {
    return join(STORAGE_DIR, "housekeeping", encodeURIComponent(sessionID))
}

function housekeepingSnapshotPath(sessionID: string, snapshotId: string): string {
    return join(housekeepingSnapshotDirectory(sessionID), `${snapshotId}.json.gz`)
}

function housekeepingDeltaPath(sessionID: string, snapshotId: string): string {
    return join(housekeepingSnapshotDirectory(sessionID), `${snapshotId}.delta.json`)
}

function checkpointPath(sessionID: string, ref: TestCheckpointRef): string {
    return ref.kind === "snapshot"
        ? housekeepingSnapshotPath(sessionID, ref.snapshotId)
        : housekeepingDeltaPath(sessionID, ref.snapshotId)
}

function finalPayloadWrites(paths: string[], sessionID: string): string[] {
    const directory = housekeepingSnapshotDirectory(sessionID)
    return paths.filter((path) => path.startsWith(directory) && !path.endsWith(".tmp"))
}

function assertDeltaOnlyWrite(paths: string[], sessionID: string): string {
    const writes = finalPayloadWrites(paths, sessionID)
    assert.deepEqual(
        writes.filter((path) => path.endsWith(".json.gz")),
        [],
        "no gzip base may be written after entry",
    )
    const deltas = writes.filter((path) => path.endsWith(".delta.json"))
    assert.equal(deltas.length, 1, "exactly one delta payload must be written")
    return deltas[0]!
}

function stripCheckpointKinds(transaction: unknown): void {
    const record = recordOf(transaction)
    if (!record) return
    for (const key of ["baseRef", "draftRef"]) {
        const ref = recordOf(record[key])
        if (!ref) continue
        delete ref.kind
        delete ref.baseSnapshotId
    }
    const operationRefs = recordOf(record.operationDraftRefs)
    if (operationRefs) {
        for (const value of Object.values(operationRefs)) {
            const ref = recordOf(value)
            if (!ref) continue
            delete ref.kind
            delete ref.baseSnapshotId
        }
    }
    const completed = recordOf(record.completed)
    const committed = recordOf(completed?.committedDraftRef)
    if (committed) {
        delete committed.kind
        delete committed.baseSnapshotId
    }
}

function rebaseDeltaCheckpoints(transaction: unknown, baseSnapshotId: string): void {
    const record = recordOf(transaction)
    if (!record) return
    const draft = recordOf(record.draftRef)
    if (draft) draft.baseSnapshotId = baseSnapshotId
    const operationRefs = recordOf(record.operationDraftRefs)
    if (operationRefs) {
        for (const value of Object.values(operationRefs)) {
            const ref = recordOf(value)
            if (ref) ref.baseSnapshotId = baseSnapshotId
        }
    }
    const completed = recordOf(record.completed)
    const committed = recordOf(completed?.committedDraftRef)
    if (committed) committed.baseSnapshotId = baseSnapshotId
}

function liveCheckpointSummary(state: ReturnType<typeof createSessionState>) {
    return {
        revision: state.revision,
        contentRevision: state.contentRevision,
        prune: structuredClone(state.prune),
        stats: structuredClone(state.stats),
        nudges: structuredClone(state.nudges),
        memo: structuredClone(state.memo),
        housekeeping: structuredClone(state.housekeeping),
        housekeepingHistory: structuredClone(state.housekeepingHistory),
    }
}

function instrumentReadPaths(): { paths: string[]; restore: () => void } {
    const paths: string[] = []
    const originalReadFile = fsPromises.readFile
    fsPromises.readFile = (async (path: any, ...args: any[]) => {
        paths.push(String(path))
        return originalReadFile(path, ...args)
    }) as typeof fsPromises.readFile
    syncBuiltinESMExports()
    return {
        paths,
        restore() {
            fsPromises.readFile = originalReadFile
            syncBuiltinESMExports()
        },
    }
}

function instrumentWritePaths(): { paths: string[]; restore: () => void } {
    const paths: string[] = []
    const originalWriteFile = fsPromises.writeFile
    const originalRename = fsPromises.rename
    fsPromises.writeFile = (async (path: any, ...args: any[]) => {
        paths.push(String(path))
        return originalWriteFile(path, ...args)
    }) as typeof fsPromises.writeFile
    fsPromises.rename = (async (from: any, to: any, ...args: any[]) => {
        paths.push(String(from), String(to))
        return originalRename(from, to, ...args)
    }) as typeof fsPromises.rename
    syncBuiltinESMExports()
    return {
        paths,
        restore() {
            fsPromises.writeFile = originalWriteFile
            fsPromises.rename = originalRename
            syncBuiltinESMExports()
        },
    }
}

function failSnapshotWrites(
    sessionID: string,
    stage: "writeFile" | "rename",
): { restore: () => void } {
    const directory = housekeepingSnapshotDirectory(sessionID)
    const originalWriteFile = fsPromises.writeFile
    const originalRename = fsPromises.rename
    const failure = () => {
        const error = new Error("simulated housekeeping snapshot write failure")
        ;(error as NodeJS.ErrnoException).code = "EIO"
        throw error
    }
    if (stage === "writeFile") {
        fsPromises.writeFile = (async (path: any, ...args: any[]) => {
            if (String(path).startsWith(directory)) failure()
            return originalWriteFile(path, ...args)
        }) as typeof fsPromises.writeFile
    } else {
        fsPromises.rename = (async (from: any, to: any, ...args: any[]) => {
            if (String(to).startsWith(directory)) failure()
            return originalRename(from, to, ...args)
        }) as typeof fsPromises.rename
    }
    syncBuiltinESMExports()
    return {
        restore() {
            fsPromises.writeFile = originalWriteFile
            fsPromises.rename = originalRename
            syncBuiltinESMExports()
        },
    }
}

test("external checkpoint metadata stores draft references instead of embedded payloads", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()

    let manifest = await readPersistedFixture(h.sessionID)
    let active = recordOf(manifest.housekeeping)
    assert.ok(active, "active housekeeping metadata must be persisted")
    const baseRef = checkpointRef(active.baseRef, "active transaction baseRef")
    assert.equal(baseRef.kind, "snapshot")
    const entryDraftRef = checkpointRef(active.draftRef, "active transaction draftRef")
    assert.deepEqual(
        entryDraftRef,
        baseRef,
        "entry must reuse the base snapshot when the draft is identical",
    )
    for (const embedded of ["base", "draft", "operationDrafts"])
        assert.equal(active[embedded], undefined, `active metadata must not embed ${embedded}`)
    for (const ref of [baseRef, entryDraftRef])
        assert.ok(
            existsSync(checkpointPath(h.sessionID, ref)),
            `checkpoint ${ref.snapshotId} must exist`,
        )

    const runtime = recordOf(h.ctx.state.housekeeping)
    assert.ok(runtime, "active runtime transaction metadata must be present")
    assert.deepEqual(checkpointRef(runtime.baseRef, "runtime baseRef"), baseRef)
    assert.deepEqual(checkpointRef(runtime.draftRef, "runtime draftRef"), entryDraftRef)
    for (const embedded of ["base", "draft", "operationDrafts"])
        assert.equal(runtime[embedded], undefined, `runtime metadata must not embed ${embedded}`)

    await h.run("edit_memo", { action: "append", textItems: ["External checkpoint draft."] })

    manifest = await readPersistedFixture(h.sessionID)
    active = recordOf(manifest.housekeeping)
    assert.ok(active)
    const editedBaseRef = checkpointRef(active.baseRef, "edited transaction baseRef")
    const editedDraftRef = checkpointRef(active.draftRef, "edited transaction draftRef")
    assert.deepEqual(editedBaseRef, baseRef, "mutation must keep the base snapshot unchanged")
    assert.equal(editedDraftRef.kind, "delta")
    assert.equal(editedDraftRef.baseSnapshotId, baseRef.snapshotId)
    assert.notEqual(
        editedDraftRef.snapshotId,
        entryDraftRef.snapshotId,
        "mutation must publish a new working delta checkpoint",
    )
    const operationRefs = recordOf(active.operationDraftRefs)
    assert.ok(operationRefs, "operation checkpoints must be persisted as references")
    const operationCheckpoints = Object.values(operationRefs).map((ref) =>
        checkpointRef(ref, "operationDraftRefs entry"),
    )
    assert.ok(
        operationCheckpoints.some(
            (ref) => ref.kind === "delta" && ref.snapshotId === editedDraftRef.snapshotId,
        ),
        "the working draft reference must be reused for its operation checkpoint",
    )
    for (const ref of operationCheckpoints) {
        assert.equal(ref.kind, "delta")
        assert.equal(ref.baseSnapshotId, baseRef.snapshotId)
    }
    assert.equal(active.operationDrafts, undefined)

    await h.leave()

    manifest = await readPersistedFixture(h.sessionID)
    assert.equal(manifest.housekeeping, null)
    const history = manifest.housekeepingHistory
    assert.ok(Array.isArray(history) && history.length === 1)
    const completed = recordOf(history[0])
    assert.ok(completed)
    assert.deepEqual(checkpointRef(completed.baseRef, "completed baseRef"), baseRef)
    for (const embedded of ["base", "draft", "operationDrafts", "committedDraft"])
        assert.equal(
            completed[embedded],
            undefined,
            `completed metadata must not embed ${embedded}`,
        )
    const completedMetadata = recordOf(completed.completed)
    assert.ok(completedMetadata, "completed marker must be persisted")
    const committedRef = deltaCheckpoint(completedMetadata.committedDraftRef, "completedDraftRef")
    assert.equal(committedRef.baseSnapshotId, baseRef.snapshotId)
    assert.deepEqual(
        deltaCheckpoint(completed.draftRef, "completed draftRef"),
        committedRef,
        "leave must reuse the final draft reference for both positions",
    )
    assert.ok(existsSync(checkpointPath(h.sessionID, committedRef)))

    const runtimeCompleted = recordOf(h.ctx.state.housekeepingHistory[0])
    assert.ok(runtimeCompleted)
    assert.deepEqual(checkpointRef(runtimeCompleted.baseRef, "runtime completed baseRef"), baseRef)
    assert.deepEqual(
        deltaCheckpoint(
            recordOf(runtimeCompleted.completed)?.committedDraftRef,
            "runtime committedDraftRef",
        ),
        committedRef,
    )
})

test("external checkpoint restart and intact render read no checkpoint payloads", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { action: "append", textItems: ["Cold historical memo."] })
    await h.leave()
    h.addText("after-checkpoint", "Ordinary work after housekeeping.", "user")

    const manifest = await readPersistedFixture(h.sessionID)
    const transaction = recordOf(manifest.housekeepingHistory?.[0])
    assert.ok(transaction, "completed transaction metadata must be persisted")
    const checkpoints = housekeepingCheckpoints(transaction)
    assert.ok(checkpoints.length > 0, "completed transaction must reference checkpoint payloads")
    for (const ref of checkpoints) assert.ok(existsSync(checkpointPath(h.sessionID, ref)))

    const reads = instrumentReadPaths()
    try {
        await h.restart()
        await h.render()
    } finally {
        reads.restore()
    }
    const directory = housekeepingSnapshotDirectory(h.sessionID)
    assert.deepEqual(
        reads.paths.filter((path) => path.startsWith(directory)),
        [],
        "intact restart and render must not read historical checkpoint payloads",
    )
    assert.equal(await h.readMemo(), "Cold historical memo.")
})

test("external checkpoint ordinary strict save does not rewrite checkpoint payloads", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { action: "append", textItems: ["Strict save memo."] })
    await h.leave()

    const before = await readPersistedFixture(h.sessionID)
    const transaction = recordOf(before.housekeepingHistory?.[0])
    assert.ok(transaction)
    const beforeRefs = housekeepingCheckpoints(transaction)
    for (const ref of beforeRefs) assert.ok(existsSync(checkpointPath(h.sessionID, ref)))

    const writes = instrumentWritePaths()
    try {
        await saveSessionStateStrict(h.ctx.state, h.ctx.logger)
    } finally {
        writes.restore()
    }
    const directory = housekeepingSnapshotDirectory(h.sessionID)
    assert.deepEqual(
        writes.paths.filter((path) => path.startsWith(directory)),
        [],
        "ordinary strict save must not write checkpoint payloads",
    )

    const after = await readPersistedFixture(h.sessionID)
    assert.ok(
        (after.revision ?? 0) > (before.revision ?? 0),
        "strict save must persist the manifest",
    )
    const afterTransaction = recordOf(after.housekeepingHistory?.[0])
    assert.ok(afterTransaction)
    assert.deepEqual(
        checkpointKeys(housekeepingCheckpoints(afterTransaction)),
        checkpointKeys(beforeRefs),
    )
})

for (const failure of ["missing", "corrupt"] as const) {
    test(`external checkpoint ${failure} recovery payload fails atomically and permits a usable revert point`, async (t) => {
        const h = await createHousekeepingHarness(t)
        const original = structuredClone(h.history)

        await h.enter()
        await h.run("edit_memo", { action: "append", textItems: ["Memo A."] })
        await h.leave()
        const afterA = structuredClone(h.history)

        await h.enter()
        await h.run("edit_memo", { action: "append", textItems: ["Memo B."] })
        await h.leave()

        const manifest = await readPersistedFixture(h.sessionID)
        const transactions = manifest.housekeepingHistory ?? []
        assert.equal(transactions.length, 2)
        const transactionA = recordOf(transactions[0])
        const transactionB = recordOf(transactions[1])
        assert.ok(transactionA && transactionB)
        const baseARef = checkpointRef(transactionA.baseRef, "transaction A baseRef")
        const baseBRef = checkpointRef(transactionB.baseRef, "transaction B baseRef")
        assert.equal(baseARef.kind, "snapshot")
        assert.equal(baseBRef.kind, "snapshot")
        const draftARef = deltaCheckpoint(transactionA.draftRef, "transaction A draftRef")
        assert.equal(draftARef.baseSnapshotId, baseARef.snapshotId)
        assert.notEqual(baseARef.snapshotId, baseBRef.snapshotId)
        assert.notEqual(baseARef.snapshotId, draftARef.snapshotId)
        assert.ok(existsSync(checkpointPath(h.sessionID, baseARef)))
        assert.ok(existsSync(checkpointPath(h.sessionID, baseBRef)))

        if (failure === "missing") {
            await rm(checkpointPath(h.sessionID, baseARef), { force: true })
        } else {
            await writeFile(
                checkpointPath(h.sessionID, baseARef),
                gzipSync(Buffer.from('{"prune":', "utf-8")),
            )
        }

        h.setHistory(original)
        const manifestBefore = await readFile(getSessionFilePath(h.sessionID), "utf-8")
        const liveBefore = liveCheckpointSummary(h.ctx.state)
        await assert.rejects(
            h.render(),
            /snapshot|delta|draft|not found|malformed|invalid|compressed/i,
        )
        assert.equal(await readFile(getSessionFilePath(h.sessionID), "utf-8"), manifestBefore)
        assert.deepEqual(liveCheckpointSummary(h.ctx.state), liveBefore)

        h.setHistory(afterA)
        await h.render()
        assert.equal(await h.readMemo(), "Memo A.")
    })
}

test("missing required completed-transaction draft reference rejects repeated renders until the manifest is repaired", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { action: "append", textItems: ["Recovery memo."] })
    await h.leave()

    const originalManifest = await readFile(getSessionFilePath(h.sessionID), "utf-8")
    const manifest = JSON.parse(originalManifest) as PersistedSessionState
    const completed = recordOf(manifest.housekeepingHistory?.[0])
    assert.ok(completed, "completed transaction metadata must be persisted")
    snapshotRefId(completed.baseRef, "completed transaction baseRef")
    delete completed.baseRef
    await writePersistedFixture(h.sessionID, manifest)
    const corruptedManifest = await readFile(getSessionFilePath(h.sessionID), "utf-8")
    const liveBefore = liveCheckpointSummary(createSessionState())

    await assert.rejects(h.restart(), /housekeeping|checkpoint|draft|metadata/i)
    assert.equal(await readFile(getSessionFilePath(h.sessionID), "utf-8"), corruptedManifest)
    assert.deepEqual(liveCheckpointSummary(h.ctx.state), liveBefore)

    await assert.rejects(h.render(), /housekeeping|checkpoint|draft|metadata/i)
    assert.equal(await readFile(getSessionFilePath(h.sessionID), "utf-8"), corruptedManifest)
    assert.deepEqual(liveCheckpointSummary(h.ctx.state), liveBefore)

    await writeFile(getSessionFilePath(h.sessionID), originalManifest, "utf-8")
    await h.render()
    assert.equal(await h.readMemo(), "Recovery memo.")
    h.assertSessionReads()
})

test("missing first-operation checkpoint reference rejects active recovery instead of using base", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { action: "append", textItems: ["First checkpoint."] })
    const afterFirstOperation = structuredClone(h.history)
    await h.run("edit_memo", { action: "append", textItems: ["Second checkpoint."] })

    const manifest = await readPersistedFixture(h.sessionID)
    const active = recordOf(manifest.housekeeping)
    assert.ok(active, "active transaction metadata must be persisted")
    const transactionId = active.id
    assert.equal(typeof transactionId, "string")
    const historyEntry = (manifest.housekeepingHistory ?? [])
        .map(recordOf)
        .find((entry) => entry?.id === transactionId)
    assert.ok(historyEntry, "active transaction must also be persisted in history")
    const order = active.operationOrder
    assert.ok(Array.isArray(order) && order.length >= 2)
    const firstOperation = order[0]
    assert.equal(typeof firstOperation, "string")
    const activeRefs = recordOf(active.operationDraftRefs)
    const historyRefs = recordOf(historyEntry.operationDraftRefs)
    assert.ok(activeRefs && historyRefs)
    assert.ok(activeRefs[firstOperation], "first operation must start with a checkpoint reference")
    assert.ok(historyRefs[firstOperation], "history must hold the first operation checkpoint")
    delete activeRefs[firstOperation]
    delete historyRefs[firstOperation]
    await writePersistedFixture(h.sessionID, manifest)

    await h.restart()
    h.setHistory(afterFirstOperation)
    const manifestBefore = await readFile(getSessionFilePath(h.sessionID), "utf-8")
    const liveBefore = liveCheckpointSummary(h.ctx.state)

    await assert.rejects(h.render(), /housekeeping|checkpoint|draft|metadata/i)
    assert.equal(await readFile(getSessionFilePath(h.sessionID), "utf-8"), manifestBefore)
    assert.deepEqual(liveCheckpointSummary(h.ctx.state), liveBefore)
    h.assertSessionReads()
})

for (const stage of ["writeFile", "rename"] as const) {
    test(`external checkpoint ${stage} delta write failure leaves published state unchanged and retry succeeds`, async (t) => {
        const h = await createHousekeepingHarness(t)
        await h.enter()
        const activeBefore = recordOf((await readPersistedFixture(h.sessionID)).housekeeping)
        assert.ok(activeBefore)
        const baseRef = checkpointRef(activeBefore.baseRef, "entry baseRef")
        assert.equal(baseRef.kind, "snapshot")
        const manifestBefore = await readFile(getSessionFilePath(h.sessionID), "utf-8")
        const liveBefore = liveCheckpointSummary(h.ctx.state)
        const identity = {
            callID: "checkpoint-failure-retry",
            messageID: "checkpoint-failure-retry-message",
        }

        const failure = failSnapshotWrites(h.sessionID, stage)
        try {
            await assert.rejects(
                h.run(
                    "edit_memo",
                    { action: "append", textItems: ["Retried checkpoint memo."] },
                    identity,
                ),
                /checkpoint|draft|delta|EIO|write|rename/i,
            )
        } finally {
            failure.restore()
        }

        assert.equal(await readFile(getSessionFilePath(h.sessionID), "utf-8"), manifestBefore)
        assert.deepEqual(liveCheckpointSummary(h.ctx.state), liveBefore)

        const retry = await h.run(
            "edit_memo",
            { action: "append", textItems: ["Retried checkpoint memo."] },
            identity,
        )
        assert.ok(retry.length > 0)
        assert.equal(await h.readMemo(), "Retried checkpoint memo.")
        const activeAfter = recordOf((await readPersistedFixture(h.sessionID)).housekeeping)
        assert.ok(activeAfter)
        const draftRefAfter = deltaCheckpoint(activeAfter.draftRef, "retried draftRef")
        assert.equal(draftRefAfter.baseSnapshotId, baseRef.snapshotId)
        assert.ok(existsSync(checkpointPath(h.sessionID, draftRefAfter)))
        const operationRefs = recordOf(activeAfter.operationDraftRefs)
        assert.ok(operationRefs, "retry must store its operation checkpoint reference")
        for (const ref of Object.values(operationRefs)) {
            const checkpoint = deltaCheckpoint(ref, "retried operation checkpoint")
            assert.equal(checkpoint.baseSnapshotId, baseRef.snapshotId)
        }
        await h.leave()
        assert.equal(await h.readMemo(), "Retried checkpoint memo.")
    })
}

test("entry writes exactly one gzip base and reuses it without a todo delta", async (t) => {
    const h = await createHousekeepingHarness(t)
    const writes = instrumentWritePaths()
    try {
        await h.enter()
    } finally {
        writes.restore()
    }

    const payloadWrites = finalPayloadWrites(writes.paths, h.sessionID)
    assert.equal(
        payloadWrites.filter((path) => path.endsWith(".json.gz")).length,
        1,
        "entry must write exactly one gzip base",
    )
    assert.equal(
        payloadWrites.filter((path) => path.endsWith(".delta.json")).length,
        0,
        "entry without todos must not write a delta",
    )

    const active = recordOf((await readPersistedFixture(h.sessionID)).housekeeping)
    assert.ok(active)
    const baseRef = checkpointRef(active.baseRef, "entry baseRef")
    assert.equal(baseRef.kind, "snapshot")
    assert.deepEqual(checkpointRef(active.draftRef, "entry draftRef"), baseRef)
    assert.ok(existsSync(checkpointPath(h.sessionID, baseRef)))
    assert.deepEqual(active.operationDraftRefs, {})
})

test("entry stores an optional todo checkpoint as a base-relative delta", async (t) => {
    const h = await createHousekeepingHarness(t)
    const todos = [{ id: "todo-delta", status: "pending" }]
    h.todo.mock.mockImplementationOnce(async () => ({ data: todos }))
    const writes = instrumentWritePaths()
    try {
        await h.enter()
    } finally {
        writes.restore()
    }

    const payloadWrites = finalPayloadWrites(writes.paths, h.sessionID)
    assert.equal(
        payloadWrites.filter((path) => path.endsWith(".json.gz")).length,
        1,
        "entry must write exactly one gzip base even when todos are stored",
    )
    const deltaWrites = payloadWrites.filter((path) => path.endsWith(".delta.json"))
    assert.equal(deltaWrites.length, 1, "todo checkpoint must be stored as one delta")

    const active = recordOf((await readPersistedFixture(h.sessionID)).housekeeping)
    assert.ok(active)
    const baseRef = checkpointRef(active.baseRef, "entry baseRef")
    assert.equal(baseRef.kind, "snapshot")
    const draftRef = deltaCheckpoint(active.draftRef, "todo draftRef")
    assert.equal(draftRef.baseSnapshotId, baseRef.snapshotId)
    assert.equal(checkpointPath(h.sessionID, draftRef), deltaWrites[0])

    const envelope = JSON.parse(await readFile(checkpointPath(h.sessionID, draftRef), "utf-8"))
    assert.equal(envelope.baseSnapshotId, baseRef.snapshotId)
    assert.ok(Array.isArray(envelope.changes) && envelope.changes.length > 0)
    assert.equal(await h.readMemo(), `# Todo status\n${JSON.stringify(todos)}`)
})

test("tool operations write base-relative deltas and read only the base plus working delta", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    const activeAfterEntry = recordOf((await readPersistedFixture(h.sessionID)).housekeeping)
    assert.ok(activeAfterEntry)
    const baseRef = checkpointRef(activeAfterEntry.baseRef, "entry baseRef")

    const firstWrites = instrumentWritePaths()
    try {
        await h.run(
            "edit_memo",
            { action: "append", textItems: ["Delta operation one."] },
            { callID: "delta-op-1", messageID: "delta-op-1-message" },
        )
    } finally {
        firstWrites.restore()
    }
    assertDeltaOnlyWrite(firstWrites.paths, h.sessionID)

    let active = recordOf((await readPersistedFixture(h.sessionID)).housekeeping)
    assert.ok(active)
    assert.deepEqual(checkpointRef(active.baseRef, "operation baseRef"), baseRef)
    const firstDraftRef = deltaCheckpoint(active.draftRef, "first operation draftRef")
    assert.equal(firstDraftRef.baseSnapshotId, baseRef.snapshotId)
    const firstOperationRefs = recordOf(active.operationDraftRefs)
    assert.ok(firstOperationRefs)
    assert.deepEqual(
        deltaCheckpoint(
            firstOperationRefs["delta-op-1-message\0delta-op-1"],
            "first operation ref",
        ),
        firstDraftRef,
    )

    const reads = instrumentReadPaths()
    const secondWrites = instrumentWritePaths()
    try {
        await h.run(
            "edit_memo",
            { action: "append", textItems: ["Delta operation two."] },
            { callID: "delta-op-2", messageID: "delta-op-2-message" },
        )
    } finally {
        secondWrites.restore()
        reads.restore()
    }
    assertDeltaOnlyWrite(secondWrites.paths, h.sessionID)

    const directory = housekeepingSnapshotDirectory(h.sessionID)
    const payloadReads = reads.paths.filter((path) => path.startsWith(directory))
    assert.deepEqual(
        payloadReads.sort(),
        [
            housekeepingSnapshotPath(h.sessionID, baseRef.snapshotId),
            checkpointPath(h.sessionID, firstDraftRef),
        ].sort(),
        "one operation may read only its base and working delta",
    )

    active = recordOf((await readPersistedFixture(h.sessionID)).housekeeping)
    assert.ok(active)
    const secondDraftRef = deltaCheckpoint(active.draftRef, "second operation draftRef")
    assert.equal(secondDraftRef.baseSnapshotId, baseRef.snapshotId)
    assert.notEqual(secondDraftRef.snapshotId, firstDraftRef.snapshotId)
    const secondOperationRefs = recordOf(active.operationDraftRefs)
    assert.ok(secondOperationRefs)
    assert.deepEqual(
        deltaCheckpoint(
            secondOperationRefs["delta-op-2-message\0delta-op-2"],
            "second operation ref",
        ),
        secondDraftRef,
    )
})

test("housekeeping commands write base-relative deltas and reuse their operation ref", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { action: "append", textItems: ["Before command."] })
    const activeBefore = recordOf((await readPersistedFixture(h.sessionID)).housekeeping)
    assert.ok(activeBefore)
    const baseRef = checkpointRef(activeBefore.baseRef, "command baseRef")

    const writes = instrumentWritePaths()
    try {
        await h.command("memo set Command memo.")
    } finally {
        writes.restore()
    }
    assertDeltaOnlyWrite(writes.paths, h.sessionID)

    const active = recordOf((await readPersistedFixture(h.sessionID)).housekeeping)
    assert.ok(active)
    const draftRef = deltaCheckpoint(active.draftRef, "command draftRef")
    assert.equal(draftRef.baseSnapshotId, baseRef.snapshotId)
    const order = active.operationOrder
    assert.ok(Array.isArray(order) && order.length > 0)
    const operationId = order.at(-1)
    assert.equal(typeof operationId, "string")
    const operationRefs = recordOf(active.operationDraftRefs)
    assert.ok(operationRefs)
    assert.deepEqual(
        deltaCheckpoint(operationRefs[operationId as string], "command operation ref"),
        draftRef,
    )
    const records = active.operationRecords
    assert.ok(Array.isArray(records))
    const record = recordOf(records.at(-1))
    assert.ok(record)
    assert.equal(record.tool, "command:memo")
    assert.equal(await h.readMemo(), "Command memo.")
})

test("leave writes a final base-relative delta and reuses it for completed metadata", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { action: "append", textItems: ["Alpha"] })
    await h.run("edit_memo", { action: "append", textItems: ["Beta"] })
    const activeBefore = recordOf((await readPersistedFixture(h.sessionID)).housekeeping)
    assert.ok(activeBefore)
    const baseRef = checkpointRef(activeBefore.baseRef, "leave baseRef")

    const writes = instrumentWritePaths()
    try {
        await h.leave()
    } finally {
        writes.restore()
    }
    assertDeltaOnlyWrite(writes.paths, h.sessionID)

    const manifest = await readPersistedFixture(h.sessionID)
    assert.equal(manifest.housekeeping, null)
    const completed = recordOf(manifest.housekeepingHistory?.at(-1))
    assert.ok(completed)
    assert.deepEqual(checkpointRef(completed.baseRef, "completed baseRef"), baseRef)
    const completedDraftRef = deltaCheckpoint(completed.draftRef, "completed draftRef")
    assert.equal(completedDraftRef.baseSnapshotId, baseRef.snapshotId)
    const completedMetadata = recordOf(completed.completed)
    assert.ok(completedMetadata)
    const committedRef = deltaCheckpoint(
        completedMetadata.committedDraftRef,
        "completed committedDraftRef",
    )
    assert.deepEqual(committedRef, completedDraftRef)
    assert.ok(existsSync(checkpointPath(h.sessionID, committedRef)))
    for (const ref of housekeepingCheckpoints(completed)) {
        if (ref.kind === "delta") assert.equal(ref.baseSnapshotId, baseRef.snapshotId)
    }
    assert.equal(await h.readMemo(), "Alpha\nBeta")
})

test("restart and operation cuts restore delta checkpoints and retry exact results", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    const afterEntry = structuredClone(h.history)
    const firstResult = await h.run(
        "edit_memo",
        { action: "append", textItems: ["Alpha"] },
        { callID: "delta-retry-op-1", messageID: "delta-retry-op-1-message" },
    )
    const afterFirst = structuredClone(h.history)
    const secondResult = await h.run(
        "edit_memo",
        { action: "append", textItems: ["Beta"] },
        { callID: "delta-retry-op-2", messageID: "delta-retry-op-2-message" },
    )

    await h.restart()
    assert.equal(await h.readMemo(), "Alpha\nBeta")

    h.setHistory(afterFirst)
    await h.render()
    assert.equal(await h.readMemo(), "Alpha")

    const secondRetry = await h.run(
        "edit_memo",
        { action: "append", textItems: ["Beta"] },
        { callID: "delta-retry-op-2", messageID: "delta-retry-op-2-message" },
    )
    assert.equal(secondRetry, secondResult)
    assert.equal(await h.readMemo(), "Alpha\nBeta")

    h.setHistory(afterEntry)
    await h.render()
    assert.equal(await h.readMemo(), "(memo is empty)")
    const firstRetry = await h.run(
        "edit_memo",
        { action: "append", textItems: ["Alpha"] },
        { callID: "delta-retry-op-1", messageID: "delta-retry-op-1-message" },
    )
    assert.equal(firstRetry, firstResult)
    const finalRetry = await h.run(
        "edit_memo",
        { action: "append", textItems: ["Beta"] },
        { callID: "delta-retry-op-2", messageID: "delta-retry-op-2-message" },
    )
    assert.equal(finalRetry, secondResult)
    assert.equal(await h.readMemo(), "Alpha\nBeta")

    await h.leave()
    await h.restart()
    assert.equal(await h.readMemo(), "Alpha\nBeta")
})

test("obsolete earlier operation delta can be removed without breaking later checkpoints", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { action: "append", textItems: ["Alpha"] })
    const afterFirst = recordOf((await readPersistedFixture(h.sessionID)).housekeeping)
    assert.ok(afterFirst)
    const firstDraftRef = deltaCheckpoint(afterFirst.draftRef, "first operation draftRef")
    const firstDraftPath = checkpointPath(h.sessionID, firstDraftRef)
    assert.ok(existsSync(firstDraftPath))

    await h.run("edit_memo", { action: "append", textItems: ["Beta"] })
    const afterSecond = recordOf((await readPersistedFixture(h.sessionID)).housekeeping)
    assert.ok(afterSecond)
    const secondDraftRef = deltaCheckpoint(afterSecond.draftRef, "second operation draftRef")
    assert.notEqual(secondDraftRef.snapshotId, firstDraftRef.snapshotId)

    await rm(firstDraftPath)
    await h.restart()
    assert.equal(await h.readMemo(), "Alpha\nBeta")

    await h.leave()
    await h.restart()
    assert.equal(await h.readMemo(), "Alpha\nBeta")
})

test("old reference metadata without kind rejects repeated initialization until repaired", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { action: "append", textItems: ["Legacy reference memo."] })

    const originalManifest = await readFile(getSessionFilePath(h.sessionID), "utf-8")
    const manifest = JSON.parse(originalManifest) as PersistedSessionState
    stripCheckpointKinds(manifest.housekeeping)
    for (const entry of manifest.housekeepingHistory ?? []) stripCheckpointKinds(recordOf(entry))
    await writePersistedFixture(h.sessionID, manifest)
    const corruptedManifest = await readFile(getSessionFilePath(h.sessionID), "utf-8")

    await assert.rejects(h.restart(), CHECKPOINT_REFERENCE_ERROR)
    assert.equal(await readFile(getSessionFilePath(h.sessionID), "utf-8"), corruptedManifest)
    await assert.rejects(h.render(), CHECKPOINT_REFERENCE_ERROR)
    assert.equal(await readFile(getSessionFilePath(h.sessionID), "utf-8"), corruptedManifest)

    await writeFile(getSessionFilePath(h.sessionID), originalManifest, "utf-8")
    await h.render()
    assert.equal(await h.readMemo(), "Legacy reference memo.")
})

test("cross-transaction delta base references reject metadata before payload hydration", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { action: "append", textItems: ["Transaction A."] })
    await h.leave()

    await h.enter()
    await h.run("edit_memo", { action: "append", textItems: ["Transaction B."] })

    const originalManifest = await readFile(getSessionFilePath(h.sessionID), "utf-8")
    const manifest = JSON.parse(originalManifest) as PersistedSessionState
    const active = recordOf(manifest.housekeeping)
    assert.ok(active)
    const foreignBase = snapshotRefId(
        recordOf(manifest.housekeepingHistory?.[0])?.baseRef,
        "transaction A baseRef",
    )
    rebaseDeltaCheckpoints(active, foreignBase)
    const activeId = active.id
    const historyEntry = (manifest.housekeepingHistory ?? [])
        .map(recordOf)
        .find((entry) => entry?.id === activeId)
    assert.ok(historyEntry)
    rebaseDeltaCheckpoints(historyEntry, foreignBase)
    await writePersistedFixture(h.sessionID, manifest)
    const corruptedManifest = await readFile(getSessionFilePath(h.sessionID), "utf-8")

    const reads = instrumentReadPaths()
    try {
        await assert.rejects(h.restart(), CHECKPOINT_REFERENCE_ERROR)
    } finally {
        reads.restore()
    }
    const directory = housekeepingSnapshotDirectory(h.sessionID)
    assert.deepEqual(
        reads.paths.filter((path) => path.startsWith(directory)),
        [],
        "cross-transaction metadata must reject before payload hydration",
    )
    assert.equal(await readFile(getSessionFilePath(h.sessionID), "utf-8"), corruptedManifest)

    await writeFile(getSessionFilePath(h.sessionID), originalManifest, "utf-8")
    await h.render()
    assert.equal(await h.readMemo(), "Transaction A.\nTransaction B.")
})

test("missing required delta fails without manifest or live changes and recovers after repair", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { action: "append", textItems: ["Delta memo."] })

    const active = recordOf((await readPersistedFixture(h.sessionID)).housekeeping)
    assert.ok(active)
    const draftRef = deltaCheckpoint(active.draftRef, "operation draftRef")
    const draftPath = checkpointPath(h.sessionID, draftRef)
    assert.ok(existsSync(draftPath))
    const payload = await readFile(draftPath)
    await rm(draftPath)

    await h.restart()
    const manifestBefore = await readFile(getSessionFilePath(h.sessionID), "utf-8")
    const liveBefore = liveCheckpointSummary(h.ctx.state)
    await assert.rejects(h.readMemo(), /delta|not found|ENOENT|checkpoint|draft|kind|reference/i)
    assert.equal(await readFile(getSessionFilePath(h.sessionID), "utf-8"), manifestBefore)
    assert.deepEqual(liveCheckpointSummary(h.ctx.state), liveBefore)

    await writeFile(draftPath, payload)
    assert.equal(await h.readMemo(), "Delta memo.")
})
