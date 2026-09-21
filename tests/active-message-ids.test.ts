import assert from "node:assert/strict"
import test from "node:test"
import { applyCompressionState } from "../lib/compress/state"
import type { SelectionResolution } from "../lib/compress/types"
import { createChatMessageTransformHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import { syncCompressionBlocks } from "../lib/messages/sync"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock } from "../lib/state/types"
import { createPruneMessagesState, loadPruneMessagesState, serializePruneMessagesState } from "../lib/state/utils"
import type { PluginConfig } from "../lib/config"

let sessionCounter = 0
function uniqueSession(): string {
    sessionCounter += 1
    return `ses_active_ids_${process.pid}_${Date.now()}_${sessionCounter}`
}

function buildConfig(permission: "allow" | "deny" = "allow"): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: false,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission,
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            minCompressTokens: 0,
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
    }
}

function textMessage(id: string, role: "user" | "assistant", sessionID: string): WithParts {
    const info: Record<string, unknown> = {
        id,
        role,
        sessionID,
        agent: "assistant",
        time: { created: 1 },
    }
    if (role === "user") {
        info.model = { providerID: "anthropic", modelID: "claude-test" }
    }
    return {
        info: info as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID,
                type: "text",
                text: `content of ${id}`,
            },
        ],
    }
}

function makeBlock(overrides: Partial<CompressionBlock>): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        topic: "test",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-1",
        compressMessageId: "msg-1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "summary",
        summaryVersions: [],
        activeVersionIndex: 1,
        ...overrides,
    }
}

function makeSelection(messageIds: string[]): SelectionResolution {
    const first = messageIds[0] ?? "msg-1"
    const last = messageIds[messageIds.length - 1] ?? first
    return {
        startReference: { kind: "message", rawIndex: 0, messageId: first },
        endReference: { kind: "message", rawIndex: messageIds.length - 1, messageId: last },
        messageIds: [...messageIds],
        messageTokenById: new Map(messageIds.map((id) => [id, 1])),
        toolIds: [],
    }
}

function applySelection(
    state: ReturnType<typeof createSessionState>,
    messageIds: string[],
): ReturnType<typeof applyCompressionState> {
    return applyCompressionState(
        state,
        {
            topic: "t",
            batchTopic: "t",
            startId: "m0001",
            endId: "m0001",
            mode: "range",
            runId: 1,
            compressMessageId: "msg-origin",
            summaryTokens: 1,
        },
        makeSelection(messageIds),
        "msg-origin",
        1,
        "summary",
        [],
    )
}

function makeTransformHandler(state: ReturnType<typeof createSessionState>) {
    const logger = new Logger(false)
    const handler = createChatMessageTransformHandler(
        { session: { get: async () => ({}) } } as any,
        state,
        logger,
        buildConfig(),
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
    )
    return { handler, logger }
}

test("createPruneMessagesState defaults activeMessageIds to empty array", () => {
    assert.deepEqual(createPruneMessagesState().activeMessageIds, [])
})

test("createSessionState defaults activeMessageIds to empty array", () => {
    assert.deepEqual(createSessionState().prune.messages.activeMessageIds, [])
})

test("activeMessageIds survives serialize/load round trip", () => {
    const state = createSessionState()
    state.prune.messages.activeMessageIds = ["a", "b", "c"]
    const persisted = serializePruneMessagesState(state.prune.messages)
    const loaded = loadPruneMessagesState(persisted as any)
    assert.deepEqual(loaded.activeMessageIds, ["a", "b", "c"])
})

test("loadPruneMessagesState defaults activeMessageIds when field missing", () => {
    const loaded = loadPruneMessagesState({} as any)
    assert.deepEqual(loaded.activeMessageIds, [])
})

