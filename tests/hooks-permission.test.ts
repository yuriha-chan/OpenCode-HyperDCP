import "./helpers/storage-env"
import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import {
    createChatMessageTransformHandler,
    createCommandExecuteHandler,
    createEventHandler,
    createSystemPromptHandler,
    createTextCompleteHandler,
} from "../lib/hooks"
import { Logger } from "../lib/logger"
import {
    createSessionState,
    ensureSessionInitialized,
    saveSessionState,
    type WithParts,
} from "../lib/state"
import {
    commitBlock,
    createHousekeepingHarness,
    ordinaryMessage,
    stageBlock,
    visibleText,
} from "./helpers/housekeeping"

function buildConfig(permission: "allow" | "ask" | "deny" = "allow"): PluginConfig {
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
            permission,
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

function buildMessage(id: string, role: "user" | "assistant", text: string): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: "session-1",
            agent: "assistant",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID: "session-1",
                type: "text",
                text,
            },
        ],
    }
}

test("system prompt handler caches full model context for percentage thresholds", async () => {
    const state = createSessionState()
    const handler = createSystemPromptHandler(state, new Logger(false), buildConfig("deny"), {
        reload() {},
        getRuntimePrompts() {
            return {} as any
        },
    } as any)

    await handler(
        {
            sessionID: "session-1",
            model: {
                limit: {
                    context: 200000,
                    output: 131072,
                },
            },
        } as any,
        { system: ["base system"] },
    )

    assert.equal(state.modelContextLimit, 200000)
})

test("chat message transform strips hallucinated tags even when compress is denied", async () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig("deny")
    const handler = createChatMessageTransformHandler(
        { session: { get: async () => ({}) } } as any,
        state,
        logger,
        config,
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
    )
    const output = {
        messages: [buildMessage("assistant-1", "assistant", "alpha <dcp>beta</dcp> omega")],
    }

    await handler({}, output)

    assert.equal(output.messages[0]?.parts[0]?.type, "text")
    assert.equal((output.messages[0]?.parts[0] as any).text, "alpha  omega")
})

test("chat message transform drops messages without info instead of crashing", async () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig("deny")
    const handler = createChatMessageTransformHandler(
        { session: { get: async () => ({}) } } as any,
        state,
        logger,
        config,
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
    )
    const output = {
        messages: [
            {
                role: "user",
                time: 1,
                parts: [
                    {
                        type: "text",
                        text: "Carica le skill di laravel",
                    },
                ],
            } as any,
        ],
    }

    await handler({}, output as any)

    assert.equal(state.sessionId, null)
    assert.equal(output.messages.length, 0)
})

test("command execute exits after effective permission resolves to deny", async () => {
    let sessionMessagesCalls = 0
    const output = { parts: [] as any[] }
    const handler = createCommandExecuteHandler(
        {
            session: {
                messages: async () => {
                    sessionMessagesCalls += 1
                    return { data: [] }
                },
            },
        } as any,
        createSessionState(),
        new Logger(false),
        buildConfig("deny"),
        "/tmp",
        { global: undefined, agents: {} },
    )

    await handler({ command: "dcp", sessionID: "session-1", arguments: "context" }, output)

    assert.equal(sessionMessagesCalls, 1)
    assert.deepEqual(output.parts, [])
})

test("text complete strips hallucinated metadata tags", async () => {
    const output = { text: "alpha <dcp>beta</dcp> omega" }
    const handler = createTextCompleteHandler()

    await handler({ sessionID: "session-1", messageID: "message-1", partID: "part-1" }, output)

    assert.equal(output.text, "alpha  omega")
})

