import assert from "node:assert/strict"
import test from "node:test"
import { createTuiSessionCache } from "../src/tui-cache"
import type { TuiMessageEntry } from "../src/tui-client"
import type { BlockInfo, DcpStats, MessageEntry, TuiCachedState } from "../src/tui-state"

type Deferred<T> = {
    promise: Promise<T>
    resolve: (value: T | PromiseLike<T>) => void
    reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
    let resolve!: Deferred<T>["resolve"]
    let reject!: Deferred<T>["reject"]
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve))
}

function entry(id: string, text = `text-${id}`): TuiMessageEntry {
    return { id, type: "assistant", text }
}

function block(overrides: Partial<BlockInfo> = {}): BlockInfo {
    return {
        blockId: 1,
        active: true,
        activeVersionIndex: 1,
        topic: "topic",
        compressedTokens: 100,
        summaryTokens: 25,
        startId: "m1",
        endId: "m1",
        durationMs: 0,
        deactivatedByUser: false,
        parentBlockIds: [],
        includedBlockIds: [],
        versions: ["summary"],
        ...overrides,
    }
}

function tracked(rawId: string, overrides: Partial<MessageEntry> = {}): MessageEntry {
    return { rawId, ref: rawId, tokenCount: 10, activeBlockIds: [], ...overrides }
}

function stats(overrides: Partial<DcpStats> = {}): DcpStats {
    return {
        totalPruneTokens: 100,
        totalMessagesPruned: 2,
        totalToolsPruned: 1,
        compressionRatio: 0.5,
        ...overrides,
    }
}

function state(overrides: Partial<TuiCachedState> = {}): TuiCachedState {
    return { blocks: [], trackedMessages: [], memo: null, stats: null, ...overrides }
}

test("two observers share one initial conversation fetch and completion reads only queued IDs", async () => {
    const list = deferred<TuiMessageEntry[]>()
    const initial = [entry("m1"), entry("m2"), entry("m3")]
    let listCalls = 0
    let stateCalls = 0
    const targeted: string[] = []
    const cache = createTuiSessionCache({
        readSessionMessages: () => {
            listCalls += 1
            return list.promise
        },
        readSessionMessage: async (_sessionID, messageID) => {
            targeted.push(messageID)
            return entry(messageID, `updated-${messageID}`)
        },
        readState: async () => {
            stateCalls += 1
            return state({ blocks: [block()] })
        },
        onError: () => {},
    })

    let notificationsA = 0
    let notificationsB = 0
    cache.observe("session", () => {
        notificationsA += 1
    })
    cache.observe("session", () => {
        notificationsB += 1
    })

    assert.equal(listCalls, 1)
    assert.equal(stateCalls, 1)
    assert.deepEqual(cache.get("session").messages, [])
    assert.deepEqual(cache.get("session").state, state())

    cache.markMessageChanged("session", "m2")
    assert.deepEqual(targeted, [])
    assert.equal(listCalls, 1)

    list.resolve(initial)
    await flush()

    const loaded = cache.get("session")
    assert.deepEqual(
        loaded.messages.map((message) => message.id),
        ["m1", "m2", "m3"],
    )
    assert.deepEqual(
        loaded.state.blocks.map((item) => item.blockId),
        [1],
    )
    assert.ok(notificationsA >= 1)
    assert.ok(notificationsB >= 1)

    await cache.complete("session")

    assert.deepEqual(targeted, ["m2"])
    assert.equal(listCalls, 1)
    const completed = cache.get("session")
    assert.deepEqual(
        completed.messages.map((message) => message.id),
        ["m1", "m2", "m3"],
    )
    assert.equal(completed.messages[1].text, "updated-m2")
    assert.equal(completed.messages[0], loaded.messages[0])
    assert.equal(completed.messages[2], loaded.messages[2])
    assert.equal(completed.state.blocks[0], loaded.state.blocks[0])

    cache.dispose()
})

