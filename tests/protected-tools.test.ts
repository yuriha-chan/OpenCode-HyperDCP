import assert from "node:assert/strict"
import test from "node:test"
import {
    TRUNCATION_MARKER,
    isToolProtected,
    mergeProtectedTools,
    normalizeProtectedTools,
    resolveProtectedTool,
    truncateText,
} from "../lib/protected-tools"
import { appendProtectedTools } from "../lib/compress/protected-content"
import { createSessionState, type WithParts } from "../lib/state"

test("normalize protects every listed tool name", () => {
    const map = normalizeProtectedTools(["task", "read*"])
    assert.deepEqual(map, { task: { protect: true }, "read*": { protect: true } })
})

test("normalize keeps object specs and copies them", () => {
    const input = { task: { truncateSize: 10 } }
    const map = normalizeProtectedTools(input)
    assert.deepEqual(map, { task: { truncateSize: 10 } })
    assert.notEqual(map.task, input.task)
})

test("normalize treats missing value as empty", () => {
    assert.deepEqual(normalizeProtectedTools(undefined), {})
})

test("resolve: exact match wins over glob", () => {
    const value = { "read*": { protect: true, keepLast: 5 }, read: { protect: false } }
    const spec = resolveProtectedTool(value, "read")
    assert.equal(spec?.protect, false)
    assert.equal(spec?.keepLast, undefined)
})

test("resolve: glob match when no exact key", () => {
    const value = { "read*": { protect: true, truncateSize: 100 } }
    const spec = resolveProtectedTool(value, "readFile")
    assert.equal(spec?.protect, true)
    assert.equal(spec?.truncateSize, 100)
})

test("resolve: key present defaults protect to true", () => {
    assert.equal(resolveProtectedTool({ task: {} }, "task")?.protect, true)
})

test("resolve: explicit protect false is preserved", () => {
    assert.equal(resolveProtectedTool({ task: { protect: false } }, "task")?.protect, false)
})

test("resolve: string array accepted", () => {
    assert.equal(resolveProtectedTool(["task"], "task")?.protect, true)
    assert.equal(resolveProtectedTool(["read*"], "readFile")?.protect, true)
    assert.equal(resolveProtectedTool(["task"], "other"), null)
})

test("resolve: absent tool returns null", () => {
    assert.equal(resolveProtectedTool({ task: {} }, "other"), null)
    assert.equal(resolveProtectedTool(undefined, "task"), null)
})

test("isToolProtected reflects protect flag", () => {
    assert.equal(isToolProtected(["task"], "task"), true)
    assert.equal(isToolProtected({ task: { protect: false } }, "task"), false)
    assert.equal(isToolProtected({ task: {} }, "task"), true)
    assert.equal(isToolProtected({}, "task"), false)
})

test("merge: user disables a default protected tool", () => {
    const merged = mergeProtectedTools(["task", "skill"], { task: { protect: false } })
    assert.equal(merged.task?.protect, false)
    assert.equal(merged.skill?.protect, true)
})

test("merge: user adds a tool with fields", () => {
    const merged = mergeProtectedTools(["task"], { todowrite: { keepLast: 2 } })
    assert.deepEqual(merged.todowrite, { keepLast: 2 })
    assert.equal(merged.task?.protect, true)
})

test("merge: string array override is normalized", () => {
    assert.deepEqual(mergeProtectedTools({}, ["task"]), { task: { protect: true } })
})

test("merge: user fields merge onto default spec", () => {
    const merged = mergeProtectedTools({ task: { protect: true } }, { task: { truncateSize: 30 } })
    assert.deepEqual(merged.task, { protect: true, truncateSize: 30 })
})

test("truncateText keeps head", () => {
    assert.equal(truncateText("abcdefghij", 4, "head"), `abcd${TRUNCATION_MARKER}`)
})

test("truncateText keeps tail", () => {
    assert.equal(truncateText("abcdefghij", 4, "tail"), `${TRUNCATION_MARKER}ghij`)
})

test("truncateText keeps both ends", () => {
    assert.equal(truncateText("abcdefghij", 4, "both"), `ab${TRUNCATION_MARKER}ij`)
})

test("truncateText leaves short text unchanged", () => {
    assert.equal(truncateText("abc", 10, "both"), "abc")
})

type FetchMessages = (sessionID: string) => Promise<WithParts[]>