test("event hook attaches durations to matching blocks by message and call id", async () => {
    const state = createSessionState()
    state.sessionId = "session-1"
    const handler = createEventHandler(state, new Logger(false))
    const originalNow = Date.now
    Date.now = () => 100

    try {
        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-1",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "pending",
                            input: {},
                            raw: "",
                        },
                    },
                },
            },
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-2",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "pending",
                            input: {},
                            raw: "",
                        },
                    },
                },
            },
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-1",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "running",
                            input: {},
                            time: { start: 325 },
                        },
                    },
                },
            },
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-2",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "running",
                            input: {},
                            time: { start: 410 },
                        },
                    },
                },
            },
        })
        state.prune.messages.blocksById.set(1, {
            blockId: 1,
            runId: 1,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 0,
            summaryTokens: 0,
            durationMs: 0,
            mode: "message",
            topic: "one",
            batchTopic: "one",
            startId: "m0001",
            endId: "m0001",
            anchorMessageId: "msg-a",
            compressMessageId: "message-1",
            compressCallId: "call-1",
            includedBlockIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            directMessageIds: [],
            directToolIds: [],
            effectiveMessageIds: ["msg-a"],
            effectiveToolIds: [],
            createdAt: 1,
            summary: "a",
        })
        state.prune.messages.blocksById.set(2, {
            blockId: 2,
            runId: 2,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 0,
            summaryTokens: 0,
            durationMs: 0,
            mode: "message",
            topic: "two",
            batchTopic: "two",
            startId: "m0002",
            endId: "m0002",
            anchorMessageId: "msg-b",
            compressMessageId: "message-1",
            compressCallId: "call-2",
            includedBlockIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            directMessageIds: [],
            directToolIds: [],
            effectiveMessageIds: ["msg-b"],
            effectiveToolIds: [],
            createdAt: 2,
            summary: "b",
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-2",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "completed",
                            input: {},
                            output: "done",
                            title: "",
                            metadata: {},
                            time: { start: 410, end: 500 },
                        },
                    },
                },
            },
        })

        await handler({
            event: {
                type: "message.part.updated",
                properties: {
                    part: {
                        type: "tool",
                        tool: "compress",
                        callID: "call-1",
                        messageID: "message-1",
                        sessionID: "session-1",
                        state: {
                            status: "completed",
                            input: {},
                            output: "done",
                            title: "",
                            metadata: {},
                            time: { start: 325, end: 500 },
                        },
                    },
                },
            },
        })
    } finally {
        Date.now = originalNow
    }

    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 225)
    assert.equal(state.prune.messages.blocksById.get(2)?.durationMs, 310)
})

test("event hook falls back to completed runtime when running duration missing", async () => {
    const state = createSessionState()
    state.sessionId = "session-1"
    const handler = createEventHandler(state, new Logger(false))

    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "one",
        batchTopic: "one",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-a",
        compressMessageId: "message-1",
        compressCallId: "call-3",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-a"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "a",
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-3",
                    messageID: "message-1",
                    sessionID: "session-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time: { start: 500, end: 940 },
                    },
                },
            },
        },
    })

    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 440)
})

test("event hook queues duration updates until the matching session is loaded", async () => {
    const logger = new Logger(false)
    const targetSessionId = `session-target-${process.pid}-${Date.now()}`
    const otherSessionId = `session-other-${process.pid}-${Date.now()}`
    const persistedState = createSessionState()
    persistedState.sessionId = targetSessionId
    persistedState.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "one",
        batchTopic: "one",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-a",
        compressMessageId: "message-1",
        compressCallId: "call-remote",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-a"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "a",
    })
    await saveSessionState(persistedState, logger)

    const liveState = createSessionState()
    liveState.sessionId = otherSessionId
    const handler = createEventHandler(liveState, logger)

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                sessionID: targetSessionId,
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-remote",
                    messageID: "message-1",
                    state: {
                        status: "pending",
                        input: {},
                        raw: "",
                    },
                },
            },
            time: 100,
        },
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                sessionID: targetSessionId,
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-remote",
                    messageID: "message-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time: { start: 350, end: 500 },
                    },
                },
            },
        },
    })

    assert.equal(liveState.compressionTiming.pendingByCallId.has("message-1:call-remote"), true)
    assert.equal(liveState.compressionTiming.startsByCallId.has("message-1:call-remote"), false)

    await ensureSessionInitialized(
        {
            session: {
                get: async () => ({ data: { parentID: null } }),
            },
        } as any,
        liveState,
        targetSessionId,
        logger,
        [
            {
                info: {
                    id: "msg-user-1",
                    role: "user",
                    sessionID: targetSessionId,
                    agent: "assistant",
                    time: { created: 1 },
                } as WithParts["info"],
                parts: [],
            },
        ],
        false,
    )

    assert.equal(liveState.prune.messages.blocksById.get(1)?.durationMs, 250)
    assert.equal(liveState.compressionTiming.pendingByCallId.has("message-1:call-remote"), false)
})

