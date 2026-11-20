import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { prune } from "../lib/messages/prune"
import { createSessionState, type SessionState, type WithParts } from "../lib/state"
import type { CompressionBlock } from "../lib/state/types"
import {
    projectContextBlocks,
    injectContextSubagents,
    type ModelContextRequest,
} from "../lib/model-context"

const sessionID = "ses_messages_prune"

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
            protectSubagent: "metadata",
            mode: "range",
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

test("prune protects running executions after skills even without a compressed block", () => {
    const state = createSessionState()
    state.subagentExecutions = [
        {
            callingMessageId: "call-message",
            callId: "call-a",
            sessionId: "child-a",
            status: "running",
            title: "Investigate parser",
            steeringMessages: [],
        },
    ]
    state.protectedSkills = [
        {
            name: "Report",
            callId: "skill-a",
            input: { name: "Report" },
            title: "Report",
            output: "Skill instructions",
            metadata: {},
        },
    ]
    const messages = [userMessage("user", "model")]
    runPrune(state, messages)
    const skill = messages.findIndex((message) =>
        message.parts.some((part) => part.type === "tool"),
    )
    const protectedIndex = messages.findIndex((message) =>
        message.parts.some(
            (part) => part.type === "text" && part.text.includes("session: child-a"),
        ),
    )
    assert.ok(skill >= 0)
    assert.equal(protectedIndex, skill + 1)
    assert.match(JSON.stringify(messages[protectedIndex]), /status: running/)
    state.protectedSkills = []
    const withoutSkills = [userMessage("user", "model")]
    runPrune(state, withoutSkills)
    assert.match(JSON.stringify(withoutSkills[0]), /session: child-a/)
})

for (const host of ["v1", "v2"])
    test(`${host} prune retains terminal reports only from the last actually projected block`, () => {
        const state = createSessionState()
        for (const [id, anchor, termination] of [
            [9, "anchor-first", "terminal-first"],
            [2, "anchor-last", "terminal-last"],
            [20, "anchor-disabled", "terminal-disabled"],
        ] as const) {
            addSummary(state, id, anchor, `summary-${id}`)
            state.prune.messages.blocksById.get(id)!.effectiveMessageIds = [termination]
            state.subagentExecutions.push({
                callingMessageId: `call-${id}`,
                callId: `tool-${id}`,
                sessionId: `child-${id}`,
                title: `Execution ${id}`,
                status: "completed",
                steeringMessages: [],
                terminationMessageId: termination,
                report: `DELIVERED_${id}`,
            })
        }
        state.prune.messages.blocksById.get(20)!.activeVersionIndex = 0
        const config = buildConfig()
        config.compress.protectSubagent = "full"
        const messages = [
            userMessage("user", "model"),
            assistantMessage("anchor-first"),
            assistantMessage("anchor-last"),
            assistantMessage("anchor-disabled"),
        ]
        if (host === "v1") {
            prune(state, new Logger(false), config, messages)
            const protection = messages
                .flatMap((message) =>
                    message.parts.filter(
                        (part) => part.type === "text" && part.text.includes("Subagent execution"),
                    ),
                )
                .map((part) => (part as { text: string }).text)
                .join("\n")
            assert.match(protection, /DELIVERED_2/)
            assert.doesNotMatch(protection, /DELIVERED_9|DELIVERED_20/)
            return
        }
        const request: ModelContextRequest = {
            messages: [
                { id: "user", role: "user", content: [{ type: "text", text: "Continue" }] },
                ...["anchor-first", "anchor-last", "anchor-disabled"].map((id) => ({
                    id,
                    role: "assistant" as const,
                    content: [{ type: "text" as const, text: id }],
                })),
            ],
            options: {},
        }
        const lastSummary = projectContextBlocks(request, state, new Logger(false), config)
        injectContextSubagents(request, state, config, lastSummary)
        const nativeProtection = request.messages.find(
            (message) => message.id === "msg_dcp_subagents",
        )
        assert.match(JSON.stringify(nativeProtection), /DELIVERED_2/)
        assert.doesNotMatch(JSON.stringify(nativeProtection), /DELIVERED_9|DELIVERED_20/)
        injectContextSubagents(
            request,
            state,
            { ...config, compress: { ...config.compress, protectSubagent: "none" } },
            lastSummary,
        )
        assert.equal(
            request.messages.some((message) => message.id === "msg_dcp_subagents"),
            false,
        )
    })

