import "./helpers/storage-env"
import assert from "node:assert/strict"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import test from "node:test"
import { tool } from "@opencode-ai/plugin"
import { getConfig, getInvalidConfigKeys, validateConfigTypes } from "../lib/config"
import { renderMemo, type Memo } from "../lib/memo"
import { getSessionFilePath } from "../lib/paths"
import { resolveProtectedTool } from "../lib/protected-tools"
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

test("session restart migrates legacy memos in open and completed transaction snapshots", async (t) => {
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
    const openFixture = await readPersistedFixture(h.sessionID)
    await writePersistedFixture(
        h.sessionID,
        replacePersistedMemoValues(openFixture) as PersistedSessionState,
    )
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

    assert.deepEqual(h.ctx.state.housekeeping!.draft.memo, [
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

    assert.deepEqual(h.ctx.state.housekeeping!.draft.memo, [
        "alpha",
        { topic: "Plan", items: ["nested alpha"] },
    ])
    assert.equal(await h.readMemo(), "alpha\n# Plan\nnested alpha")
    await h.leave()
})

test("edit_memo rejects a duplicate introduced by splitting without changing the earlier draft", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { action: "append", textItems: ["Draft memo."] })
    const staged = structuredClone(h.ctx.state.housekeeping!.draft.memo)

    await assert.rejects(
        h.run("edit_memo", { action: "append", textItems: ["Fresh line\nDraft memo."] }),
        /duplicate/i,
    )

    assert.deepEqual(h.ctx.state.housekeeping!.draft.memo, staged)
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
