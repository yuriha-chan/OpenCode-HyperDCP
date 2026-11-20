import assert from "node:assert/strict"
import test from "node:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Event as V1Event } from "@opencode-ai/sdk/v2"
import type { Plugin } from "@opencode/plugin/tui"
import { createTuiSessionCache } from "../src/tui-cache"
import { subscribeV1Refresh, subscribeV2Refresh } from "../src/tui-events"
import type { TuiMessageEntry } from "../src/tui-client"
import type { TuiCachedState } from "../src/tui-state"

type V2Event = Parameters<Parameters<Plugin.Context["data"]["listen"]>[0]>[0]["details"]

function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve))
}

function entry(id: string, text = `text-${id}`): TuiMessageEntry {
    return { id, type: "assistant", text }
}

function emptyState(): TuiCachedState {
    return { blocks: [], trackedMessages: [], memo: null, stats: null }
}

function createV1EventSource() {
    type Handler = (event: V1Event) => void
    const handlers = new Map<V1Event["type"], Set<Handler>>()
    let registered = 0
    let unsubscribed = 0
    const bus: TuiPluginApi["event"] = {
        on<Type extends V1Event["type"]>(
            type: Type,
            handler: (event: Extract<V1Event, { type: Type }>) => void,
        ) {
            registered += 1
            const stored = handler as unknown as Handler
            const listeners = handlers.get(type) ?? new Set<Handler>()
            listeners.add(stored)
            handlers.set(type, listeners)
            return () => {
                listeners.delete(stored)
                unsubscribed += 1
            }
        },
    }
    return {
        bus,
        emit(event: V1Event) {
            for (const handler of handlers.get(event.type) ?? []) handler(event)
        },
        registered: () => registered,
        unsubscribed: () => unsubscribed,
    }
}

function createV2EventSource() {
    type Handler = (event: V2Event) => void
    const handlers = new Map<V2Event["type"], Set<Handler>>()
    let registered = 0
    let unsubscribed = 0
    const source = {
        on<Type extends V2Event["type"]>(
            type: Type,
            handler: (event: Extract<V2Event, { type: Type }>) => void,
        ) {
            registered += 1
            const stored = handler as unknown as Handler
            const listeners = handlers.get(type) ?? new Set<Handler>()
            listeners.add(stored)
            handlers.set(type, listeners)
            return () => {
                listeners.delete(stored)
                unsubscribed += 1
            }
        },
    }
    return {
        data: source as unknown as Plugin.Context["data"],
        emit(event: V2Event) {
            for (const handler of handlers.get(event.type) ?? []) handler(event)
        },
        registered: () => registered,
        unsubscribed: () => unsubscribed,
    }
}

test("v1 events queue changed identities and read only at session idle while removals discard known rows", async (t) => {
    const initial = [entry("m1"), entry("m2"), entry("m3"), entry("m4")]
    let listCalls = 0
    const targeted: string[] = []
    const cache = createTuiSessionCache({
        readSessionMessages: async () => {
            listCalls += 1
            return initial
        },
        readSessionMessage: async (_sessionID, messageID) => {
            targeted.push(messageID)
            return entry(messageID, `updated-${messageID}`)
        },
        readState: async () => emptyState(),
        onError: (error) => {
            throw error
        },
    })
    t.after(() => cache.dispose())

    cache.observe("session", () => {})
    await flush()
    const hydrated = cache.get("session")
    assert.deepEqual(
        hydrated.messages.map((message) => message.id),
        ["m1", "m2", "m3", "m4"],
    )

    const source = createV1EventSource()
    const stop = subscribeV1Refresh(source.bus, cache)

    source.emit({
        id: "evt_updated",
        type: "message.updated",
        properties: {
            sessionID: "session",
            info: {
                id: "m2",
                sessionID: "session",
                role: "user",
                time: { created: 1 },
                agent: "build",
                model: { providerID: "provider", modelID: "model" },
            },
        },
    })
    source.emit({
        id: "evt_part",
        type: "message.part.updated",
        properties: {
            sessionID: "session",
            part: {
                id: "part_1",
                sessionID: "session",
                messageID: "m1",
                type: "text",
                text: "streaming text",
            },
            time: 2,
        },
    })
    await flush()

    assert.deepEqual(targeted, [])
    assert.equal(listCalls, 1)
    assert.deepEqual(cache.get("session").messages, hydrated.messages)

    source.emit({
        id: "evt_removed",
        type: "message.removed",
        properties: { sessionID: "session", messageID: "m4" },
    })
    assert.deepEqual(
        cache.get("session").messages.map((message) => message.id),
        ["m1", "m2", "m3"],
    )
    assert.deepEqual(targeted, [])
    assert.equal(listCalls, 1)

    source.emit({
        id: "evt_idle",
        type: "session.idle",
        properties: { sessionID: "session" },
    })
    await flush()

    assert.deepEqual([...targeted].sort(), ["m1", "m2"])
    assert.equal(listCalls, 1)
    const completed = cache.get("session")
    assert.deepEqual(
        completed.messages.map((message) => message.id),
        ["m1", "m2", "m3"],
    )
    assert.equal(completed.messages[2], hydrated.messages[2])

    stop()
    assert.ok(source.registered() > 0)
    assert.equal(source.unsubscribed(), source.registered())
})