test("event hook keeps same call id distinct across message ids", async () => {
    const state = createSessionState()
    state.sessionId = "session-1"
    const handler = createEventHandler(state, new Logger(false))

    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "one",
        batchTopic: "one",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-a",
        compressMessageId: "message-1",
        compressCallId: "shared-call",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-a"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "a",
    })
    state.prune.messages.blocksById.set(2, {
        blockId: 2,
        runId: 2,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        mode: "message",
        topic: "two",
        batchTopic: "two",
        startId: "m0002",
        endId: "m0002",
        anchorMessageId: "msg-b",
        compressMessageId: "message-2",
        compressCallId: "shared-call",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-b"],
        effectiveToolIds: [],
        createdAt: 2,
        summary: "b",
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "shared-call",
                    messageID: "message-1",
                    sessionID: "session-1",
                    state: {
                        status: "pending",
                        input: {},
                        raw: "",
                    },
                },
            },
            time: 100,
        },
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "shared-call",
                    messageID: "message-2",
                    sessionID: "session-1",
                    state: {
                        status: "pending",
                        input: {},
                        raw: "",
                    },
                },
            },
            time: 200,
        },
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "shared-call",
                    messageID: "message-2",
                    sessionID: "session-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time: { start: 350, end: 500 },
                    },
                },
            },
        },
    })

    await handler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "shared-call",
                    messageID: "message-1",
                    sessionID: "session-1",
                    state: {
                        status: "completed",
                        input: {},
                        output: "done",
                        title: "",
                        metadata: {},
                        time: { start: 450, end: 700 },
                    },
                },
            },
        },
    })

    assert.equal(state.prune.messages.blocksById.get(1)?.durationMs, 350)
    assert.equal(state.prune.messages.blocksById.get(2)?.durationMs, 150)
})

function modelToolPart(messages: WithParts[], callID: string) {
    const part = messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.callID === callID)
    assert.ok(part?.type === "tool", `expected retained tool call ${callID}`)
    assert.equal(part.state.status, "completed")
    return part
}

test("chat transform retains paired boundaries and outside parts while hiding completed housekeeping work", async (t) => {
    const h = await createHousekeepingHarness(t, { allowedTools: ["custom_inspect"] })
    h.addText("mixed-boundaries", "Outside text before entry.")
    const mixed = h.history.at(-1)!
    const entry = await h.run(
        "enter_housekeeping",
        {},
        {
            messageID: mixed.info.id,
            callID: "mixed-enter",
        },
    )
    mixed.parts.push({
        id: "interior-reasoning",
        messageID: mixed.info.id,
        sessionID: h.sessionID,
        type: "reasoning",
        text: "Private maintenance reasoning.",
        time: { start: 1, end: 2 },
    })
    mixed.parts.push(
        ...ordinaryMessage(
            h.sessionID,
            mixed.info.id,
            "assistant",
            "Private maintenance text.",
        ).parts.map((part) => ({ ...part, id: "interior-text" })),
    )
    await h.run(
        "compress",
        {
            topic: "Parser",
            content: [{ startId: "m0001", endId: "m0002", summary: "Published parser findings." }],
        },
        { messageID: mixed.info.id, callID: "mixed-compress" },
    )
    await h.run(
        "recall_compressed",
        { action: "get", messageId: "m0001" },
        {
            messageID: mixed.info.id,
            callID: "mixed-recall",
        },
    )
    mixed.parts.push({
        id: "interior-exception",
        messageID: mixed.info.id,
        sessionID: h.sessionID,
        type: "tool",
        tool: "custom_inspect",
        callID: "mixed-exception",
        state: {
            status: "completed",
            input: {},
            output: "Private exception-tool result.",
            title: "custom_inspect",
            metadata: {},
            time: { start: 1, end: 2 },
        },
    })

    const active = await h.render()
    assert.match(visibleText(active), /Private maintenance reasoning\./)
    assert.match(visibleText(active), /Private maintenance text\./)
    assert.match(visibleText(active), /Private exception-tool result\./)
    const activeEntry = modelToolPart(active, "mixed-enter")
    assert.ok(activeEntry.state.status === "completed")
    assert.equal(activeEntry.state.output, entry)

    const receipt = await h.run(
        "leave_housekeeping",
        {},
        {
            messageID: mixed.info.id,
            callID: "mixed-leave",
        },
    )
    mixed.parts.push(
        ...ordinaryMessage(
            h.sessionID,
            mixed.info.id,
            "assistant",
            "Outside text after leave.",
        ).parts.map((part) => ({ ...part, id: "outside-after" })),
    )
    const raw = structuredClone(h.history)
    const projected = await h.render()
    const text = visibleText(projected)
    assert.match(text, /Outside text before entry\./)
    assert.match(text, /Outside text after leave\./)
    assert.match(text, /Published parser findings\./)
    assert.doesNotMatch(text, /Private maintenance|Private exception-tool result/)
    const entryPart = modelToolPart(projected, "mixed-enter")
    const leavePart = modelToolPart(projected, "mixed-leave")
    assert.equal(entryPart.id, "part-mixed-enter")
    assert.equal(leavePart.id, "part-mixed-leave")
    assert.equal(entryPart.tool, "enter_housekeeping")
    assert.equal(leavePart.tool, "leave_housekeeping")
    assert.ok(entryPart.state.status === "completed")
    assert.ok(leavePart.state.status === "completed")
    assert.ok(entryPart.state.output.trim().length <= 160)
    assert.match(entryPart.state.output, /completed|finished|hidden|omitted/i)
    assert.notEqual(entryPart.state.output, entry)
    assert.doesNotMatch(
        entryPart.state.output,
        /UNCOVERED MESSAGE RANGES|m\d{4}\s*→|enter_housekeeping|leave_housekeeping|compress|edit_memo|rewrite_summary|range|guidance/i,
    )
    assert.equal(leavePart.state.output, receipt)
    const parts = projected.flatMap((message) => message.parts)
    for (const id of [
        "interior-reasoning",
        "interior-text",
        "part-mixed-compress",
        "part-mixed-recall",
        "interior-exception",
    ]) {
        assert.ok(!parts.some((part) => part.id === id), `${id} must be suppressed`)
    }
    assert.deepEqual(h.history, raw, "model projection must preserve the raw host transcript")
    h.assertSessionReads()
})

