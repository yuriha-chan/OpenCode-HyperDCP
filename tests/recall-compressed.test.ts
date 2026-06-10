import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { createRecallCompressedTool } from "../lib/recall"
import { createCompressMessageTool } from "../lib/compress/message"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-dcp-recall-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-recall-config-tests-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return { id, messageID, sessionID, type: "text" as const, text }
}

function toolPart(
    messageID: string, sessionID: string, callID: string,
    toolName: string, output: string,
) {
    return {
        id: `${callID}-part`, messageID, sessionID,
        type: "tool" as const, tool: toolName, callID,
        state: { status: "completed" as const, input: { description: "demo" }, output },
    }
}

function buildMessages(sessionID: string): WithParts[] {
    return [
        {
            info: { id: "msg-1", role: "user", sessionID, agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 } } as WithParts["info"],
            parts: [textPart("msg-1", sessionID, "p-1", "Fix the auth bug: tokens expire too early")],
        },
        {
            info: { id: "msg-2", role: "assistant", sessionID, agent: "assistant",
                time: { created: 2 } } as WithParts["info"],
            parts: [textPart("msg-2", sessionID, "p-2", "Found the issue in token.ts line 42."),
                    toolPart("msg-2", sessionID, "call-1", "read", "export function validateToken...")],
        },
        {
            info: { id: "msg-3", role: "assistant", sessionID, agent: "assistant",
                time: { created: 3 } } as WithParts["info"],
            parts: [textPart("msg-3", sessionID, "p-3", "Applied fix: changed expiry from 5m to 30m.")],
        },
        {
            info: { id: "msg-4", role: "user", sessionID, agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 4 } } as WithParts["info"],
            parts: [textPart("msg-4", sessionID, "p-4", "Also check the database connection pool")],
        },
        {
            info: { id: "msg-5", role: "assistant", sessionID, agent: "assistant",
                time: { created: 5 } } as WithParts["info"],
            parts: [textPart("msg-5", sessionID, "p-5", "Pool size is 10, configured in db.ts.")],
        },
    ]
}

function makeCompressTool(state: ReturnType<typeof createSessionState>, rawMessages: WithParts[]) {
    return createCompressMessageTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state, logger: new Logger(false), config: buildConfig(),
        prompts: { reload() {}, getRuntimePrompts() { return { compressMessage: "", compressRange: "" } } },
    } as any)
}

function makeRecallTool(state: ReturnType<typeof createSessionState>, rawMessages: WithParts[]) {
    return createRecallCompressedTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state, logger: new Logger(false), config: buildConfig(),
        prompts: { reload() {}, getRuntimePrompts() { return { recallCompressed: "", compressMessage: "", compressRange: "" } } },
    } as any)
}

function toolCtx(sessionID: string, messageID: string) {
    return { ask: async () => {}, metadata: () => {}, sessionID, messageID }
}

// ── "get" tests ─────────────────────────────────────────────────────────────

test("recall get by blockId returns original messages", async () => {
    const sessionID = `ses_recall_get_block_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()

    const compressTool = makeCompressTool(state, rawMessages)
    await compressTool.execute(
        { topic: "Auth fix", content: [
            { messageId: "m0001", topic: "User request", summary: "User asked to fix auth token bug." },
            { messageId: "m0002", topic: "Assistant finding", summary: "Found issue in token.ts line 42." },
        ]},
        toolCtx(sessionID, "msg-compress-1"),
    )

    const recallTool = makeRecallTool(state, rawMessages)
    const result = await recallTool.execute(
        { action: "get", blockId: 1 },
        toolCtx(sessionID, "msg-recall-1"),
    )

    const output = typeof result === "string" ? result : result.output
    assert.match(output, /Fix the auth bug/, "should include user message text")
    assert.match(output, /1 message/, "block 1 covers one message in message mode")
})

test("recall get by messageId returns single message", async () => {
    const sessionID = `ses_recall_get_msg_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()

    const compressTool = makeCompressTool(state, rawMessages)
    await compressTool.execute(
        { topic: "Auth fix", content: [
            { messageId: "m0001", topic: "User request", summary: "User asked to fix auth token bug." },
        ]},
        toolCtx(sessionID, "msg-compress-1"),
    )

    const recallTool = makeRecallTool(state, rawMessages)
    const result = await recallTool.execute(
        { action: "get", messageId: "m0001" },
        toolCtx(sessionID, "msg-recall-1"),
    )

    const output = typeof result === "string" ? result : result.output
    assert.match(output, /Fix the auth bug/, "should include the requested message")
    assert.match(output, /m0001/, "should show the message ref")
})