test("sessions stay isolated, targeted updates preserve row identity, and finalized removal avoids a reload", async () => {
    const lists: Record<string, TuiMessageEntry[]> = {
        a: [entry("a1"), entry("a2"), entry("a3")],
        b: [entry("b1"), entry("b2")],
    }
    const listCalls: string[] = []
    const targeted: Array<[string, string]> = []
    const cache = createTuiSessionCache({
        readSessionMessages: async (sessionID) => {
            listCalls.push(sessionID)
            return lists[sessionID] ?? []
        },
        readSessionMessage: async (sessionID, messageID) => {
            targeted.push([sessionID, messageID])
            return entry(messageID, `updated-${messageID}`)
        },
        readState: async () => state(),
        onError: () => {},
    })

    cache.observe("a", () => {})
    cache.observe("b", () => {})
    await flush()

    const beforeA = cache.get("a")
    const beforeB = cache.get("b")
    assert.deepEqual(listCalls, ["a", "b"])
    assert.deepEqual(
        beforeA.messages.map((message) => message.id),
        ["a1", "a2", "a3"],
    )
    assert.deepEqual(
        beforeB.messages.map((message) => message.id),
        ["b1", "b2"],
    )

    cache.markMessageChanged("a", "a2")
    await cache.complete("a")

    const afterUpdate = cache.get("a")
    assert.deepEqual(targeted, [["a", "a2"]])
    assert.deepEqual(
        afterUpdate.messages.map((message) => message.id),
        ["a1", "a2", "a3"],
    )
    assert.equal(afterUpdate.messages[0], beforeA.messages[0])
    assert.equal(afterUpdate.messages[2], beforeA.messages[2])
    assert.equal(afterUpdate.messages[1].text, "updated-a2")
    assert.deepEqual(cache.get("b").messages, beforeB.messages)
    assert.deepEqual(listCalls, ["a", "b"])

    cache.removeMessage("a", "a3")
    const afterRemove = cache.get("a")
    assert.deepEqual(
        afterRemove.messages.map((message) => message.id),
        ["a1", "a2"],
    )
    assert.deepEqual(
        cache.get("b").messages.map((message) => message.id),
        ["b1", "b2"],
    )
    assert.deepEqual(listCalls, ["a", "b"])
    assert.deepEqual(targeted, [["a", "a2"]])

    cache.dispose()
})

test("committed refresh applies supplied sections, keeps unchanged identities and conversation, and ignores an equal projection", async () => {
    const conversation = [entry("m1"), entry("m2")]
    let current = state({
        blocks: [block({ blockId: 1, topic: "initial" })],
        trackedMessages: [tracked("m1")],
        memo: "memo-1",
        stats: stats(),
    })
    const cache = createTuiSessionCache({
        readSessionMessages: async () => conversation,
        readSessionMessage: async (_sessionID, messageID) => entry(messageID),
        readState: async () => current,
        onError: () => {},
    })
    let notifications = 0
    cache.observe("s", () => {
        notifications += 1
    })
    await flush()

    const loaded = cache.get("s")
    assert.deepEqual(loaded.messages, conversation)
    assert.equal(loaded.state.memo, "memo-1")
    const conversationAfterLoad = loaded.messages
    const initialTracked = loaded.state.trackedMessages[0]
    const initialStats = loaded.state.stats

    current = state({
        blocks: [block({ blockId: 1, topic: "updated" })],
        trackedMessages: [tracked("m1")],
        memo: "memo-1",
        stats: stats(),
    })
    let beforeRefresh = notifications
    await cache.refreshCommitted("s")

    const afterBlocks = cache.get("s")
    assert.equal(afterBlocks.messages, conversationAfterLoad)
    assert.equal(afterBlocks.state.blocks[0].topic, "updated")
    assert.equal(afterBlocks.state.trackedMessages[0], initialTracked)
    assert.equal(afterBlocks.state.stats, initialStats)
    assert.ok(notifications > beforeRefresh)

    current = state({
        blocks: [block({ blockId: 1, topic: "updated" })],
        trackedMessages: [tracked("m1", { tokenCount: 99 })],
        memo: "memo-2",
        stats: stats(),
    })
    beforeRefresh = notifications
    await cache.refreshCommitted("s")

    const afterMetadata = cache.get("s")
    assert.equal(afterMetadata.messages, conversationAfterLoad)
    assert.equal(afterMetadata.state.blocks[0], afterBlocks.state.blocks[0])
    assert.equal(afterMetadata.state.trackedMessages[0].tokenCount, 99)
    assert.equal(afterMetadata.state.memo, "memo-2")
    assert.equal(afterMetadata.state.stats, initialStats)
    assert.ok(notifications > beforeRefresh)

    current = {
        ...state({
            blocks: [block({ blockId: 1, topic: "updated" })],
            trackedMessages: [tracked("m1", { tokenCount: 99 })],
            memo: "memo-2",
            stats: stats(),
        }),
        draft: { topic: "uncommitted draft" },
        revision: 7,
    } as TuiCachedState
    const afterRefresh = notifications
    await cache.refreshCommitted("s")

    assert.equal(notifications, afterRefresh)
    assert.equal(cache.get("s").messages, conversationAfterLoad)
    assert.equal(cache.get("s").state.blocks[0], afterBlocks.state.blocks[0])

    cache.dispose()
})

