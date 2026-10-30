import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import { syncCompressionBlocks } from "../lib/messages/sync"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock, PrunedMessageEntry } from "../lib/state/types"

const sessionID = "ses_messages_sync"

function textMessage(id: string, role: "user" | "assistant" = "assistant"): WithParts {
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
        anchorMessageId: "origin",
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

function makeEntry(overrides: Partial<PrunedMessageEntry>): PrunedMessageEntry {
    return {
        tokenCount: 1,
        allBlockIds: [],
        activeBlockIds: [],
        ...overrides,
    }
}

function entrySnapshot(entry: PrunedMessageEntry): PrunedMessageEntry {
    return {
        tokenCount: entry.tokenCount,
        allBlockIds: [...entry.allBlockIds],
        activeBlockIds: [...entry.activeBlockIds],
    }
}

test("syncCompressionBlocks appends overlapping block coverage in block creation order", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(
        1,
        makeBlock({
            blockId: 1,
            createdAt: 1,
            compressMessageId: "origin-1",
            effectiveMessageIds: ["m1", "m2"],
        }),
    )
    state.prune.messages.blocksById.set(
        2,
        makeBlock({
            blockId: 2,
            createdAt: 2,
            compressMessageId: "origin-2",
            effectiveMessageIds: ["m2", "m3"],
        }),
    )

    syncCompressionBlocks(state, new Logger(false), [
        textMessage("origin-1"),
        textMessage("origin-2"),
        textMessage("m1"),
        textMessage("m2"),
        textMessage("m3"),
    ])

    const byMessageId = state.prune.messages.byMessageId
    assert.deepEqual(byMessageId.get("m1")?.allBlockIds, [1])
    assert.deepEqual(byMessageId.get("m1")?.activeBlockIds, [1])
    assert.deepEqual(byMessageId.get("m2")?.allBlockIds, [1, 2])
    assert.deepEqual(byMessageId.get("m2")?.activeBlockIds, [1, 2])
    assert.deepEqual(byMessageId.get("m3")?.allBlockIds, [2])
    assert.deepEqual(byMessageId.get("m3")?.activeBlockIds, [2])
})

test("syncCompressionBlocks preserves unusual normalized ID order for existing entries", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(
        1,
        makeBlock({
            blockId: 1,
            createdAt: 1,
            effectiveMessageIds: ["m1"],
        }),
    )
    state.prune.messages.blocksById.set(
        2,
        makeBlock({
            blockId: 2,
            createdAt: 2,
            effectiveMessageIds: ["m1"],
        }),
    )
    state.prune.messages.byMessageId.set(
        "m1",
        makeEntry({ allBlockIds: [2, 1], activeBlockIds: [2, 1] }),
    )

    syncCompressionBlocks(state, new Logger(false), [textMessage("origin"), textMessage("m1")])

    const entry = state.prune.messages.byMessageId.get("m1")
    assert.deepEqual(entry?.allBlockIds, [2, 1])
    assert.deepEqual(entry?.activeBlockIds, [2, 1])
})

test("syncCompressionBlocks normalizes invalid and duplicate allBlockIds", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(
        1,
        makeBlock({
            blockId: 1,
            createdAt: 1,
            effectiveMessageIds: ["m1"],
        }),
    )
    state.prune.messages.blocksById.set(
        2,
        makeBlock({
            blockId: 2,
            createdAt: 2,
            effectiveMessageIds: ["m1"],
        }),
    )
    state.prune.messages.byMessageId.set(
        "m1",
        makeEntry({
            allBlockIds: [2, 2, -5, 0, 1.5, 1] as number[],
            activeBlockIds: [999],
        }),
    )

    syncCompressionBlocks(state, new Logger(false), [textMessage("origin"), textMessage("m1")])

    const entry = state.prune.messages.byMessageId.get("m1")
    assert.deepEqual(entry?.allBlockIds, [2, 1])
    assert.deepEqual(entry?.activeBlockIds, [2, 1])
})

test("syncCompressionBlocks drops inactive block associations from activeBlockIds only", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(
        1,
        makeBlock({
            blockId: 1,
            createdAt: 1,
            effectiveMessageIds: ["m1"],
        }),
    )
    state.prune.messages.blocksById.set(
        2,
        makeBlock({
            blockId: 2,
            createdAt: 2,
            deactivatedByUser: true,
            effectiveMessageIds: ["m1"],
        }),
    )
    state.prune.messages.byMessageId.set(
        "m1",
        makeEntry({ allBlockIds: [1, 2], activeBlockIds: [1, 2] }),
    )

    syncCompressionBlocks(state, new Logger(false), [textMessage("origin"), textMessage("m1")])

    const entry = state.prune.messages.byMessageId.get("m1")
    assert.deepEqual(entry?.allBlockIds, [1, 2])
    assert.deepEqual(entry?.activeBlockIds, [1])
})

test("syncCompressionBlocks tracks new entries and skips repeated or absent message IDs", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(
        1,
        makeBlock({
            blockId: 1,
            createdAt: 1,
            effectiveMessageIds: ["m1", "m1", "ghost", "m2"],
        }),
    )

    syncCompressionBlocks(state, new Logger(false), [
        textMessage("origin"),
        textMessage("m1"),
        textMessage("m2"),
    ])

    const byMessageId = state.prune.messages.byMessageId
    assert.deepEqual(byMessageId.get("m1")?.allBlockIds, [1])
    assert.deepEqual(byMessageId.get("m1")?.activeBlockIds, [1])
    assert.deepEqual(byMessageId.get("m2")?.allBlockIds, [1])
    assert.deepEqual(byMessageId.get("m2")?.activeBlockIds, [1])
    assert.equal(byMessageId.has("ghost"), false)
    assert.equal(typeof byMessageId.get("m1")?.tokenCount, "number")
})

test("syncCompressionBlocks is idempotent across repeated invocations", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(
        1,
        makeBlock({
            blockId: 1,
            createdAt: 1,
            effectiveMessageIds: ["m1", "m2"],
        }),
    )
    state.prune.messages.blocksById.set(
        2,
        makeBlock({
            blockId: 2,
            createdAt: 2,
            effectiveMessageIds: ["m2", "m3"],
        }),
    )
    state.prune.messages.byMessageId.set("m1", makeEntry({ allBlockIds: [2], activeBlockIds: [2] }))
    const messages = [
        textMessage("origin"),
        textMessage("m1"),
        textMessage("m2"),
        textMessage("m3"),
    ]

    syncCompressionBlocks(state, new Logger(false), messages)
    const first = new Map(
        Array.from(state.prune.messages.byMessageId, ([id, entry]) => [id, entrySnapshot(entry)]),
    )
    syncCompressionBlocks(state, new Logger(false), messages)
    const second = new Map(
        Array.from(state.prune.messages.byMessageId, ([id, entry]) => [id, entrySnapshot(entry)]),
    )

    assert.deepEqual(second, first)
})