test("chat transform keeps older completed interiors hidden through later entry and leave", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.run("enter_housekeeping", {}, { callID: "first-enter" })
    h.addText("first-interior", "First private maintenance discussion.")
    const firstReceipt = await h.run("leave_housekeeping", {}, { callID: "first-leave" })
    h.addText("between-transactions", "Ordinary text between transactions.", "user")

    const secondGuidance = await h.run("enter_housekeeping", {}, { callID: "second-enter" })
    assert.doesNotMatch(secondGuidance, /First private maintenance discussion/)
    h.addText("second-interior", "Second private maintenance discussion.")
    const active = await h.render()
    assert.doesNotMatch(visibleText(active), /First private maintenance discussion/)
    assert.match(visibleText(active), /Second private maintenance discussion/)
    assert.match(visibleText(active), /Ordinary text between transactions/)
    modelToolPart(active, "first-enter")
    const oldLeave = modelToolPart(active, "first-leave")
    assert.ok(oldLeave.state.status === "completed")
    assert.equal(oldLeave.state.output, firstReceipt)

    await h.run("leave_housekeeping", {}, { callID: "second-leave" })
    const completed = structuredClone(h.history)
    for (let render = 0; render < 2; render++) {
        const projected = await h.render()
        assert.doesNotMatch(visibleText(projected), /First private|Second private/)
        assert.match(visibleText(projected), /Ordinary text between transactions/)
        for (const callID of ["first-enter", "first-leave", "second-enter", "second-leave"]) {
            modelToolPart(projected, callID)
            assert.equal(
                projected
                    .flatMap((message) => message.parts)
                    .filter((part) => part.type === "tool" && part.callID === callID).length,
                1,
            )
        }
    }
    h.setHistory(
        completed.filter(
            (message) =>
                !message.parts.some(
                    (part) => part.type === "tool" && part.callID === "second-leave",
                ),
        ),
    )
    const reopened = await h.render()
    assert.doesNotMatch(visibleText(reopened), /First private maintenance discussion/)
    assert.match(visibleText(reopened), /Second private maintenance discussion/)
    modelToolPart(reopened, "first-enter")
    modelToolPart(reopened, "first-leave")

    h.setHistory(completed)
    assert.doesNotMatch(visibleText(await h.render()), /First private|Second private/)
    h.assertSessionReads()
})