function taskResultOutput(body: string): string {
    return `<task_result>${body}</task_result>`
}

function toolMessage(
    sessionID: string,
    messageId: string,
    callID: string,
    output: string,
    metadata?: Record<string, unknown>,
): WithParts {
    return {
        info: { id: messageId, role: "assistant", sessionID, time: { created: 1 } } as WithParts["info"],
        parts: [
            {
                id: `${callID}-part`,
                messageID: messageId,
                sessionID,
                type: "tool" as const,
                tool: "task",
                callID,
                state: {
                    status: "completed" as const,
                    input: { description: "demo" },
                    output,
                    ...(metadata ? { metadata } : {}),
                },
            },
        ] as WithParts["parts"],
    }
}

function childMessage(
    sessionID: string,
    messageId: string,
    role: "user" | "assistant",
    parts: Array<{ type: "text" | "reasoning"; text: string }>,
): WithParts {
    return {
        info: { id: messageId, sessionID, role, time: { created: 1 } } as WithParts["info"],
        parts: parts.map((part, index) => ({
            id: `${messageId}-part-${index}`,
            messageID: messageId,
            sessionID,
            type: part.type,
            text: part.text,
        })) as WithParts["parts"],
    }
}

interface RunOptions {
    allowSubAgents?: boolean
    fetchMessages?: FetchMessages
    metadata?: Array<Record<string, unknown> | undefined>
    state?: ReturnType<typeof createSessionState>
    protectTaskOutputs?: boolean
}

async function runAppend(messages: WithParts[], protectedTools: unknown, options: RunOptions = {}) {
    const state = options.state ?? createSessionState()
    const fetchMessages = options.fetchMessages ?? (async () => [])
    return appendProtectedTools(
        fetchMessages,
        state,
        options.allowSubAgents ?? false,
        "SUMMARY",
        { messageIds: messages.map((message) => message.info.id) } as any,
        { rawMessagesById: new Map(messages.map((message) => [message.info.id, message])) } as any,
        protectedTools as any,
        [],
        options.protectTaskOutputs,
    )
}

async function runProtected(outputs: string[], protectedTools: unknown, options: RunOptions = {}) {
    const sessionID = `ses_protected_tools_${Date.now()}_${Math.random()}`
    const messages = outputs.map((output, index) =>
        toolMessage(
            sessionID,
            `msg-${index + 1}`,
            `call-${index + 1}`,
            output,
            options.metadata?.[index],
        ),
    )
    return runAppend(messages, protectedTools, options)
}

test("appendProtectedTools keeps only the last N instances", async () => {
    const result = await runProtected(["out-1", "out-2", "out-3"], { task: { keepLast: 2 } })
    assert.doesNotMatch(result, /out-1/)
    assert.match(result, /out-2/)
    assert.match(result, /out-3/)
})

test("task-output protection can be deferred without disabling other protected tools", async (t) => {
    const task = toolMessage("ses_deferred", "msg_task", "call_task", "TASK_OUTPUT", { sessionId: "ses_child" })
    const subagent = toolMessage("ses_deferred", "msg_subagent", "call_subagent", "SUBAGENT_OUTPUT")
    const read = toolMessage("ses_deferred", "msg_read", "call_read", "READ_OUTPUT")
    ;(subagent.parts[0] as any).tool = "subagent"
    ;(read.parts[0] as any).tool = "read"
    const fetchMessages = t.mock.fn(async () => [])
    const result = await runAppend([task, subagent, read], ["*"], {
        allowSubAgents: true, protectTaskOutputs: false, fetchMessages,
    })
    assert.doesNotMatch(result, /TASK_OUTPUT|SUBAGENT_OUTPUT/)
    assert.match(result, /READ_OUTPUT/)
    assert.equal(fetchMessages.mock.callCount(), 0)
})

test("appendProtectedTools truncates the result text", async () => {
    const result = await runProtected(["0123456789ABCDEF"], {
        task: { truncateSize: 5, truncateDirection: "head" },
    })
    assert.match(result, /01234/)
    assert.doesNotMatch(result, /56789/)
})

test("appendProtectedTools skips tools disabled with protect false", async () => {
    const result = await runProtected(["out-1"], { task: { protect: false } })
    assert.equal(result, "SUMMARY")
})

