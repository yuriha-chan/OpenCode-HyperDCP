import "./helpers/storage-env"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import test from "node:test"
import { Logger } from "../lib/logger"
import { getSessionFilePath } from "../lib/paths"
import { createSessionState, ensureSessionInitialized, type SessionState } from "../lib/state"
import { saveSessionStateStrict } from "../lib/state/persistence"
import type { CompressionBlock, MessageIdState } from "../lib/state/types"
import { v1SubagentObservations, v2SubagentObservations } from "../lib/subagents/observations"
import { ordinaryMessage } from "./helpers/housekeeping"
import type { NativeSessionMessage } from "../lib/native-session"
import {
    reconcileSubagentExecutions,
    renderProtectedSubagents,
    selectProtectedSubagents,
    type SubagentExecution,
    type SubagentObservation,
} from "../lib/subagents/protection"

const logger = new Logger(false)

type CallObservation = Extract<SubagentObservation, { type: "call" }>
type TerminalObservation = Extract<SubagentObservation, { type: "terminal" }>

function callObservation(overrides: Partial<CallObservation> = {}): SubagentObservation {
    return {
        type: "call",
        messageId: "msg-call",
        callId: "call",
        sessionId: "ses-child",
        ...overrides,
    }
}

function terminalObservation(overrides: Partial<TerminalObservation> = {}): SubagentObservation {
    return {
        type: "terminal",
        messageId: "msg-terminal",
        sessionId: "ses-child",
        status: "completed",
        report: "report",
        ...overrides,
    }
}

function execution(overrides: Partial<SubagentExecution> = {}): SubagentExecution {
    return {
        callingMessageId: "msg-call",
        callId: "call",
        sessionId: "ses-child",
        status: "running",
        title: "Title",
        steeringMessages: [],
        ...overrides,
    }
}

function projection(effectiveMessageIds: string[]): CompressionBlock {
    return { effectiveMessageIds } as CompressionBlock
}

function refState(entries: Record<string, string>): MessageIdState {
    return {
        byRawId: new Map(Object.entries(entries)),
        byRef: new Map(Object.entries(entries).map(([rawId, ref]) => [ref, rawId])),
        nextRef: Object.keys(entries).length + 1,
    }
}

function initClient(): any {
    return {
        session: {
            get: async () => ({ data: {} }),
        },
    }
}

async function restoreSession(sessionId: string): Promise<SessionState> {
    const state = createSessionState()
    await ensureSessionInitialized(initClient(), state, sessionId, logger, [], false)
    return state
}

function setSubagentExecutions(state: SessionState, entries: SubagentExecution[]): void {
    state.subagentExecutions = entries
}

function getSubagentExecutions(state: SessionState): SubagentExecution[] {
    return state.subagentExecutions
}

function persistedFixture(): Record<string, any> {
    return {
        prune: {
            tools: {},
            messages: {
                byMessageId: {},
                blocksById: {},
                activeBlockIds: [],
                activeByAnchorMessageId: {},
                nextBlockId: 1,
                nextRunId: 1,
            },
        },
        nudges: { contextLimitAnchors: [] },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        lastUpdated: new Date(0).toISOString(),
    }
}

async function writePersistedFixture(
    sessionId: string,
    fixture: Record<string, unknown>,
): Promise<void> {
    const filePath = getSessionFilePath(sessionId)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(fixture), "utf-8")
}

test("steering appends to a running execution and completion updates that entry", () => {
    const entries = reconcileSubagentExecutions(
        [],
        [
            callObservation({ messageId: "msg-call-a", callId: "call-a", title: "Investigate" }),
            callObservation({
                messageId: "msg-steer-b",
                callId: "call-b",
                query: "follow up",
            }),
            terminalObservation({ messageId: "msg-result-r1", report: "R1 report" }),
        ],
    )

    assert.deepEqual(entries, [
        execution({
            callingMessageId: "msg-call-a",
            callId: "call-a",
            status: "completed",
            title: "Investigate",
            steeringMessages: [{ messageId: "msg-steer-b", callId: "call-b" }],
            terminationMessageId: "msg-result-r1",
            report: "R1 report",
        }),
    ])
})