test("recall get by messageId range returns messages in range", async () => {
    const sessionID = `ses_recall_get_range_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()

    const compressTool = makeCompressTool(state, rawMessages)
    await compressTool.execute(
        { topic: "Batch", content: [
            { messageId: "m0001", topic: "Req", summary: "User request." },
            { messageId: "m0002", topic: "Resp", summary: "Assistant response." },
            { messageId: "m0003", topic: "More", summary: "More response." },
        ]},
        toolCtx(sessionID, "msg-compress-1"),
    )

    const recallTool = makeRecallTool(state, rawMessages)
    const result = await recallTool.execute(
        { action: "get", messageIdStart: "m0001", messageIdEnd: "m0002" },
        toolCtx(sessionID, "msg-recall-1"),
    )

    const output = typeof result === "string" ? result : result.output
    assert.match(output, /Fix the auth bug/, "should include m0001")
    assert.match(output, /token\.ts/, "should include m0002")
    assert.doesNotMatch(output, /Applied fix.*30m/, "should NOT include m0003")
})

test("recall get missing blockId returns error", async () => {
    const sessionID = `ses_recall_get_missing_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()

    const recallTool = makeRecallTool(state, rawMessages)
    await assert.rejects(
        () => recallTool.execute({ action: "get", blockId: 99 }, toolCtx(sessionID, "msg-recall-1")),
        /not found|does not exist|no block/i,
    )
})

test("recall get with no target returns error", async () => {
    const sessionID = `ses_recall_get_no_target_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()

    const recallTool = makeRecallTool(state, rawMessages)
    await assert.rejects(
        () => recallTool.execute({ action: "get" }, toolCtx(sessionID, "msg-recall-1")),
        /blockId.*messageId|provide.*target/i,
    )
})

// ── "search" tests ───────────────────────────────────────────────────────────

test("recall search finds text across all blocks", async () => {
    const sessionID = `ses_recall_search_all_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()

    const compressTool = makeCompressTool(state, rawMessages)
    await compressTool.execute(
        { topic: "Batch", content: [
            { messageId: "m0001", topic: "Req", summary: "User request about token." },
            { messageId: "m0002", topic: "Resp", summary: "Assistant found token.ts line 42." },
            { messageId: "m0004", topic: "DB", summary: "User asks about database pool." },
            { messageId: "m0005", topic: "Pool", summary: "Pool size is 10." },
        ]},
        toolCtx(sessionID, "msg-compress-1"),
    )

    const recallTool = makeRecallTool(state, rawMessages)
    const result = await recallTool.execute(
        { action: "search", query: "token" },
        toolCtx(sessionID, "msg-recall-1"),
    )

    const output = typeof result === "string" ? result : result.output
    assert.match(output, /token/i, "should find token mentions")
    assert.doesNotMatch(output, /database|pool size/i, "should not include non-matching messages")
})

