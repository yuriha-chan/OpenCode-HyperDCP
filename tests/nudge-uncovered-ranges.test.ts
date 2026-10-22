import "./helpers/storage-env"
import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { injectCompressNudges } from "../lib/messages/inject/inject"
import { PromptStore } from "../lib/prompts/store"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock } from "../lib/state/types"
import {
    commitBlock,
    createHousekeepingHarness,
    ordinaryMessage,
    stageBlock,
    visibleText,
} from "./helpers/housekeeping"

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

test("outside-mode nudge invites entry and leave without listing pre-prune uncovered ranges", () => {
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
        new PromptStore(new Logger(false), process.cwd()).getRuntimePrompts(),
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

    assert.match(texts, /enter_housekeeping/)
    assert.match(texts, /leave_housekeeping/)
    assert.doesNotMatch(texts, /UNCOVERED MESSAGE RANGES|m\d{4}\s*→|save_summary/)
    assert.ok(texts.length < 2000, "outside-mode maintenance guidance should be concise")
})

test("active mode suppresses fresh and already anchored context, turn, and iteration nudges", async (t) => {
    for (const kind of ["context", "turn", "iteration"] as const) {
        await t.test(kind, async (t) => {
            const h = await createHousekeepingHarness(t, {
                configure(config) {
                    config.compress.minContextLimit = 0
                    config.compress.maxContextLimit = kind === "context" ? 0 : 150000
                    config.compress.iterationNudgeThreshold = kind === "iteration" ? 1 : 100
                    config.compress.nudgeFrequency = 1
                },
            })
            if (kind === "turn") h.addText("next-user", "Continue ordinary work.", "user")

            const outside = await h.render()
            const outsideText = visibleText(outside)
            assert.match(outsideText, /enter_housekeeping/)
            assert.match(outsideText, /leave_housekeeping/)
            assert.doesNotMatch(outsideText, /UNCOVERED MESSAGE RANGES|m\d{4}\s*→/)

            const anchoredIds = outside
                .filter((message) => visibleText([message]).includes("enter_housekeeping"))
                .map((message) => message.info.id)
            assert.ok(anchoredIds.length > 0)

            await h.enter()
            h.addText("maintenance-working-text", "Working on context maintenance.")
            if (kind === "turn") h.addText("maintenance-user", "Keep working.", "user")
            const active = await h.render()
            for (const id of anchoredIds) {
                const anchor = active.find((message) => message.info.id === id)
                assert.ok(anchor, "an anchored ordinary message remains visible during mode")
                assert.doesNotMatch(visibleText([anchor]), /enter_housekeeping|leave_housekeeping/)
            }
            const activeText = active
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n")
            assert.doesNotMatch(
                activeText,
                /enter_housekeeping|leave_housekeeping|UNCOVERED MESSAGE RANGES/,
            )

            await stageBlock(h)
            const staged = await h.render()
            const stagedText = staged
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n")
            assert.doesNotMatch(
                stagedText,
                /enter_housekeeping|leave_housekeeping|UNCOVERED MESSAGE RANGES/,
            )
            h.assertSessionReads()
        })
    }
})

for (const mode of ["range", "message"] as const) {
    test(`${mode} entry receives block details omitted from outside nudges`, async (t) => {
        const h = await createHousekeepingHarness(t, {
            mode,
            configure(config) {
                config.compress.maxContextLimit = 0
                config.compress.minContextLimit = 0
                config.compress.iterationNudgeThreshold = 1
                config.compress.nudgeFrequency = 1
            },
        })
        await commitBlock(h)
        h.addText("large-uncovered", "evidence ".repeat(6000))
        const outside = await h.render()
        const outsideText = visibleText(outside)
        assert.match(outsideText, /enter_housekeeping/)
        assert.doesNotMatch(
            outsideText,
            /Message priority context:|Compressed block context:|High-priority message IDs/,
        )
        const guidance = await h.enter()
        assert.match(guidance, /Active compressed blocks in this session: 1 \(b1\)/)
        assert.match(guidance, /UNCOVERED MESSAGE RANGES/)
        if (mode === "message") {
            assert.match(outsideText, /priority="high"/)
            assert.match(guidance, /High-priority message IDs[^\n]*m0005/)
        } else {
            assert.doesNotMatch(guidance, /Message priority context:/)
        }
        assert.match(guidance, /working commands/)
        assert.match(guidance, /housekeeping.*hidden|hidden.*housekeeping/is)
        h.assertSessionReads()
    })
}

test("message entry prioritizes uncovered messages without suggesting protected or already covered sources", async (t) => {
    const sessionID = "ses_entry_priority_candidates"
    const h = await createHousekeepingHarness(t, {
        mode: "message",
        messages: [
            ordinaryMessage(sessionID, "protected-user", "user", "constraint ".repeat(6000)),
            ordinaryMessage(sessionID, "covered-source", "assistant", "resolved ".repeat(6000)),
            ordinaryMessage(sessionID, "active-user", "user", "Continue."),
            ordinaryMessage(sessionID, "uncovered-source", "assistant", "findings ".repeat(6000)),
        ],
        configure(config) {
            config.compress.protectUserMessages = true
        },
    })
    await h.enter()
    await stageBlock(h, "Resolved findings.", "m0002")
    await h.leave()
    const guidance = await h.enter()
    const candidates = guidance.match(/High-priority message IDs[^\n]*/)?.[0]
    assert.ok(candidates, "entry must expose its high-priority candidate list")
    assert.match(candidates, /m0004/)
    assert.doesNotMatch(candidates, /m0001|m0002|m0003/)
    h.assertSessionReads()
})

test("message entry reports no high-priority candidates when all ordinary messages are small", async (t) => {
    const h = await createHousekeepingHarness(t, { mode: "message" })
    const guidance = await h.enter()
    assert.match(guidance, /High-priority message IDs[^\n]*none/)
    assert.match(guidance, /Active compressed blocks in this session: 0 \(none\)/)
    assert.match(guidance, /no.*(?:automatic|safe)|not.*(?:recommendation|automatically safe)/i)
    h.assertSessionReads()
})