test("v1 observations preserve foreground and background delivered results and steering", () => {
    const task = (id: string, callId: string, status: string, output: string, child = "child") => {
        const message = ordinaryMessage("parent", id, "assistant", "")
        message.parts = [
            {
                type: "tool",
                id: `${id}-part`,
                messageID: id,
                sessionID: "parent",
                callID: callId,
                tool: "task",
                state: {
                    status,
                    input: { description: "Investigate", prompt: "query" },
                    metadata: { sessionId: child },
                    title: "Investigate",
                    output,
                    error: output,
                    time: { start: 1, end: 2 },
                },
            } as any,
        ]
        return message
    }
    const delivery = ordinaryMessage(
        "parent",
        "delivery",
        "user",
        '<task id="child" state="completed">\n<task_result>R1 delivered</task_result>\n</task>',
    )
    if (delivery.parts[0].type === "text") delivery.parts[0].synthetic = true
    const history = [
        task("start", "a", "completed", '<task id="child" state="running">Background</task>'),
        task("steer", "b", "completed", '<task id="child" state="running">Steered</task>'),
        delivery,
        task(
            "resume",
            "c",
            "completed",
            '<task id="child" state="completed"><task_result>R2 delivered</task_result></task>',
        ),
        task("cancel", "d", "error", "Task cancelled", "canceled-child"),
        task("error", "e", "error", "Worker failed", "failed-child"),
    ]
    const original = structuredClone(history)
    const entries = reconcileSubagentExecutions([], v1SubagentObservations(history))
    assert.equal(entries.length, 4)
    assert.deepEqual(entries[0]?.steeringMessages, [{ messageId: "steer", callId: "b" }])
    assert.equal(entries[0]?.terminationMessageId, "delivery")
    assert.equal(entries[0]?.report, "R1 delivered")
    assert.equal(entries[1]?.callingMessageId, "resume")
    assert.equal(entries[1]?.terminationMessageId, "resume")
    assert.equal(entries[1]?.report, "R2 delivered")
    assert.deepEqual(
        entries.slice(2).map((entry) => entry.status),
        ["canceled", "failed"],
    )
    assert.deepEqual(history, original)
})

test("v2 observations use terminal metadata and keep distinct delivered reports after resume", () => {
    const call = (id: string, callId: string) => ({
        id,
        type: "assistant",
        agent: "assistant",
        model: { id: "test", providerID: "test" },
        time: { created: 1 },
        content: [
            {
                type: "tool",
                name: "subagent",
                id: callId,
                state: {
                    status: "completed",
                    input: { sessionID: "child", description: "Investigate", prompt: "query" },
                    content: [{ type: "text", text: "Background" }],
                    metadata: { sessionID: "child", status: "running" },
                },
                time: { created: 1, completed: 2 },
            },
        ],
    })
    const terminal = (id: string, report: string, state = "completed") => ({
        id,
        type: "synthetic",
        time: { created: 2 },
        text: `<subagent sessionID="child" state="running" description="Investigate">\n${report}\n</subagent>`,
        metadata: { source: "subagent", childID: "child", state },
    })
    const history = [
        call("start", "a"),
        call("steer", "b"),
        terminal("r1", "R1 delivered"),
        call("resume", "c"),
        terminal("r2", "R2 delivered", "error"),
    ] as NativeSessionMessage[]
    const original = structuredClone(history)
    const observations = v2SubagentObservations(history)
    const entries = reconcileSubagentExecutions([], observations)
    assert.equal(entries.length, 2)
    assert.deepEqual(entries[0]?.steeringMessages, [{ messageId: "steer", callId: "b" }])
    assert.equal(entries[0]?.status, "completed")
    assert.equal(entries[0]?.report, "R1 delivered")
    assert.equal(entries[1]?.status, "failed")
    assert.equal(entries[1]?.report, "R2 delivered")
    assert.deepEqual(reconcileSubagentExecutions(entries, observations), entries)
    assert.deepEqual(history, original)
})

test("unidentified task calls and ordinary synthetic text do not invent executions", () => {
    assert.deepEqual(
        v1SubagentObservations([ordinaryMessage("parent", "user", "user", "ordinary report")]),
        [],
    )
    const native = [
        { id: "ordinary", type: "synthetic", text: "ordinary report", time: { created: 1 } },
        {
            id: "unknown",
            type: "synthetic",
            text: "unknown report",
            metadata: { source: "subagent", state: "completed" },
            time: { created: 1 },
        },
    ] as NativeSessionMessage[]
    assert.deepEqual(reconcileSubagentExecutions([], v2SubagentObservations(native)), [])
})

