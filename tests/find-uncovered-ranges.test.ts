import "./helpers/storage-env"
import assert from "node:assert/strict"
import test from "node:test"
import { assignMessageRefs } from "../lib/message-ids"
import { findUncoveredRanges, formatUncoveredRanges } from "../lib/messages/uncovered"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock } from "../lib/state/types"
import { createHousekeepingHarness } from "./helpers/housekeeping"

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
    assignMessageRefs(state, messages)
    state.prune.messages.blocksById.set(1, block(1, ["m1", "m2", "m3", "m4", "m5"]))
    const ranges = findUncoveredRanges(state, messages)
    assert.deepEqual(ranges, [])
})

test("findUncoveredRanges: block covers subset reports uncovered range", () => {
    const state = createSessionState()
    const messages = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"].map((id) => message(id))
    assignMessageRefs(state, messages)
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
    assignMessageRefs(state, messages)
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
    assignMessageRefs(state, messages)
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
    assignMessageRefs(state, messages)
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
    assignMessageRefs(state, messages)
    const ranges = findUncoveredRanges(state, messages)
    assert.equal(ranges.length, 1)
    assert.equal(ranges[0]!.startId, "m0001")
    assert.equal(ranges[0]!.endId, "m0002")
    assert.equal(ranges[0]!.messageCount, 2)
})

test("findUncoveredRanges: token estimate is computed from message contents", () => {
    const state = createSessionState()
    const messages = [message("m1"), message("m2")]
    assignMessageRefs(state, messages)
    const ranges = findUncoveredRanges(state, messages)
    assert.equal(ranges.length, 1)
    assert.ok(ranges[0]!.tokenEstimate > 0)
})

test("findUncoveredRanges: queries and formatting never allocate missing references", () => {
    const state = createSessionState()
    const messages = [message("raw-first"), message("raw-second")]

    const unprepared = findUncoveredRanges(state, messages)
    formatUncoveredRanges(unprepared, state.prune.messages.blocksById)
    findUncoveredRanges(state, messages)

    assert.equal(assignMessageRefs(state, messages), 2)
    const prepared = findUncoveredRanges(state, messages)
    assert.equal(prepared.length, 1)
    assert.equal(prepared[0]!.startId, "m0001")
    assert.equal(prepared[0]!.endId, "m0002")
    assert.equal(prepared[0]!.messageCount, 2)
    assert.equal(assignMessageRefs(state, messages), 0)
})

test("formatUncoveredRanges: preserves gap boundaries, counts, and neighboring blocks", () => {
    const state = createSessionState()
    const messages = ["first", "gap-a", "middle", "gap-b", "last"].map((id) => message(id))
    assignMessageRefs(state, messages)
    state.prune.messages.blocksById.set(
        1,
        block(1, ["first"], { startId: "m0001", endId: "m0001", topic: "Before" }),
    )
    state.prune.messages.blocksById.set(
        2,
        block(2, ["middle"], { startId: "m0003", endId: "m0003", topic: "Between" }),
    )
    state.prune.messages.blocksById.set(
        3,
        block(3, ["last"], { startId: "m0005", endId: "m0005", topic: "After" }),
    )

    const formatted = formatUncoveredRanges(
        findUncoveredRanges(state, messages),
        state.prune.messages.blocksById,
    )

    assert.match(formatted, /m0002 → m0002: 1 messages, .*tokens/)
    assert.match(formatted, /m0004 → m0004: 1 messages, .*tokens/)
    assert.match(formatted, /preceding: b1 Before/)
    assert.match(formatted, /following: b2 Between/)
    assert.match(formatted, /preceding: b2 Between/)
    assert.match(formatted, /following: b3 After/)
    assert.doesNotMatch(formatted, /m0002 → m0004/)
    assert.equal(formatUncoveredRanges([], state.prune.messages.blocksById), "")
    assert.equal(assignMessageRefs(state, messages), 0)
})

test("findUncoveredRanges: completed housekeeping content contributes neither targets nor token estimates", async (t) => {
    const h = await createHousekeepingHarness(t)
    const before = findUncoveredRanges(h.ctx.state, h.history)
    assert.equal(before.length, 1)
    assert.equal(before[0]!.messageCount, 4)

    await h.enter()
    h.addText("private-range-interior", "Private housekeeping-only token payload. ".repeat(200))
    await h.readMemo()
    await h.leave()

    const after = findUncoveredRanges(h.ctx.state, h.history)
    assert.deepEqual(after, before)
    const formatted = formatUncoveredRanges(after, new Map())
    assert.match(formatted, /m0001 → m0004: 4 messages/)
    assert.doesNotMatch(formatted, /private-range-interior|tool-message|Private housekeeping/)
    assert.equal(assignMessageRefs(h.ctx.state, h.history), 0)

    await h.enter()
    assert.deepEqual(findUncoveredRanges(h.ctx.state, h.history), before)
    assert.equal(assignMessageRefs(h.ctx.state, h.history), 0)
    h.assertSessionReads()
})
