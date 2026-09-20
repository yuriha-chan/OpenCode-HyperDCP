import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { createCompressRangeTool } from "../lib/compress/range"
import { createExpandBlockTool } from "../lib/expand-block"
import { createSessionState, type CompressionBlock, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { syncCompressionBlocks } from "../lib/messages/sync"
import { prune } from "../lib/messages/prune"

const testDataHome = join(tmpdir(), `opencode-dcp-expand-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-expand-config-tests-${process.pid}`)

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
            allowSubAgents: true,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
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

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function buildMessages(sessionID: string): WithParts[] {
    const messages: WithParts[] = []
    for (let index = 1; index <= 6; index++) {
        const messageID = `msg-${index}`
        messages.push({
            info: {
                id: messageID,
                role: index % 2 === 1 ? "user" : "assistant",
                sessionID,
                agent: "assistant",
                ...(index % 2 === 1
                    ? { model: { providerID: "anthropic", modelID: "claude-test" } }
                    : {}),
                time: { created: index },
            } as WithParts["info"],
            parts: [textPart(messageID, sessionID, `part-${index}`, `message ${index}`)],
        })
    }

    messages.push({
        info: {
            id: "msg-compress",
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created: 7 },
        } as WithParts["info"],
        parts: [textPart("msg-compress", sessionID, "part-compress", "compressed earlier range")],
    })

    return messages
}

function buildToolContext(
    state: ReturnType<typeof createSessionState>,
    config: PluginConfig,
    rawMessages: WithParts[],
) {
    return {
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger: new Logger(false),
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressRange: "", compressMessage: "" }
            },
        },
    } as any
}

const toolRunContext = {
    ask: async () => {},
    metadata: () => {},
}

test("expand_block covers newly added messages and prune removes them", async () => {
    const sessionID = `ses_expand_block_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const config = buildConfig()
    const ctx = buildToolContext(state, config, rawMessages)

    const compressTool = createCompressRangeTool(ctx)
    await compressTool.execute(
        {
            topic: "Initial range",
            content: [
                {
                    startId: "m0001",
                    endId: "m0003",
                    summary: "Captured messages one through three.",
                },
            ],
        },
        {
            ...toolRunContext,
            sessionID,
            messageID: "msg-compress",
        },
    )

    const block = Array.from(state.prune.messages.blocksById.values())[0] as CompressionBlock
    assert.ok(block)
    assert.equal(state.prune.messages.byMessageId.get("msg-4"), undefined)

    const expandTool = createExpandBlockTool(ctx)
    await expandTool.execute(
        {
            blockId: block.blockId,
            endId: "m0006",
        },
        {
            ...toolRunContext,
            sessionID,
            messageID: "msg-expand",
        },
    )

    assert.deepEqual(block.effectiveMessageIds, [
        "msg-1",
        "msg-2",
        "msg-3",
        "msg-4",
        "msg-5",
        "msg-6",
    ])

    syncCompressionBlocks(state, ctx.logger, rawMessages)

    for (const messageId of ["msg-4", "msg-5", "msg-6"]) {
        const entry = state.prune.messages.byMessageId.get(messageId)
        assert.ok(entry, `expected a byMessageId entry for ${messageId}`)
        assert.ok(
            entry.activeBlockIds.includes(block.blockId),
            `expected ${messageId} to be actively covered by block ${block.blockId}`,
        )
    }

    const output = rawMessages.map(
        (message) =>
            ({
                info: message.info,
                parts: message.parts.map((part) => ({ ...part })),
            }) as WithParts,
    )
    prune(state, ctx.logger, config, output)

    const remainingIds = output.map((message) => message.info.id)
    for (const messageId of ["msg-1", "msg-2", "msg-3", "msg-4", "msg-5", "msg-6"]) {
        assert.ok(
            !remainingIds.includes(messageId),
            `expected ${messageId} to be replaced by the block summary`,
        )
    }
})