test("resume after termination creates a separate entry with its own report and references", () => {
    const first = reconcileSubagentExecutions(
        [],
        [
            callObservation({ messageId: "msg-call-a", callId: "call-a", title: "First" }),
            terminalObservation({ messageId: "msg-result-r1", report: "R1 report" }),
        ],
    )

    const resumed = reconcileSubagentExecutions(first, [
        callObservation({ messageId: "msg-call-c", callId: "call-c", title: "Resume" }),
        terminalObservation({ messageId: "msg-result-r2", report: "R2 report" }),
    ])

    assert.equal(resumed.length, 2)
    assert.deepEqual(resumed[0], first[0])
    assert.deepEqual(
        resumed[1],
        execution({
            callingMessageId: "msg-call-c",
            callId: "call-c",
            status: "completed",
            title: "Resume",
            terminationMessageId: "msg-result-r2",
            report: "R2 report",
        }),
    )
    assert.equal(resumed[0]!.report, "R1 report")
    assert.equal(resumed[0]!.terminationMessageId, "msg-result-r1")
})

test("replaying known calls and terminal messages neither duplicates nor regresses them", () => {
    const existing = [
        execution({
            callingMessageId: "msg-call-a",
            callId: "call-a",
            status: "completed",
            title: "First",
            terminationMessageId: "msg-result-r1",
            report: "R1 report",
        }),
        execution({
            callingMessageId: "msg-call-c",
            callId: "call-c",
            status: "completed",
            title: "Resume",
            terminationMessageId: "msg-result-r2",
            report: "R2 report",
        }),
    ]

    const replayed = reconcileSubagentExecutions(existing, [
        callObservation({ messageId: "msg-call-a", callId: "call-a", title: "First" }),
        terminalObservation({ messageId: "msg-result-r1", report: "R1 report" }),
        callObservation({ messageId: "msg-call-c", callId: "call-c", title: "Resume" }),
        terminalObservation({ messageId: "msg-result-r2", report: "R2 report" }),
    ])

    assert.deepEqual(replayed, existing)
    assert.equal(replayed.length, 2)
    assert.deepEqual(
        replayed.map((entry) => entry.status),
        ["completed", "completed"],
    )
    assert.deepEqual(
        replayed.map((entry) => entry.report),
        ["R1 report", "R2 report"],
    )
})

test("parallel foreground task results sharing a message terminate their own executions", () => {
    const observations: SubagentObservation[] = [
        callObservation({ messageId: "parallel", callId: "a", sessionId: "child-a" }),
        terminalObservation({
            messageId: "parallel",
            callId: "a",
            sessionId: "child-a",
            report: "A",
        }),
        callObservation({ messageId: "parallel", callId: "b", sessionId: "child-b" }),
        terminalObservation({
            messageId: "parallel",
            callId: "b",
            sessionId: "child-b",
            report: "B",
        }),
    ]
    const entries = reconcileSubagentExecutions([], observations)
    assert.deepEqual(
        entries.map((entry) => [entry.sessionId, entry.status, entry.report]),
        [
            ["child-a", "completed", "A"],
            ["child-b", "completed", "B"],
        ],
    )
    assert.deepEqual(reconcileSubagentExecutions(entries, observations), entries)
})

test("partial-window reads do not erase entries absent from the window", () => {
    const existing = [
        execution({
            callingMessageId: "msg-call-a",
            callId: "call-a",
            sessionId: "ses-child-1",
            status: "completed",
            title: "Earlier",
            terminationMessageId: "msg-result-r1",
            report: "R1 report",
        }),
        execution({
            callingMessageId: "msg-call-c",
            callId: "call-c",
            sessionId: "ses-child-1",
            status: "running",
            title: "Resumed",
        }),
    ]

    const existingSnapshot = structuredClone(existing)
    const reconciled = reconcileSubagentExecutions(existing, [
        callObservation({
            messageId: "msg-call-d",
            callId: "call-d",
            sessionId: "ses-child-2",
            title: "Other child",
        }),
    ])

    assert.deepEqual(existing, existingSnapshot)
    assert.equal(reconciled.length, 3)
    assert.deepEqual(reconciled.slice(0, 2), existing)
    assert.deepEqual(
        reconciled[2],
        execution({
            callingMessageId: "msg-call-d",
            callId: "call-d",
            sessionId: "ses-child-2",
            title: "Other child",
        }),
    )
})