test("completion during initial hydration and an ID queued during a targeted read drain without a second full fetch", async () => {
    const list = deferred<TuiMessageEntry[]>()
    const targetedReads = new Map<string, Deferred<TuiMessageEntry>>()
    const targetedIDs: string[] = []
    let listCalls = 0
    const cache = createTuiSessionCache({
        readSessionMessages: () => {
            listCalls += 1
            return list.promise
        },
        readSessionMessage: (_sessionID, messageID) => {
            targetedIDs.push(messageID)
            const pending = deferred<TuiMessageEntry>()
            targetedReads.set(messageID, pending)
            return pending.promise
        },
        readState: async () => state(),
        onError: () => {},
    })

    cache.observe("s", () => {})

    cache.markMessageChanged("s", "m2")
    const firstCompletion = cache.complete("s")
    assert.deepEqual(targetedIDs, [])
    assert.equal(listCalls, 1)

    list.resolve([entry("m1"), entry("m2"), entry("m3")])
    await flush()

    assert.deepEqual(targetedIDs, ["m2"])
    cache.markMessageChanged("s", "m3")
    const secondCompletion = cache.complete("s")

    targetedReads.get("m2")!.resolve(entry("m2", "updated-m2"))
    await flush()

    assert.deepEqual(targetedIDs, ["m2", "m3"])
    targetedReads.get("m3")!.resolve(entry("m3", "updated-m3"))
    await flush()

    await Promise.all([firstCompletion, secondCompletion])

    const snapshot = cache.get("s")
    assert.deepEqual(
        snapshot.messages.map((message) => message.id),
        ["m1", "m2", "m3"],
    )
    assert.equal(snapshot.messages[1].text, "updated-m2")
    assert.equal(snapshot.messages[2].text, "updated-m3")
    assert.equal(listCalls, 1)

    cache.dispose()
})

test("changes arriving during a completion refresh wait for their own completion signal", async () => {
    const pending = deferred<TuiMessageEntry>()
    const reads: string[] = []
    const cache = createTuiSessionCache({
        readSessionMessages: async () => [entry("m1")],
        readSessionMessage: async (_sessionID, messageID) => {
            reads.push(messageID)
            return reads.length === 1 ? pending.promise : entry(messageID, "finished")
        },
        readState: async () => state(),
        onError: (error) => {
            throw error
        },
    })
    cache.observe("s", () => {})
    await flush()
    cache.markMessageChanged("s", "m1")
    const completion = cache.complete("s")
    await flush()
    cache.markMessageChanged("s", "m2")
    pending.resolve(entry("m1", "finished-first"))
    await completion
    assert.deepEqual(reads, ["m1"])
    assert.deepEqual(
        cache.get("s").messages.map((message) => message.id),
        ["m1"],
    )
    await cache.complete("s")
    assert.deepEqual(reads, ["m1", "m2"])
    assert.equal(cache.get("s").messages[1].text, "finished")
    cache.dispose()
})