test("appendProtectedTools still accepts a string array", async () => {
    const result = await runProtected(["out-1"], ["task"])
    assert.match(result, /The following protected tools were used/)
    assert.match(result, /out-1/)
})

test("appendProtectedTools replaces stale task result with final child assistant text", async (t) => {
    const fetchMessages = t.mock.fn(async (sessionID: string) => [
        childMessage(sessionID, "child-user", "user", [
            { type: "text", text: "child user request" },
        ]),
        childMessage(sessionID, "child-assistant", "assistant", [
            { type: "reasoning", text: "child internal reasoning" },
            { type: "text", text: "Final child answer" },
        ]),
    ])

    const result = await runProtected(
        [taskResultOutput("stale task result")],
        { task: { protect: true } },
        {
            allowSubAgents: true,
            fetchMessages,
            metadata: [{ sessionId: "  ses_child_trimmed  " }],
        },
    )

    assert.match(result, /Final child answer/)
    assert.doesNotMatch(result, /stale task result/)
    assert.doesNotMatch(result, /child user request/)
    assert.doesNotMatch(result, /child internal reasoning/)
    assert.equal(fetchMessages.mock.callCount(), 1)
    assert.deepEqual(fetchMessages.mock.calls[0]?.arguments, ["ses_child_trimmed"])
})

test("appendProtectedTools reuses loaded child result without another fetch", async (t) => {
    const state = createSessionState()
    const fetchMessages = t.mock.fn(async (sessionID: string) => [
        childMessage(sessionID, "child-assistant", "assistant", [
            { type: "text", text: "Final child answer" },
        ]),
    ])
    const options: RunOptions = {
        allowSubAgents: true,
        fetchMessages,
        metadata: [{ sessionId: "ses_child" }],
        state,
    }

    const first = await runProtected([taskResultOutput("stale task result")], { task: {} }, options)
    const second = await runProtected([taskResultOutput("stale task result")], { task: {} }, options)

    for (const result of [first, second]) {
        assert.match(result, /Final child answer/)
        assert.doesNotMatch(result, /stale task result/)
    }
    assert.equal(fetchMessages.mock.callCount(), 1)
    assert.deepEqual(fetchMessages.mock.calls[0]?.arguments, ["ses_child"])
})

test("appendProtectedTools merges an existing cached child result without loading", async (t) => {
    const state = createSessionState()
    state.subAgentResultCache.set("call-1", "Cached child answer")
    const fetchMessages = t.mock.fn(async () => [])

    const result = await runProtected(
        [taskResultOutput("stale task result")],
        { task: {} },
        {
            allowSubAgents: true,
            fetchMessages,
            metadata: [{ sessionId: "ses_child" }],
            state,
        },
    )

    assert.match(result, /Cached child answer/)
    assert.doesNotMatch(result, /stale task result/)
    assert.equal(fetchMessages.mock.callCount(), 0)
})

test("appendProtectedTools preserves original output for empty cached result without loading", async (t) => {
    const state = createSessionState()
    state.subAgentResultCache.set("call-1", "")
    const fetchMessages = t.mock.fn(async () => [])

    const result = await runProtected(
        [taskResultOutput("original task result")],
        { task: {} },
        {
            allowSubAgents: true,
            fetchMessages,
            metadata: [{ sessionId: "ses_child" }],
            state,
        },
    )

    assert.match(result, /original task result/)
    assert.equal(fetchMessages.mock.callCount(), 0)
})

test("appendProtectedTools keeps original output when loading fails and retries later", async (t) => {
    const state = createSessionState()
    let attempt = 0
    const fetchMessages = t.mock.fn(async (sessionID: string) => {
        attempt += 1
        if (attempt === 1) {
            throw new Error("child session unavailable")
        }
        return [
            childMessage(sessionID, "child-assistant", "assistant", [
                { type: "text", text: "Final child answer" },
            ]),
        ]
    })
    const options: RunOptions = {
        allowSubAgents: true,
        fetchMessages,
        metadata: [{ sessionId: "ses_child" }],
        state,
    }

    const failed = await runProtected(
        [taskResultOutput("original task result")],
        { task: {} },
        options,
    )
    assert.match(failed, /original task result/)
    assert.doesNotMatch(failed, /Final child answer/)
    assert.equal(fetchMessages.mock.callCount(), 1)
    assert.deepEqual(fetchMessages.mock.calls[0]?.arguments, ["ses_child"])

    const retried = await runProtected(
        [taskResultOutput("original task result")],
        { task: {} },
        options,
    )
    assert.match(retried, /Final child answer/)
    assert.doesNotMatch(retried, /original task result/)
    assert.equal(fetchMessages.mock.callCount(), 2)
    assert.deepEqual(fetchMessages.mock.calls[1]?.arguments, ["ses_child"])
})

