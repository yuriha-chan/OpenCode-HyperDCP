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
import { createSessionState } from "../lib/state"

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

function toolMessage(sessionID: string, messageId: string, callID: string, output: string) {
    return {
        info: { id: messageId, role: "assistant", sessionID, time: { created: 1 } },
        parts: [
            {
                id: `${callID}-part`,
                messageID: messageId,
                sessionID,
                type: "tool" as const,
                tool: "task",
                callID,
                state: { status: "completed" as const, input: { description: "demo" }, output },
            },
        ],
    }
}

async function runProtected(outputs: string[], protectedTools: unknown) {
    const sessionID = `ses_protected_tools_${Date.now()}_${Math.random()}`
    const messages = outputs.map((output, index) =>
        toolMessage(sessionID, `msg-${index + 1}`, `call-${index + 1}`, output),
    )
    const state = createSessionState()
    return appendProtectedTools(
        {},
        state,
        false,
        "SUMMARY",
        { messageIds: messages.map((message) => message.info.id) } as any,
        { rawMessagesById: new Map(messages.map((message) => [message.info.id, message])) } as any,
        protectedTools as any,
        [],
    )
}

test("appendProtectedTools keeps only the last N instances", async () => {
    const result = await runProtected(["out-1", "out-2", "out-3"], { task: { keepLast: 2 } })
    assert.doesNotMatch(result, /out-1/)
    assert.match(result, /out-2/)
    assert.match(result, /out-3/)
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