test("a failed targeted read keeps cached content, reports the exact error, and retries only on a later completion", async () => {
    const failure = new Error("targeted read failed")
    const targetedIDs: string[] = []
    const errors: unknown[] = []
    let failNext = true
    const cache = createTuiSessionCache({
        readSessionMessages: async () => [entry("m1"), entry("m2")],
        readSessionMessage: async (_sessionID, messageID) => {
            targetedIDs.push(messageID)
            if (failNext) throw failure
            return entry(messageID, `updated-${messageID}`)
        },
        readState: async () => state(),
        onError: (error) => {
            errors.push(error)
        },
    })

    cache.observe("s", () => {})
    await flush()

    const before = cache.get("s")
    assert.equal(before.messages[1].text, "text-m2")

    cache.markMessageChanged("s", "m2")
    await assert.doesNotReject(cache.complete("s"))

    assert.deepEqual(targetedIDs, ["m2"])
    assert.equal(errors.length, 1)
    assert.equal(errors[0], failure)
    assert.equal(cache.get("s").messages[1], before.messages[1])
    assert.equal(cache.get("s").messages[1].text, "text-m2")

    await flush()
    assert.deepEqual(targetedIDs, ["m2"])
    assert.equal(errors.length, 1)

    failNext = false
    await cache.complete("s")

    assert.deepEqual(targetedIDs, ["m2", "m2"])
    assert.equal(cache.get("s").messages[1].text, "updated-m2")
    assert.equal(errors.length, 1)

    cache.dispose()
})

test("an in-flight targeted read cannot resurrect a removed row", async () => {
    const pending = deferred<TuiMessageEntry>()
    const targetedIDs: string[] = []
    let listCalls = 0
    const cache = createTuiSessionCache({
        readSessionMessages: async () => {
            listCalls += 1
            return [entry("m1"), entry("m2"), entry("m3")]
        },
        readSessionMessage: (_sessionID, messageID) => {
            targetedIDs.push(messageID)
            return pending.promise
        },
        readState: async () => state(),
        onError: () => {},
    })

    cache.observe("s", () => {})
    await flush()

    cache.markMessageChanged("s", "m2")
    const completion = cache.complete("s")
    await flush()
    assert.deepEqual(targetedIDs, ["m2"])

    cache.removeMessage("s", "m2")
    pending.resolve(entry("m2", "late-update"))
    await completion

    const snapshot = cache.get("s")
    assert.deepEqual(
        snapshot.messages.map((message) => message.id),
        ["m1", "m3"],
    )
    assert.equal(listCalls, 1)

    cache.dispose()
})

test("dispose ignores a late initial response and stops committed-state checks", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] })
    const list = deferred<TuiMessageEntry[]>()
    let stateCalls = 0
    const cache = createTuiSessionCache({
        readSessionMessages: () => list.promise,
        readSessionMessage: async (_sessionID, messageID) => entry(messageID),
        readState: async () => {
            stateCalls += 1
            return state()
        },
        onError: () => {},
    })
    let notifications = 0
    cache.observe("s", () => {
        notifications += 1
    })
    await flush()
    assert.equal(stateCalls, 1)

    const afterInitialState = notifications
    cache.dispose()
    t.mock.timers.tick(5000)
    await flush()
    assert.equal(stateCalls, 1)

    list.resolve([entry("m1")])
    await flush()
    assert.equal(notifications, afterInitialState)
    assert.deepEqual(cache.get("s").messages, [])
})

test("releasing the last observer stops committed-state checks while an observer remains", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] })
    let stateCalls = 0
    const cache = createTuiSessionCache({
        readSessionMessages: async () => [entry("m1")],
        readSessionMessage: async (_sessionID, messageID) => entry(messageID),
        readState: async () => {
            stateCalls += 1
            return state()
        },
        onError: () => {},
    })
    const releaseFirst = cache.observe("s", () => {})
    const releaseSecond = cache.observe("s", () => {})
    await flush()
    assert.equal(stateCalls, 1)

    releaseFirst()
    const afterFirstRelease = stateCalls
    t.mock.timers.tick(2000)
    await flush()
    assert.ok(stateCalls > afterFirstRelease)

    releaseSecond()
    const afterLastRelease = stateCalls
    t.mock.timers.tick(4000)
    await flush()
    assert.equal(stateCalls, afterLastRelease)

    cache.dispose()
})