test("v2 events queue synthetic, inbox and assistant identities and read only after execution, applying a committed revert boundary", async (t) => {
    const initial = [entry("m1"), entry("m2"), entry("m3")]
    let listCalls = 0
    const targeted: string[] = []
    const cache = createTuiSessionCache({
        readSessionMessages: async () => {
            listCalls += 1
            return initial
        },
        readSessionMessage: async (_sessionID, messageID) => {
            targeted.push(messageID)
            return entry(messageID, `updated-${messageID}`)
        },
        readState: async () => emptyState(),
        onError: (error) => {
            throw error
        },
    })
    t.after(() => cache.dispose())

    cache.observe("session", () => {})
    await flush()
    const hydrated = cache.get("session")
    assert.deepEqual(
        hydrated.messages.map((message) => message.id),
        ["m1", "m2", "m3"],
    )

    const source = createV2EventSource()
    const stop = subscribeV2Refresh(source.data, cache)

    source.emit({
        id: "evt_synthetic",
        created: 1,
        type: "session.synthetic",
        durable: { aggregateID: "session", seq: 1, version: 1 },
        data: { sessionID: "session", text: "synthetic text", description: "Synthetic" },
    })
    source.emit({
        id: "evt_inbox",
        created: 2,
        type: "session.inbox.delivered",
        durable: { aggregateID: "session", seq: 2, version: 1 },
        data: { sessionID: "session", inboxID: "msg_inbox" },
    })
    source.emit({
        id: "evt_step",
        created: 3,
        type: "session.step.started",
        durable: { aggregateID: "session", seq: 3, version: 1 },
        data: {
            sessionID: "session",
            assistantMessageID: "msg_assistant",
            agent: "build",
            model: { id: "model", providerID: "provider" },
            started: 1,
        },
    })
    source.emit({
        id: "evt_text",
        created: 4,
        type: "session.text.started",
        durable: { aggregateID: "session", seq: 4, version: 1 },
        data: { sessionID: "session", assistantMessageID: "msg_assistant", ordinal: 0 },
    })
    await flush()

    assert.deepEqual(targeted, [])
    assert.equal(listCalls, 1)
    assert.deepEqual(cache.get("session").messages, hydrated.messages)

    source.emit({
        id: "evt_done",
        created: 5,
        type: "session.execution.succeeded",
        durable: { aggregateID: "session", seq: 5, version: 1 },
        data: { sessionID: "session" },
    })
    await flush()

    assert.deepEqual([...targeted].sort(), [
        "msg_assistant",
        "msg_done",
        "msg_inbox",
        "msg_synthetic",
    ])
    assert.equal(listCalls, 1)
    const afterCompletion = cache.get("session")
    assert.deepEqual(
        afterCompletion.messages.map((message) => message.id),
        ["m1", "m2", "m3", "msg_synthetic", "msg_inbox", "msg_assistant", "msg_done"],
    )
    assert.equal(afterCompletion.messages[0], hydrated.messages[0])
    assert.equal(afterCompletion.messages[1], hydrated.messages[1])
    assert.equal(afterCompletion.messages[2], hydrated.messages[2])

    source.emit({
        id: "evt_staged",
        created: 6,
        type: "session.revert.staged",
        durable: { aggregateID: "session", seq: 6, version: 1 },
        data: { sessionID: "session", revert: { messageID: "msg_inbox" } },
    })
    await flush()

    assert.deepEqual([...targeted].sort(), [
        "msg_assistant",
        "msg_done",
        "msg_inbox",
        "msg_synthetic",
    ])
    assert.equal(listCalls, 1)
    assert.deepEqual(cache.get("session").messages, afterCompletion.messages)

    source.emit({
        id: "evt_committed",
        created: 7,
        type: "session.revert.committed",
        durable: { aggregateID: "session", seq: 7, version: 1 },
        data: { sessionID: "session", to: "msg_inbox" },
    })
    await flush()

    const afterRevert = cache.get("session")
    assert.deepEqual(
        afterRevert.messages.map((message) => message.id),
        ["m1", "m2", "m3", "msg_synthetic"],
    )
    assert.equal(afterRevert.messages[0], hydrated.messages[0])
    assert.equal(afterRevert.messages[1], hydrated.messages[1])
    assert.equal(afterRevert.messages[2], hydrated.messages[2])
    assert.equal(afterRevert.messages[3], afterCompletion.messages[3])
    assert.equal(listCalls, 1)
    assert.deepEqual([...targeted].sort(), [
        "msg_assistant",
        "msg_done",
        "msg_inbox",
        "msg_synthetic",
    ])

    stop()
    assert.ok(source.registered() > 0)
    assert.equal(source.unsubscribed(), source.registered())
})

test("v2 compaction refresh reads the persisted start identity rather than the terminal event identity", async (t) => {
    const targeted: string[] = []
    const cache = createTuiSessionCache({
        readSessionMessages: async () => [],
        readSessionMessage: async (_sessionID, messageID) => {
            targeted.push(messageID)
            return entry(messageID, "completed summary")
        },
        readState: async () => emptyState(),
        onError: (error) => {
            throw error
        },
    })
    t.after(() => cache.dispose())
    cache.observe("session", () => {})
    await flush()
    const source = createV2EventSource()
    const stop = subscribeV2Refresh(source.data, cache)
    t.after(stop)
    source.emit({
        id: "evt_start",
        created: 1,
        type: "session.compaction.started",
        durable: { aggregateID: "session", seq: 1, version: 1 },
        data: { sessionID: "session", reason: "manual", inputID: "msg_compaction" },
    })
    source.emit({
        id: "evt_end",
        created: 2,
        type: "session.compaction.ended",
        durable: { aggregateID: "session", seq: 2, version: 1 },
        data: { sessionID: "session", reason: "manual", text: "completed summary" },
    })
    assert.deepEqual(targeted, [])
    source.emit({
        id: "evt_idle",
        created: 3,
        type: "session.idle",
        data: { sessionID: "session" },
    })
    await flush()
    assert.deepEqual(targeted, ["msg_compaction"])
    assert.equal(cache.get("session").messages[0].text, "completed summary")
})
