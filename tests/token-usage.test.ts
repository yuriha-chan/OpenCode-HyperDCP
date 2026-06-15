import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { isContextOverLimits } from "../lib/messages/inject/utils"
import { wrapCompressedSummary } from "../lib/compress/state"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock } from "../lib/state"
import { getCurrentTokenUsage } from "../lib/token-utils"

function buildConfig(maxContextLimit: number, minContextLimit = 1): PluginConfig {
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
            mode: "message",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit,
            minContextLimit,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
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

function repeatedWord(word: string, count: number): string {
    return Array.from({ length: count }, () => word).join(" ")
}

function buildCompactedMessages(): WithParts[] {
    const sessionID = "ses_compaction_token_usage"

    return [
        {
            info: {
                id: "msg-user-summary",
                role: "user",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-summary",
                    sessionID,
                    "msg-user-summary-part",
                    `[Compressed conversation section]\n${repeatedWord("summary", 120)}`,
                ),
            ],
        },
        {
            info: {
                id: "msg-assistant-summary",
                role: "assistant",
                sessionID,
                agent: "assistant",
                summary: true,
                time: { created: 2 },
                tokens: {
                    input: 86000,
                    output: 1200,
                    reasoning: 300,
                    cache: {
                        read: 5000,
                        write: 0,
                    },
                },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-assistant-summary",
                    sessionID,
                    "msg-assistant-summary-part",
                    `Compaction summary. ${repeatedWord("carry", 180)}`,
                ),
            ],
        },
        {
            info: {
                id: "msg-user-follow-up",
                role: "user",
                sessionID,
                agent: "assistant",
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-follow-up",
                    sessionID,
                    "msg-user-follow-up-part",
                    `Continue from here. ${repeatedWord("next", 40)}`,
                ),
            ],
        },
    ]
}

function buildPostCompactionAssistantMessage(): WithParts {
    const sessionID = "ses_compaction_token_usage"

    return {
        info: {
            id: "msg-assistant-post-compaction",
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created: 4 },
            tokens: {
                input: 2400,
                output: 600,
                reasoning: 150,
                cache: {
                    read: 300,
                    write: 0,
                },
            },
        } as WithParts["info"],
        parts: [
            textPart(
                "msg-assistant-post-compaction",
                sessionID,
                "msg-assistant-post-compaction-part",
                `Fresh post-compaction reply. ${repeatedWord("done", 60)}`,
            ),
        ],
    }
}

