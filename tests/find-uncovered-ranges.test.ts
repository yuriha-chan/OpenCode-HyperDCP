import assert from "node:assert/strict"
import test from "node:test"
import { findUncoveredRanges } from "../lib/messages/uncovered"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock } from "../lib/state/types"

function block(
    blockId: number,
    effectiveMessageIds: string[],
    extra: Partial<CompressionBlock> = {},
): CompressionBlock {
    return {
        blockId,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        topic: `block-${blockId}`,
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: effectiveMessageIds[0] ?? "anchor",
        compressMessageId: effectiveMessageIds[0] ?? "anchor",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: effectiveMessageIds,
        directToolIds: [],
        effectiveMessageIds,
        effectiveToolIds: [],
        createdAt: Date.now(),
        summary: "",
        summaryVersions: [],
        activeVersionIndex: 1,
        ...extra,
    }
}

function message(id: string, role: "user" | "assistant" = "assistant"): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: "s1",
            agent: "assistant",
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID: "s1",
                type: "text",
                text: `content of ${id}`,
            },
        ],
    }
}

function ignoredUserMessage(id: string): WithParts {
    const msg = message(id, "user")
    ;(msg.parts[0] as { ignored?: boolean }).ignored = true
    return msg
}

test("findUncoveredRanges: empty state, no messages returns no ranges", () => {
    const state = createSessionState()
    const ranges = findUncoveredRanges(state, [])
    assert.deepEqual(ranges, [])
})

test("findUncoveredRanges: full coverage returns no ranges", () => {
    const state = createSessionState()
    const messages = ["m1", "m2", "m3", "m4", "m5"].map((id) => message(id))
    state.prune.messages.blocksById.set(1, block(1, ["m1", "m2", "m3", "m4", "m5"]))
    const ranges = findUncoveredRanges(state, messages)
    assert.deepEqual(ranges, [])
})

test("findUncoveredRanges: block covers subset reports uncovered range", () => {
    const state = createSessionState()
    const messages = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"].map((id) => message(id))
    state.prune.messages.blocksById.set(1, block(1, ["m2", "m3", "m4"]))
    const ranges = findUncoveredRanges(state, messages)
    assert.equal(ranges.length, 2)
    assert.equal(ranges[0]!.startId, "m0001")
    assert.equal(ranges[0]!.endId, "m0001")
    assert.equal(ranges[0]!.messageCount, 1)
    assert.equal(ranges[1]!.startId, "m0005")
    assert.equal(ranges[1]!.endId, "m0007")
    assert.equal(ranges[1]!.messageCount, 3)
})

test("findUncoveredRanges: block from old branch (all off-chain) is ignored", () => {
    const state = createSessionState()
    const messages = ["m1", "m2", "m3"].map((id) => message(id))
    state.prune.messages.blocksById.set(1, block(1, ["stale-1", "stale-2", "stale-3"]))
    const ranges = findUncoveredRanges(state, messages)
    assert.equal(ranges.length, 1)
    assert.equal(ranges[0]!.startId, "m0001")
    assert.equal(ranges[0]!.endId, "m0003")
    assert.equal(ranges[0]!.messageCount, 3)
})

test("findUncoveredRanges: block with mixed on-chain/off-chain IDs only contributes on-chain subset", () => {
    const state = createSessionState()
    const messages = ["m1", "m2", "m3", "m4"].map((id) => message(id))
    state.prune.messages.blocksById.set(1, block(1, ["m1", "stale-a", "m2", "stale-b", "m3"]))
    const ranges = findUncoveredRanges(state, messages)
    assert.equal(ranges.length, 1)
    assert.equal(ranges[0]!.startId, "m0004")
    assert.equal(ranges[0]!.endId, "m0004")
    assert.equal(ranges[0]!.messageCount, 1)
})

test("findUncoveredRanges: two non-overlapping on-chain blocks leave gap uncovered", () => {
    const state = createSessionState()
    const messages = ["m1", "m2", "m3", "m4", "m5", "m6"].map((id) => message(id))
    state.prune.messages.blocksById.set(1, block(1, ["m1", "m2"]))
    state.prune.messages.blocksById.set(2, block(2, ["m4", "m5"]))
    const ranges = findUncoveredRanges(state, messages)
    assert.equal(ranges.length, 2)
    assert.equal(ranges[0]!.startId, "m0003")
    assert.equal(ranges[0]!.endId, "m0003")
    assert.equal(ranges[0]!.messageCount, 1)
    assert.equal(ranges[1]!.startId, "m0006")
    assert.equal(ranges[1]!.endId, "m0006")
    assert.equal(ranges[1]!.messageCount, 1)
})

test("findUncoveredRanges: no messages returns no ranges regardless of blocks", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, block(1, ["some-id", "another-id"]))
    const ranges = findUncoveredRanges(state, [])
    assert.deepEqual(ranges, [])
})

test("findUncoveredRanges: ignored user messages are skipped", () => {
    const state = createSessionState()
    const messages = [message("m1"), ignoredUserMessage("m-ignored"), message("m2")]
    const ranges = findUncoveredRanges(state, messages)
    assert.equal(ranges.length, 1)
    assert.equal(ranges[0]!.startId, "m0001")
    assert.equal(ranges[0]!.endId, "m0002")
    assert.equal(ranges[0]!.messageCount, 2)
})

test("findUncoveredRanges: token estimate is computed from message contents", () => {
    const state = createSessionState()
    const messages = [message("m1"), message("m2")]
    const ranges = findUncoveredRanges(state, messages)
    assert.equal(ranges.length, 1)
    assert.ok(ranges[0]!.tokenEstimate > 0)
})