test("transform handler records activeMessageIds from output messages", async () => {
    const sessionID = uniqueSession()
    const state = createSessionState()
    const { handler } = makeTransformHandler(state)
    const output = {
        messages: [
            textMessage("assistant-1", "assistant", sessionID),
            textMessage("assistant-2", "assistant", sessionID),
        ],
    }

    await handler({}, output)

    assert.deepEqual(state.prune.messages.activeMessageIds, ["assistant-1", "assistant-2"])
})

test("transform handler captures activeMessageIds before prune removes covered messages", async () => {
    const sessionID = uniqueSession()
    const state = createSessionState()
    state.sessionId = sessionID
    const block = makeBlock({
        blockId: 1,
        anchorMessageId: "user-1",
        compressMessageId: "assistant-1",
        effectiveMessageIds: ["assistant-1"],
    })
    state.prune.messages.blocksById.set(1, block)
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.activeByAnchorMessageId.set("user-1", 1)
    state.prune.messages.byMessageId.set("assistant-1", {
        tokenCount: 1,
        allBlockIds: [1],
        activeBlockIds: [1],
    })

    const { handler } = makeTransformHandler(state)
    const output = {
        messages: [
            textMessage("user-1", "user", sessionID),
            textMessage("assistant-1", "assistant", sessionID),
        ],
    }

    await handler({}, output)

    assert.ok(state.prune.messages.activeMessageIds.includes("assistant-1"))
    assert.ok(!output.messages.some((message) => message.info.id === "assistant-1"))
})

test("applyCompressionState trims selection to activeMessageIds", () => {
    const state = createSessionState()
    state.prune.messages.activeMessageIds = ["msg-1", "msg-3"]

    const result = applySelection(state, ["msg-1", "msg-2", "msg-3"])

    const block = state.prune.messages.blocksById.get(1)
    assert.ok(block)
    assert.deepEqual(block.effectiveMessageIds, ["msg-1", "msg-3"])
    assert.deepEqual(result.messageIds, ["msg-1", "msg-3"])
})

test("applyCompressionState rejects when no selection message is on-chain", () => {
    const state = createSessionState()
    state.prune.messages.activeMessageIds = ["msg-1"]

    assert.throws(
        () => applySelection(state, ["ghost-1", "ghost-2"]),
        /active conversation branch/,
    )
})

test("applyCompressionState keeps selection when activeMessageIds is empty", () => {
    const state = createSessionState()

    const result = applySelection(state, ["msg-1", "msg-2"])

    const block = state.prune.messages.blocksById.get(1)
    assert.ok(block)
    assert.deepEqual(block.effectiveMessageIds, ["msg-1", "msg-2"])
    assert.deepEqual(result.messageIds, ["msg-1", "msg-2"])
})

test("syncCompressionBlocks deactivates block with no on-chain coverage", () => {
    const sessionID = uniqueSession()
    const state = createSessionState()
    const block = makeBlock({
        blockId: 1,
        anchorMessageId: "msg-1",
        compressMessageId: "msg-1",
        effectiveMessageIds: ["ghost-1"],
    })
    state.prune.messages.blocksById.set(1, block)
    state.prune.messages.activeBlockIds.add(1)

    syncCompressionBlocks(state, new Logger(false), [
        textMessage("msg-1", "assistant", sessionID),
    ])

    assert.equal(state.prune.messages.blocksById.get(1)?.active, false)
})

test("syncCompressionBlocks keeps block with on-chain coverage active", () => {
    const sessionID = uniqueSession()
    const state = createSessionState()
    const block = makeBlock({
        blockId: 1,
        anchorMessageId: "msg-1",
        compressMessageId: "msg-1",
        effectiveMessageIds: ["msg-1"],
    })
    state.prune.messages.blocksById.set(1, block)
    state.prune.messages.activeBlockIds.add(1)

    syncCompressionBlocks(state, new Logger(false), [
        textMessage("msg-1", "assistant", sessionID),
    ])

    assert.equal(state.prune.messages.blocksById.get(1)?.active, true)
})