function createActiveBlock(
    blockId: number,
    summary: string,
    summaryTokens: number,
): CompressionBlock {
    return {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens,
        mode: "message",
        topic: `Summary ${blockId}`,
        batchTopic: `Summary ${blockId}`,
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: `msg-${blockId}`,
        compressMessageId: `compress-${blockId}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: blockId,
        summary,
    }
}

test("getCurrentTokenUsage returns 0 until a fresh assistant follows compaction", () => {
    const messages = buildCompactedMessages()
    const state = createSessionState()
    state.lastCompaction = 2

    assert.equal(getCurrentTokenUsage(state, messages), 0)
})

test("isContextOverLimits ignores stale summary totals and resumes with fresh reported totals", () => {
    const messages = buildCompactedMessages()
    const state = createSessionState()
    state.lastCompaction = 2

    const staleAssistantTotal = 86000 + 1200 + 300 + 5000
    assert.equal(getCurrentTokenUsage(state, messages), 0)

    const underLimit = isContextOverLimits(
        buildConfig(staleAssistantTotal - 1, 1),
        state,
        undefined,
        undefined,
        messages,
    )

    assert.equal(underLimit.overMaxLimit, false)
    assert.equal(underLimit.overMinLimit, false)

    messages.push(buildPostCompactionAssistantMessage())
    const freshReportedTotal = 2400 + 600 + 150 + 300

    assert.equal(getCurrentTokenUsage(state, messages), freshReportedTotal)

    const overLimit = isContextOverLimits(
        buildConfig(freshReportedTotal - 1, 1),
        state,
        undefined,
        undefined,
        messages,
    )

    assert.equal(overLimit.overMaxLimit, true)
})

test("isContextOverLimits extends the max threshold by active summary tokens", () => {
    const messages = buildCompactedMessages()
    messages.push(buildPostCompactionAssistantMessage())

    const state = createSessionState()
    state.lastCompaction = 2

    const storedSummary = wrapCompressedSummary(7, repeatedWord("summary", 120))
    state.prune.messages.blocksById.set(7, createActiveBlock(7, storedSummary, 1000))
    state.prune.messages.activeBlockIds.add(7)

    const freshReportedTotal = 2400 + 600 + 150 + 300

    const underExtendedLimit = isContextOverLimits(
        buildConfig(freshReportedTotal - 1, 1),
        state,
        undefined,
        undefined,
        messages,
    )

    assert.equal(underExtendedLimit.overMaxLimit, false)

    const overExtendedLimit = isContextOverLimits(
        buildConfig(freshReportedTotal - 1001, 1),
        state,
        undefined,
        undefined,
        messages,
    )

    assert.equal(overExtendedLimit.overMaxLimit, true)
})

test("isContextOverLimits does not extend the max threshold when summaryBuffer is disabled", () => {
    const messages = buildCompactedMessages()
    messages.push(buildPostCompactionAssistantMessage())

    const state = createSessionState()
    state.lastCompaction = 2

    const storedSummary = wrapCompressedSummary(7, repeatedWord("summary", 120))
    state.prune.messages.blocksById.set(7, createActiveBlock(7, storedSummary, 1000))
    state.prune.messages.activeBlockIds.add(7)

    const freshReportedTotal = 2400 + 600 + 150 + 300
    const config = buildConfig(freshReportedTotal - 1, 1)
    config.compress.summaryBuffer = false

    const overLimit = isContextOverLimits(config, state, undefined, undefined, messages)

    assert.equal(overLimit.overMaxLimit, true)
})

test("isContextOverLimits returns overNonCompressedLimit false when config is undefined", () => {
    const messages = buildCompactedMessages()
    messages.push(buildPostCompactionAssistantMessage())

    const state = createSessionState()
    state.lastCompaction = 2

    const config = buildConfig(100000, 1)

    const result = isContextOverLimits(config, state, undefined, undefined, messages)

    assert.equal(result.overNonCompressedLimit, false)
})

test("isContextOverLimits returns overNonCompressedLimit true when non-compressed tokens exceed absolute limit", () => {
    const sessionID = "ses_ncl_absolute"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-1",
                role: "user",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-1", sessionID, "p-1", repeatedWord("content", 100))],
        },
        {
            info: {
                id: "msg-2",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
                tokens: { input: 0, output: 500, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            } as WithParts["info"],
            parts: [textPart("msg-2", sessionID, "p-2", repeatedWord("response", 100))],
        },
    ]

    const state = createSessionState()
    const config = buildConfig(100000, 50000)
    config.compress.nonCompressedContextLimit = 100

    const result = isContextOverLimits(config, state, undefined, undefined, messages)

    assert.equal(result.overNonCompressedLimit, true)
})

test("isContextOverLimits returns overNonCompressedLimit false when under limit", () => {
    const sessionID = "ses_ncl_under"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-1",
                role: "user",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-1", sessionID, "p-1", "short message")],
        },
        {
            info: {
                id: "msg-2",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
                tokens: { input: 0, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            } as WithParts["info"],
            parts: [textPart("msg-2", sessionID, "p-2", "ok")],
        },
    ]

    const state = createSessionState()
    const config = buildConfig(100000, 50000)
    config.compress.nonCompressedContextLimit = 100000

    const result = isContextOverLimits(config, state, undefined, undefined, messages)

    assert.equal(result.overNonCompressedLimit, false)
})

test("isContextOverLimits excludes synthetic summary messages from non-compressed count", () => {
    const sessionID = "ses_ncl_exclude"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-1",
                role: "user",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-1", sessionID, "p-1", "short message")],
        },
        {
            info: {
                id: "msg_dcp_summary_a1b2c3d4e5f6g7h8",
                role: "user",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg_dcp_summary_a1b2c3d4e5f6g7h8",
                    sessionID,
                    "p-s",
                    repeatedWord("summary", 200),
                ),
            ],
        },
        {
            info: {
                id: "msg-3",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 3 },
                tokens: { input: 0, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            } as WithParts["info"],
            parts: [textPart("msg-3", sessionID, "p-3", "ok")],
        },
    ]

    const state = createSessionState()
    const config = buildConfig(100000, 50000)
    config.compress.nonCompressedContextLimit = 100

    const result = isContextOverLimits(config, state, undefined, undefined, messages)

    assert.equal(
        result.overNonCompressedLimit,
        false,
        "synthetic summary message should be excluded, so non-compressed count should be low",
    )
})

test("isContextOverLimits supports percentage-based nonCompressedContextLimit", () => {
    const sessionID = "ses_ncl_pct"
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-1",
                role: "user",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-1", sessionID, "p-1", repeatedWord("content", 50))],
        },
        {
            info: {
                id: "msg-2",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
                tokens: { input: 0, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            } as WithParts["info"],
            parts: [textPart("msg-2", sessionID, "p-2", repeatedWord("response", 50))],
        },
    ]

    const state = createSessionState()
    state.modelContextLimit = 100000
    const config = buildConfig(100000, 50000)
    config.compress.nonCompressedContextLimit = "0.1%"

    const result = isContextOverLimits(config, state, undefined, undefined, messages)

    assert.equal(
        result.overNonCompressedLimit,
        true,
        "0.1% of 100000 = 100, non-compressed tokens (~200) should exceed this",
    )
})