test("canceled and failed terminals stay coverable while metadata omits result refs", () => {
    const entries = reconcileSubagentExecutions(
        [],
        [
            callObservation({ messageId: "msg-call-a", callId: "call-a", title: "Canceled" }),
            terminalObservation({
                messageId: "msg-result-r1",
                status: "canceled",
                report: "canceled report",
            }),
            callObservation({ messageId: "msg-call-b", callId: "call-b", title: "Failed" }),
            terminalObservation({
                messageId: "msg-result-r2",
                status: "failed",
                report: "failed report",
            }),
        ],
    )

    assert.deepEqual(
        entries.map((entry) => entry.status),
        ["canceled", "failed"],
    )
    assert.deepEqual(
        entries.map((entry) => entry.terminationMessageId),
        ["msg-result-r1", "msg-result-r2"],
    )

    assert.deepEqual(
        selectProtectedSubagents(entries, "metadata", projection(["msg-result-r1"])).map(
            (entry) => entry.callId,
        ),
        ["call-a"],
    )

    const covered = selectProtectedSubagents(
        entries,
        "metadata",
        projection(["msg-result-r1", "msg-result-r2"]),
    )
    assert.deepEqual(
        covered.map((entry) => entry.callId),
        ["call-a", "call-b"],
    )

    const ids = refState({
        "msg-call-a": "m0001",
        "msg-result-r1": "m0002",
        "msg-call-b": "m0003",
        "msg-result-r2": "m0004",
    })
    const rendered = renderProtectedSubagents(covered, "metadata", ids)
    assert.match(rendered, /m0001/)
    assert.match(rendered, /m0003/)
    assert.doesNotMatch(rendered, /m0002/)
    assert.doesNotMatch(rendered, /m0004/)
    assert.match(rendered, /canceled/)
    assert.match(rendered, /failed/)
})

test("selection uses only the latest projected block and never promotes call-only coverage", () => {
    const running = execution({
        callingMessageId: "msg-call-run",
        callId: "call-run",
        sessionId: "ses-child-1",
        status: "running",
        title: "Running",
        steeringMessages: [{ messageId: "msg-steer", callId: "call-steer" }],
    })
    const covered = execution({
        callingMessageId: "msg-call-covered",
        callId: "call-covered",
        sessionId: "ses-child-1",
        status: "completed",
        title: "Covered",
        terminationMessageId: "msg-result-covered",
        report: "covered report",
    })
    const otherBlock = execution({
        callingMessageId: "msg-call-other",
        callId: "call-other",
        sessionId: "ses-child-2",
        status: "completed",
        title: "Other",
        terminationMessageId: "msg-result-other",
        report: "other report",
    })
    const callOnly = execution({
        callingMessageId: "msg-call-only",
        callId: "call-only",
        sessionId: "ses-child-3",
        status: "completed",
        title: "Call only",
        terminationMessageId: "msg-result-only",
        report: "call-only report",
    })
    const entries = [running, covered, otherBlock, callOnly]
    const latest = projection(["msg-call-only", "msg-result-covered"])

    assert.deepEqual(selectProtectedSubagents(entries, "none", latest), [])
    assert.deepEqual(
        selectProtectedSubagents(entries, "metadata", latest).map((entry) => entry.callId),
        ["call-run", "call-covered"],
    )
    assert.deepEqual(
        selectProtectedSubagents(entries, "full", latest).map((entry) => entry.callId),
        ["call-run", "call-covered"],
    )
    assert.deepEqual(
        selectProtectedSubagents(entries, "metadata", null).map((entry) => entry.callId),
        ["call-run"],
    )

    const ids = refState({
        "msg-call-run": "m0010",
        "msg-steer": "m0011",
        "msg-call-covered": "m0012",
        "msg-result-covered": "m0013",
        "msg-call-other": "m0014",
        "msg-result-other": "m0015",
        "msg-call-only": "m0016",
        "msg-result-only": "m0017",
    })
    const selected = selectProtectedSubagents(entries, "metadata", latest)
    const metadata = renderProtectedSubagents(selected, "metadata", ids)
    assert.match(metadata, /m0010/)
    assert.match(metadata, /m0011/)
    assert.match(metadata, /m0012/)
    assert.match(metadata, /m0013/)
    assert.match(metadata, /ses-child-1/)
    assert.match(metadata, /running/)
    assert.match(metadata, /completed/)
    assert.match(metadata, /Running/)
    assert.match(metadata, /Covered/)
    assert.doesNotMatch(metadata, /covered report/)
    assert.doesNotMatch(metadata, /m0015/)
    assert.doesNotMatch(metadata, /m0017/)

    const full = renderProtectedSubagents(selected, "full", ids)
    assert.match(full, /covered report/)
    assert.doesNotMatch(full, /other report/)
    assert.doesNotMatch(full, /call-only report/)

    const before = {
        byRawId: new Map(ids.byRawId),
        byRef: new Map(ids.byRef),
        nextRef: ids.nextRef,
    }
    renderProtectedSubagents(selected, "full", ids)
    assert.deepEqual(ids, before)
})