test("chat transform reconciles part-level leave removal, earlier draft history, and unrevert", async (t) => {
    const h = await createHousekeepingHarness(t)
    h.addText("surviving-boundary-message", "Ordinary text before the transaction.")
    const beforeEntry = structuredClone(h.history)
    const mixed = h.history.at(-1)!
    await h.run("enter_housekeeping", {}, { messageID: mixed.info.id, callID: "revert-enter" })
    await h.run(
        "edit_memo",
        { oldString: "", newString: "Draft memo first." },
        {
            messageID: mixed.info.id,
            callID: "revert-edit-first",
        },
    )
    mixed.parts.push(
        ...ordinaryMessage(
            h.sessionID,
            mixed.info.id,
            "assistant",
            "Surviving private draft work.",
        ).parts.map((part) => ({ ...part, id: "surviving-draft-text" })),
    )
    const earlierDraft = structuredClone(h.history)
    await h.run(
        "edit_memo",
        { oldString: "first", newString: "second" },
        {
            messageID: mixed.info.id,
            callID: "revert-edit-second",
        },
    )
    const receipt = await h.run(
        "leave_housekeeping",
        {},
        {
            messageID: mixed.info.id,
            callID: "revert-leave",
        },
    )
    const completed = structuredClone(h.history)
    assert.doesNotMatch(visibleText(await h.render()), /Surviving private draft work/)

    h.setHistory(
        completed.map((message) => ({
            ...message,
            parts: message.parts.filter(
                (part) => part.type !== "tool" || part.callID !== "revert-leave",
            ),
        })),
    )
    const reopened = await h.render()
    assert.ok(reopened.some((message) => message.info.id === mixed.info.id))
    assert.match(visibleText(reopened), /Surviving private draft work/)
    assert.ok(
        !reopened
            .flatMap((message) => message.parts)
            .some((part) => part.type === "tool" && part.callID === "revert-leave"),
    )
    assert.equal(await h.readMemo(), "Draft memo second.")
    await assert.rejects(h.enter(), /already|recursive|active/i)

    h.setHistory(earlierDraft)
    assert.match(visibleText(await h.render()), /Surviving private draft work/)
    assert.equal(await h.readMemo(), "Draft memo first.")

    h.setHistory(beforeEntry)
    assert.doesNotMatch(visibleText(await h.render()), /Surviving private draft work/)
    assert.doesNotMatch(await h.readMemo(), /Draft memo/)

    h.setHistory(completed)
    for (let render = 0; render < 2; render++) {
        const restored = await h.render()
        assert.doesNotMatch(visibleText(restored), /Surviving private draft work/)
        assert.match(visibleText(restored), /Ordinary text before the transaction/)
        const leave = modelToolPart(restored, "revert-leave")
        assert.ok(leave.state.status === "completed")
        assert.equal(leave.state.output, receipt)
        assert.equal(
            restored
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "tool" && part.callID === "revert-leave").length,
            1,
        )
    }
    assert.equal(await h.readMemo(), "Draft memo second.")
    h.assertSessionReads()
})