test("recall search scoped to single blockId", async () => {
    const sessionID = `ses_recall_search_block_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()

    const compressTool = makeCompressTool(state, rawMessages)
    await compressTool.execute(
        { topic: "Batch 1", content: [
            { messageId: "m0001", topic: "Req", summary: "Fix the auth token bug." },
        ]},
        toolCtx(sessionID, "msg-compress-1"),
    )
    await compressTool.execute(
        { topic: "Batch 2", content: [
            { messageId: "m0004", topic: "DB", summary: "Check database pool." },
        ]},
        toolCtx(sessionID, "msg-compress-2"),
    )

    const recallTool = makeRecallTool(state, rawMessages)
    const result = await recallTool.execute(
        { action: "search", query: "auth", blockId: 1 },
        toolCtx(sessionID, "msg-recall-1"),
    )

    const output = typeof result === "string" ? result : result.output
    assert.match(output, /auth/i, "should find auth in block 1")
    assert.doesNotMatch(output, /database|pool/i, "should not include block 2 content")
})

test("recall search scoped to blockId range", async () => {
    const sessionID = `ses_recall_search_range_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()

    const compressTool = makeCompressTool(state, rawMessages)
    await compressTool.execute(
        { topic: "Batch 1", content: [
            { messageId: "m0001", topic: "Req", summary: "Fix the auth token bug." },
        ]},
        toolCtx(sessionID, "msg-compress-1"),
    )
    await compressTool.execute(
        { topic: "Batch 2", content: [
            { messageId: "m0002", topic: "Resp", summary: "Found issue in token.ts line 42." },
        ]},
        toolCtx(sessionID, "msg-compress-2"),
    )
    await compressTool.execute(
        { topic: "Batch 3", content: [
            { messageId: "m0004", topic: "DB", summary: "Check database pool." },
        ]},
        toolCtx(sessionID, "msg-compress-3"),
    )

    const recallTool = makeRecallTool(state, rawMessages)
    const result = await recallTool.execute(
        { action: "search", query: "token", blockIdStart: 1, blockIdEnd: 2 },
        toolCtx(sessionID, "msg-recall-1"),
    )

    const output = typeof result === "string" ? result : result.output
    assert.match(output, /token/i, "should find token in blocks 1-2")
    assert.match(output, /auth/, "should include block 1 content")
    assert.match(output, /line 42/, "should include block 2 content")
    assert.doesNotMatch(output, /database|pool/, "should not include block 3 content")
})

test("recall search with no matches returns empty result", async () => {
    const sessionID = `ses_recall_search_nomatch_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()

    const compressTool = makeCompressTool(state, rawMessages)
    await compressTool.execute(
        { topic: "Batch", content: [
            { messageId: "m0001", topic: "Req", summary: "Fix the auth token bug." },
        ]},
        toolCtx(sessionID, "msg-compress-1"),
    )

    const recallTool = makeRecallTool(state, rawMessages)
    const result = await recallTool.execute(
        { action: "search", query: "nonexistent_xyz123" },
        toolCtx(sessionID, "msg-recall-1"),
    )

    const output = typeof result === "string" ? result : result.output
    assert.match(output, /no matches|not found|0 results/i)
})

test("recall search with missing query returns error", async () => {
    const sessionID = `ses_recall_search_no_query_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()

    const recallTool = makeRecallTool(state, rawMessages)
    await assert.rejects(
        () => recallTool.execute({ action: "search" }, toolCtx(sessionID, "msg-recall-1")),
        /query.*required|provide.*query/i,
    )
})

// ── edge cases ───────────────────────────────────────────────────────────────

test("recall get deactivated block still works", async () => {
    const sessionID = `ses_recall_get_inactive_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()

    const compressTool = makeCompressTool(state, rawMessages)
    await compressTool.execute(
        { topic: "Auth fix", content: [
            { messageId: "m0001", topic: "User request", summary: "User asked to fix auth token bug." },
        ]},
        toolCtx(sessionID, "msg-compress-1"),
    )

    const block = state.prune.messages.blocksById.get(1)
    assert.ok(block, "block should exist")
    block!.active = false
    block!.deactivatedByUser = true

    const recallTool = makeRecallTool(state, rawMessages)
    const result = await recallTool.execute(
        { action: "get", blockId: 1 },
        toolCtx(sessionID, "msg-recall-1"),
    )

    const output = typeof result === "string" ? result : result.output
    assert.match(output, /Fix the auth bug/, "should retrieve from deactivated block")
})
