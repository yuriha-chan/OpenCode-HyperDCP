import assert from "node:assert/strict"
import test from "node:test"
import { attachCompressionDuration } from "../lib/compress/state"
import { applyPendingCompressionDurations } from "../lib/compress/timing"
import { createSessionState } from "../lib/state"
import type { CompressionBlock } from "../lib/state/types"

function makeBlock(
    blockId: number,
    compressMessageId: string,
    compressCallId: string | undefined,
    overrides: Partial<CompressionBlock> = {},
): CompressionBlock {
    return {
        blockId,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        topic: "test",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "anchor-1",
        compressMessageId,
        compressCallId,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "",
        summaryVersions: [],
        activeVersionIndex: 1,
        ...overrides,
    }
}

function seedBlocks(
    state: ReturnType<typeof createSessionState>,
    ...blocks: CompressionBlock[]
): void {
    for (const block of blocks) {
        state.prune.messages.blocksById.set(block.blockId, block)
    }
}

function addPending(
    state: ReturnType<typeof createSessionState>,
    key: string,
    messageId: string,
    callId: string,
    durationMs: number,
): void {
    state.compressionTiming.pendingByCallId.set(key, { messageId, callId, durationMs })
}

test("applyPendingCompressionDurations returns zero quickly without pending entries", () => {
    const state = createSessionState()
    const block = makeBlock(1, "m1", "c1", { durationMs: 5 })
    seedBlocks(state, block)

    assert.equal(applyPendingCompressionDurations(state), 0)
    assert.equal(block.durationMs, 5)
    assert.equal(state.compressionTiming.pendingByCallId.size, 0)
})

test("applyPendingCompressionDurations updates every matching block including inactive ones", () => {
    const state = createSessionState()
    const active = makeBlock(1, "m1", "c1", { durationMs: 10 })
    const inactive = makeBlock(2, "m1", "c1", { active: false, durationMs: 99 })
    const otherCall = makeBlock(3, "m1", "c2")
    const otherMessage = makeBlock(4, "m2", "c1")
    seedBlocks(state, active, inactive, otherCall, otherMessage)
    addPending(state, "key-1", "m1", "c1", 10)

    assert.equal(applyPendingCompressionDurations(state), 2)
    assert.equal(active.durationMs, 10)
    assert.equal(inactive.durationMs, 10)
    assert.equal(otherCall.durationMs, 0)
    assert.equal(otherMessage.durationMs, 0)
    assert.equal(state.compressionTiming.pendingByCallId.size, 0)
})

test("applyPendingCompressionDurations retains unmatched pending entries", () => {
    const state = createSessionState()
    const block = makeBlock(1, "m1", "c1")
    seedBlocks(state, block)
    addPending(state, "key-1", "m1", "c2", 10)
    addPending(state, "key-2", "m2", "c1", 20)

    assert.equal(applyPendingCompressionDurations(state), 0)
    assert.equal(block.durationMs, 0)
    assert.equal(state.compressionTiming.pendingByCallId.size, 2)
    assert.deepEqual([...state.compressionTiming.pendingByCallId.keys()], ["key-1", "key-2"])
})

test("applyPendingCompressionDurations retains entries with invalid durations", () => {
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "5"]) {
        const state = createSessionState()
        const block = makeBlock(1, "m1", "c1", { durationMs: 7 })
        seedBlocks(state, block)
        addPending(state, "key-1", "m1", "c1", invalid as unknown as number)

        assert.equal(applyPendingCompressionDurations(state), 0)
        assert.equal(block.durationMs, 7)
        assert.equal(state.compressionTiming.pendingByCallId.size, 1)
        assert.equal(state.compressionTiming.pendingByCallId.has("key-1"), true)
    }
})

test("applyPendingCompressionDurations counts updates even when duration is unchanged", () => {
    const state = createSessionState()
    const first = makeBlock(1, "m1", "c1", { durationMs: 12 })
    const second = makeBlock(2, "m1", "c1", { active: false, durationMs: 12 })
    seedBlocks(state, first, second)
    addPending(state, "key-1", "m1", "c1", 12)

    assert.equal(applyPendingCompressionDurations(state), 2)
    assert.equal(first.durationMs, 12)
    assert.equal(second.durationMs, 12)
})

test("applyPendingCompressionDurations handles distinct keys targeting the same pair in insertion order", () => {
    for (const durations of [
        [10, 20],
        [20, 10],
    ]) {
        const state = createSessionState()
        const first = makeBlock(1, "m1", "c1")
        const second = makeBlock(2, "m1", "c1", { active: false })
        seedBlocks(state, first, second)
        addPending(state, "unrelated-key-a", "m1", "c1", durations[0])
        addPending(state, "unrelated-key-b", "m1", "c1", durations[1])

        assert.equal(applyPendingCompressionDurations(state), 4)
        assert.equal(first.durationMs, durations[1])
        assert.equal(second.durationMs, durations[1])
        assert.equal(state.compressionTiming.pendingByCallId.size, 0)
    }
})

test("applyPendingCompressionDurations matches colon-separated IDs without key collisions", () => {
    const state = createSessionState()
    const first = makeBlock(1, "a:b", "c")
    const second = makeBlock(2, "a", "b:c")
    const combined = makeBlock(3, "a:b:c", "")
    seedBlocks(state, first, second, combined)
    addPending(state, "key-1", "a:b", "c", 11)
    addPending(state, "key-2", "a", "b:c", 22)

    assert.equal(applyPendingCompressionDurations(state), 2)
    assert.equal(first.durationMs, 11)
    assert.equal(second.durationMs, 22)
    assert.equal(combined.durationMs, 0)
    assert.equal(state.compressionTiming.pendingByCallId.size, 0)
})

test("attachCompressionDuration keeps exact pair matching and rejects invalid durations", () => {
    const state = createSessionState()
    const first = makeBlock(1, "a:b", "c")
    const second = makeBlock(2, "a:b", "c", { active: false })
    const colliding = makeBlock(3, "a", "b:c")
    seedBlocks(state, first, second, colliding)

    assert.equal(attachCompressionDuration(state.prune.messages, "a:b", "c", 7), 2)
    assert.equal(first.durationMs, 7)
    assert.equal(second.durationMs, 7)
    assert.equal(colliding.durationMs, 0)

    assert.equal(attachCompressionDuration(state.prune.messages, "a:b", "c", Number.NaN), 0)
    assert.equal(first.durationMs, 7)
    assert.equal(second.durationMs, 7)
})