function textPart(id: string, text: string, extra: Record<string, unknown> = {}) {
    return {
        id,
        messageID: id,
        sessionID,
        type: "text" as const,
        text,
        ...extra,
    }
}

function userMessage(
    id: string,
    modelID: string,
    options: { empty?: boolean; ignored?: boolean } = {},
): WithParts {
    const parts = options.empty
        ? []
        : [textPart(`${id}-part`, `user ${id}`, options.ignored ? { ignored: true } : {})]

    return {
        info: {
            id,
            role: "user",
            sessionID,
            agent: `agent-${modelID}`,
            model: { providerID: "test", modelID },
            time: { created: 1 },
        } as WithParts["info"],
        parts: parts as WithParts["parts"],
    }
}

function assistantMessage(id: string): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [textPart(`${id}-part`, `assistant ${id}`)],
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
        anchorMessageId: "anchor",
        compressMessageId: "origin",
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

function addSummary(
    state: SessionState,
    blockId: number,
    anchorMessageId: string,
    summary: string,
): void {
    state.prune.messages.blocksById.set(blockId, makeBlock({ blockId, anchorMessageId, summary }))
    state.prune.messages.activeByAnchorMessageId.set(anchorMessageId, blockId)
    state.prune.messages.activeBlockIds.add(blockId)
}

