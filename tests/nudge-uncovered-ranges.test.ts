import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock } from "../lib/state/types"

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
            allowSubAgents: false,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 0,
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

function emptyPrompts(turnNudge: string) {
    return {
        system: "",
        compressRange: "",
        compressMessage: "",
        contextLimitNudge: "",
        turnNudge,
        iterationNudge: "",
    }
}

test("uncovered range nudge is computed from the pre-prune message list so seams stay separate", () => {
    const sessionID = "ses_nudge_preprune"
    const state = createSessionState()
    state.sessionId = sessionID
    state.prune.messages.blocksById.set(
        1,
        makeBlock({ blockId: 1, effectiveMessageIds: ["u1", "a1"] }),
    )
    state.prune.messages.blocksById.set(
        2,
        makeBlock({ blockId: 2, effectiveMessageIds: ["a3", "u2"] }),
    )

    const prePrune: WithParts[] = [
        textMessage("u1", "user", sessionID),
        textMessage("a1", "assistant", sessionID),
        textMessage("a2", "assistant", sessionID),
        textMessage("a3", "assistant", sessionID),
        textMessage("a4", "assistant", sessionID),
        textMessage("u2", "user", sessionID),
    ]
    const postPrune: WithParts[] = [prePrune[2]!, prePrune[4]!, prePrune[5]!]

    injectCompressNudges(
        state,
        buildConfig(),
        new Logger(false),
        postPrune,
        emptyPrompts("Base turn nudge"),
        undefined,
        prePrune,
    )

    const texts = postPrune
        .flatMap((message) =>
            message.parts
                .filter((part) => part.type === "text")
                .map((part) => (part as { text: string }).text),
        )
        .join("\n")

    assert.match(texts, /UNCOVERED MESSAGE RANGES/)
    assert.match(texts, /m0003 → m0003/)
    assert.match(texts, /m0005 → m0005/)
    assert.doesNotMatch(texts, /m0003 → m0005/)
})