test("appendProtectedTools does not load child messages when subagents are disabled", async (t) => {
    const fetchMessages = t.mock.fn(async (sessionID: string) => [
        childMessage(sessionID, "child-assistant", "assistant", [
            { type: "text", text: "Final child answer" },
        ]),
    ])

    const result = await runProtected(
        [taskResultOutput("original task result")],
        { task: {} },
        {
            allowSubAgents: false,
            fetchMessages,
            metadata: [{ sessionId: "ses_child" }],
        },
    )

    assert.match(result, /original task result/)
    assert.doesNotMatch(result, /Final child answer/)
    assert.equal(fetchMessages.mock.callCount(), 0)
})

test("appendProtectedTools does not load child messages without session metadata", async (t) => {
    const fetchMessages = t.mock.fn(async (sessionID: string) => [
        childMessage(sessionID, "child-assistant", "assistant", [
            { type: "text", text: "Final child answer" },
        ]),
    ])

    const result = await runProtected(
        [taskResultOutput("original task result")],
        { task: {} },
        { allowSubAgents: true, fetchMessages },
    )

    assert.match(result, /original task result/)
    assert.doesNotMatch(result, /Final child answer/)
    assert.equal(fetchMessages.mock.callCount(), 0)
})

test("appendProtectedTools does not load child messages for unprotected tasks", async (t) => {
    const fetchMessages = t.mock.fn(async (sessionID: string) => [
        childMessage(sessionID, "child-assistant", "assistant", [
            { type: "text", text: "Final child answer" },
        ]),
    ])

    const result = await runProtected(
        [taskResultOutput("original task result")],
        {},
        {
            allowSubAgents: true,
            fetchMessages,
            metadata: [{ sessionId: "ses_child" }],
        },
    )

    assert.equal(result, "SUMMARY")
    assert.equal(fetchMessages.mock.callCount(), 0)
})

test("appendProtectedTools truncates merged child results", async (t) => {
    const fetchMessages = t.mock.fn(async (sessionID: string) => [
        childMessage(sessionID, "child-assistant", "assistant", [
            { type: "text", text: "FINAL_CHILD_TEXT_0123456789" },
        ]),
    ])

    const result = await runProtected(
        [taskResultOutput("OLD_BODY")],
        { task: { truncateSize: 20, truncateDirection: "head" } },
        {
            allowSubAgents: true,
            fetchMessages,
            metadata: [{ sessionId: "ses_child" }],
        },
    )

    assert.match(result, /FINAL_C/)
    assert.doesNotMatch(result, /CHILD_TEXT/)
    assert.ok(result.includes(TRUNCATION_MARKER))
    assert.deepEqual(fetchMessages.mock.calls[0]?.arguments, ["ses_child"])
})

test("appendProtectedTools keeps the last N merged child results", async (t) => {
    const fetchMessages = t.mock.fn(async (sessionID: string) => [
        childMessage(sessionID, "child-assistant", "assistant", [
            { type: "text", text: `child-text-${sessionID}` },
        ]),
    ])

    const result = await runProtected(
        [
            taskResultOutput("old-one"),
            taskResultOutput("old-two"),
            taskResultOutput("old-three"),
        ],
        { task: { keepLast: 2 } },
        {
            allowSubAgents: true,
            fetchMessages,
            metadata: [
                { sessionId: "ses_child_1" },
                { sessionId: "ses_child_2" },
                { sessionId: "ses_child_3" },
            ],
        },
    )

    assert.doesNotMatch(result, /child-text-ses_child_1/)
    assert.match(result, /child-text-ses_child_2/)
    assert.match(result, /child-text-ses_child_3/)
    assert.equal(fetchMessages.mock.callCount(), 3)
    assert.deepEqual(
        fetchMessages.mock.calls.map((call) => call.arguments),
        [["ses_child_1"], ["ses_child_2"], ["ses_child_3"]],
    )
})