test("reverting housekeeping transactions follows surviving transcript prefixes", async (t) => {
    const h = await createHousekeepingHarness(t)
    await commitBlock(h, "Original committed summary.")
    const original = structuredClone(h.history)

    await h.run("enter_housekeeping", {}, { callID: "a-enter" })
    await h.run("edit_memo", { oldString: "", newString: "Memo A." }, { callID: "a-memo" })
    await h.run("rewrite_summary", { blockId: 1, summary: "Summary A." }, { callID: "a-rewrite" })
    await h.run("leave_housekeeping", {}, { callID: "a-leave" })
    const transactionA = structuredClone(h.history)

    await h.run("enter_housekeeping", {}, { callID: "b-enter" })
    await h.run(
        "edit_memo",
        { oldString: "Memo A.", newString: "Memo A and B." },
        { callID: "b-memo" },
    )
    await h.run("rewrite_summary", { blockId: 1, summary: "Summary B." }, { callID: "b-rewrite" })
    const bLeave = await h.run("leave_housekeeping", {}, { callID: "b-leave" })
    const bothCommitted = structuredClone(h.history)
    const bVersions = await h.versions(1)

    h.setHistory(
        bothCommitted.filter(
            (message) =>
                !message.parts.some((part) => part.type === "tool" && part.callID === "b-leave"),
        ),
    )
    const reopenedB = await h.render()
    assert.match(visibleText(reopenedB), /Summary A\./)
    assert.doesNotMatch(visibleText(reopenedB), /Summary B\./)
    assert.equal(await h.readMemo(), "Memo A and B.")
    assert.match(await h.versions(1), /Summary B\./)
    await assert.rejects(h.guard("read"), /housekeeping/i)

    h.setHistory(transactionA)
    const revertedB = await h.render()
    assert.match(visibleText(revertedB), /Summary A\./)
    assert.doesNotMatch(visibleText(revertedB), /Summary B\./)
    assert.equal(await h.readMemo(), "Memo A.")
    assert.doesNotMatch(await h.versions(1), /Summary B\./)

    h.setHistory(original)
    const revertedBoth = await h.render()
    assert.match(visibleText(revertedBoth), /Original committed summary\./)
    assert.doesNotMatch(visibleText(revertedBoth), /Summary A\.|Summary B\./)
    assert.equal(await h.readMemo(), "(memo is empty)")

    h.setHistory(bothCommitted)
    for (let render = 0; render < 2; render++) {
        const restored = await h.render()
        assert.match(visibleText(restored), /Summary B\./)
        assert.equal(await h.readMemo(), "Memo A and B.")
        assert.equal(await h.versions(1), bVersions)
        const leave = modelToolPart(restored, "b-leave")
        assert.ok(leave.state.status === "completed")
        assert.equal(leave.state.output, bLeave)
        assert.equal(
            restored
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "tool" && part.callID === "b-leave").length,
            1,
        )
    }
    h.assertSessionReads()
})

test("reverting housekeeping preserves an unrelated surviving command revision", async (t) => {
    const h = await createHousekeepingHarness(t)
    await commitBlock(h, "Committed parser summary.")
    await h.command("edit 1 Unrelated-command-revision.")
    assert.match(await h.versions(1, 1), /Unrelated-command-revision\./)
    const beforeTransaction = structuredClone(h.history)

    await h.enter()
    await h.run("rewrite_summary", { blockId: 1, summary: "Staged transaction rewrite." })
    await h.leave()
    const committed = structuredClone(h.history)

    h.setHistory(beforeTransaction)
    await h.render()

    assert.match(await visibleText(await h.render()), /Unrelated-command-revision\./)
    assert.equal(await h.readMemo(), "(memo is empty)")
    h.setHistory(committed)
    await h.render()
    assert.match(await h.versions(1, 1), /Unrelated-command-revision\./)
    h.assertSessionReads()
})

test("reopened transaction keeps newly staged edits across repeated reconciliation renders", async (t) => {
    const h = await createHousekeepingHarness(t)
    h.addText("reopen-anchor", "Ordinary work survives beside housekeeping.")
    const messageID = h.history.at(-1)!.info.id
    await h.run("enter_housekeeping", {}, { messageID, callID: "reopen-entry" })
    await h.run(
        "edit_memo",
        { oldString: "", newString: "First draft." },
        { messageID, callID: "reopen-first" },
    )
    await h.run("leave_housekeeping", {}, { messageID, callID: "reopen-leave" })
    const completed = structuredClone(h.history)
    h.setHistory(
        completed.map((message) => ({
            ...message,
            parts: message.parts.filter(
                (part) => part.type !== "tool" || part.callID !== "reopen-leave",
            ),
        })),
    )

    await h.render()
    assert.equal(await h.readMemo(), "First draft.")
    await h.run(
        "edit_memo",
        { oldString: "First", newString: "Reopened" },
        { messageID, callID: "reopen-second" },
    )
    for (let index = 0; index < 3; index++) {
        await h.render()
        assert.equal(await h.readMemo(), "Reopened draft.")
    }
    await h.leave()
    h.assertSessionReads()
})

test("host compaction without transaction calls does not reconcile them as reverted", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()
    await h.run("edit_memo", { oldString: "", newString: "Survives compaction." })
    const compacted = ordinaryMessage(
        h.sessionID,
        "compacted-summary",
        "assistant",
        "Compacted context.",
    )
    compacted.info = {
        ...compacted.info,
        summary: true,
        time: { created: 100 },
    } as WithParts["info"]
    h.setHistory([compacted])

    await h.render()

    assert.equal(await h.readMemo(), "Survives compaction.")
    await assert.rejects(h.guard("read"), /housekeeping/i)
    await h.leave()
    h.assertSessionReads()
})