test("title falls back to the first 120 characters of the query", () => {
    const query = "q".repeat(130)
    const entries = reconcileSubagentExecutions(
        [],
        [
            callObservation({
                messageId: "msg-call-a",
                callId: "call-a",
                title: "",
                query,
            }),
            callObservation({
                messageId: "msg-call-b",
                callId: "call-b",
                sessionId: "ses-child-2",
                title: "Provided",
                query: "ignored query",
            }),
        ],
    )

    assert.equal(entries[0]?.title, query.slice(0, 120))
    assert.equal(entries[0]?.title.length, 120)
    assert.equal(entries[1]?.title, "Provided")
})

test("subagent executions with steering survive strict persistence and public reload", async () => {
    const sessionId = `ses_subagent_persist_${randomUUID()}`
    const state = createSessionState()
    state.sessionId = sessionId
    const entries: SubagentExecution[] = [
        execution({
            callingMessageId: "msg-call-a",
            callId: "call-a",
            status: "completed",
            title: "Persisted",
            steeringMessages: [{ messageId: "msg-steer-b", callId: "call-b" }],
            terminationMessageId: "msg-result-r1",
            report: "R1 report",
        }),
        execution({
            callingMessageId: "msg-call-c",
            callId: "call-c",
            status: "canceled",
            title: "Canceled",
            terminationMessageId: "msg-result-r2",
            report: "canceled report",
        }),
    ]
    setSubagentExecutions(state, entries)

    await saveSessionStateStrict(state, logger)
    const reloaded = await restoreSession(sessionId)

    assert.deepEqual(getSubagentExecutions(reloaded), entries)
})

test("legacy persisted state without subagent executions restores an empty list", async () => {
    const sessionId = `ses_subagent_legacy_${randomUUID()}`
    await writePersistedFixture(sessionId, persistedFixture())

    const restored = await restoreSession(sessionId)

    assert.deepEqual(getSubagentExecutions(restored), [])
})

test("malformed persisted subagent executions reject restore", async (t) => {
    const valid = {
        callingMessageId: "msg-call-a",
        callId: "call-a",
        sessionId: "ses-child",
        status: "completed",
        title: "Valid",
        steeringMessages: [],
        terminationMessageId: "msg-result-r1",
        report: "R1 report",
    }
    const corruptions: Array<{
        name: string
        patch: (fixture: Record<string, any>) => void
    }> = [
        {
            name: "not an array",
            patch: (fixture) => {
                fixture.subagentExecutions = {}
            },
        },
        {
            name: "entry is null",
            patch: (fixture) => {
                fixture.subagentExecutions = [null]
            },
        },
        {
            name: "missing session identity",
            patch: (fixture) => {
                fixture.subagentExecutions = [{ ...valid, sessionId: undefined }]
            },
        },
        {
            name: "unknown status",
            patch: (fixture) => {
                fixture.subagentExecutions = [{ ...valid, status: "done" }]
            },
        },
        {
            name: "malformed steering messages",
            patch: (fixture) => {
                fixture.subagentExecutions = [{ ...valid, steeringMessages: "steer" }]
            },
        },
    ]

    for (const corruption of corruptions) {
        await t.test(corruption.name, async () => {
            const sessionId = `ses_subagent_invalid_${randomUUID()}`
            const fixture = persistedFixture()
            corruption.patch(fixture)
            await writePersistedFixture(sessionId, fixture)

            await assert.rejects(restoreSession(sessionId), (error: unknown) => {
                assert.ok(error instanceof Error)
                assert.match(error.message, /subagent|execution|invalid|state|metadata/i)
                return true
            })
        })
    }
})