function markPruned(state: SessionState, messageId: string): void {
    state.prune.messages.byMessageId.set(messageId, {
        tokenCount: 1,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
}

function syntheticMessages(messages: WithParts[], text: string): WithParts[] {
    return messages.filter(
        (message) =>
            message.info.id.startsWith("msg_dcp_summary") &&
            message.parts.some((part) => part.type === "text" && part.text === text),
    )
}

function syntheticModel(message: WithParts): string | undefined {
    return (message.info as { model?: { modelID?: string } }).model?.modelID
}

function runPrune(state: SessionState, messages: WithParts[]): void {
    prune(state, new Logger(false), buildConfig(), messages)
}

test("prune summary skips empty and ignored user messages", () => {
    const state = createSessionState()
    const messages: WithParts[] = [
        userMessage("user-eligible", "model-eligible"),
        userMessage("user-ignored", "model-ignored", { ignored: true }),
        userMessage("user-empty", "model-empty", { empty: true }),
        assistantMessage("assistant-1"),
        assistantMessage("anchor-1"),
    ]
    addSummary(state, 1, "anchor-1", "summary after ignored users")
    markPruned(state, "anchor-1")

    runPrune(state, messages)

    const summaries = syntheticMessages(messages, "summary after ignored users")
    assert.equal(summaries.length, 1)
    assert.equal(syntheticModel(summaries[0]!), "model-eligible")
})

test("prune summary includes an eligible user at the anchor message", () => {
    const state = createSessionState()
    const messages: WithParts[] = [
        userMessage("user-1", "model-1"),
        assistantMessage("assistant-1"),
        userMessage("user-2", "model-2"),
    ]
    addSummary(state, 1, "user-2", "inclusive summary")

    runPrune(state, messages)

    const summaries = syntheticMessages(messages, "inclusive summary")
    assert.equal(summaries.length, 1)
    assert.equal(syntheticModel(summaries[0]!), "model-2")
    assert.equal(messages.indexOf(summaries[0]!), 2)
    assert.equal(messages[3]?.info.id, "user-2")
})

test("pruned user message still serves as the synthetic summary base", () => {
    const state = createSessionState()
    const messages: WithParts[] = [
        userMessage("user-1", "model-1"),
        assistantMessage("assistant-1"),
        userMessage("user-2", "model-2"),
        assistantMessage("assistant-2"),
        assistantMessage("anchor-1"),
    ]
    addSummary(state, 1, "anchor-1", "summary after pruned user")
    markPruned(state, "user-2")
    markPruned(state, "anchor-1")

    runPrune(state, messages)

    const summaries = syntheticMessages(messages, "summary after pruned user")
    assert.equal(summaries.length, 1)
    assert.equal(syntheticModel(summaries[0]!), "model-2")
    assert.equal(
        messages.some((message) => message.info.id === "user-2"),
        false,
    )
})

test("prune summary is skipped when no eligible user message exists", () => {
    const state = createSessionState()
    const messages: WithParts[] = [assistantMessage("assistant-1"), assistantMessage("anchor-1")]
    addSummary(state, 1, "anchor-1", "summary without user")

    runPrune(state, messages)

    assert.equal(syntheticMessages(messages, "summary without user").length, 0)
    assert.deepEqual(
        messages.map((message) => message.info.id),
        ["assistant-1", "anchor-1"],
    )
})

test("prune places multiple summaries and the memo after the last summary", () => {
    const state = createSessionState()
    const messages: WithParts[] = [
        userMessage("user-1", "model-1"),
        assistantMessage("assistant-1"),
        assistantMessage("anchor-1"),
        userMessage("user-2", "model-2"),
        assistantMessage("assistant-2"),
        assistantMessage("anchor-2"),
    ]
    state.memo = ["Remember alpha"]
    addSummary(state, 1, "anchor-1", "first summary")
    addSummary(state, 2, "anchor-2", "second summary")
    markPruned(state, "anchor-1")
    markPruned(state, "anchor-2")

    runPrune(state, messages)

    const first = syntheticMessages(messages, "first summary")
    const second = syntheticMessages(messages, "second summary")
    const memo = syntheticMessages(messages, "[Memo]\nRemember alpha")
    assert.equal(first.length, 1)
    assert.equal(second.length, 1)
    assert.equal(memo.length, 1)
    assert.equal(syntheticModel(first[0]!), "model-1")
    assert.equal(syntheticModel(second[0]!), "model-2")
    assert.equal(syntheticModel(memo[0]!), "model-2")
    assert.deepEqual(
        messages.map((message) => message.info.id),
        [
            "user-1",
            "assistant-1",
            first[0]!.info.id,
            "user-2",
            "assistant-2",
            second[0]!.info.id,
            memo[0]!.info.id,
        ],
    )
})

test("prune unshifts the memo when no summary is injected", () => {
    const state = createSessionState()
    const messages: WithParts[] = [
        userMessage("user-1", "model-1"),
        assistantMessage("assistant-1"),
    ]
    state.memo = ["Remember beta"]

    runPrune(state, messages)

    const memo = syntheticMessages(messages, "[Memo]\nRemember beta")
    assert.equal(memo.length, 1)
    assert.equal(syntheticModel(memo[0]!), "model-1")
    assert.deepEqual(
        messages.map((message) => message.info.id),
        [memo[0]!.info.id, "user-1", "assistant-1"],
    )
})

test("prune keeps first-occurrence lookup for a repeated message object", () => {
    const state = createSessionState()
    const repeated = assistantMessage("assistant-repeat")
    const messages: WithParts[] = [
        userMessage("user-1", "model-1"),
        repeated,
        userMessage("user-2", "model-2"),
        repeated,
    ]
    addSummary(state, 1, "assistant-repeat", "repeated anchor summary")
    markPruned(state, "assistant-repeat")

    runPrune(state, messages)

    const summaries = syntheticMessages(messages, "repeated anchor summary")
    assert.equal(summaries.length, 2)
    assert.equal(syntheticModel(summaries[0]!), "model-1")
    assert.equal(syntheticModel(summaries[1]!), "model-1")
    assert.deepEqual(
        messages.map((message) => message.info.id),
        ["user-1", summaries[0]!.info.id, "user-2", summaries[1]!.info.id],
    )
})
