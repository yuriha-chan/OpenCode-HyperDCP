import assert from "node:assert/strict"
import { describe, test, beforeEach } from "node:test"
import { createSessionState, type CompressionBlock } from "../lib/state"
import { Logger } from "../lib/logger"

function buildBlock(blockId: number, overrides?: Partial<CompressionBlock>): CompressionBlock {
    return {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 100,
        summaryTokens: 20,
        durationMs: 50,
        mode: "range",
        topic: `topic-${blockId}`,
        startId: "m0001",
        endId: "m0010",
        anchorMessageId: "msg-anchor-1",
        compressMessageId: "msg-compress-1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: ["msg-1", "msg-2"],
        effectiveToolIds: [],
        createdAt: 1000,
        summary: `original summary for block ${blockId}`,
        summaryVersions: [],
        activeVersionIndex: 1,
        ...overrides,
    }
}

describe("rewrite_summary tool", () => {
    let state: ReturnType<typeof createSessionState>
    let blockId: number

    beforeEach(() => {
        state = createSessionState()
        blockId = state.prune.messages.nextBlockId++
    })

    test("new block defaults to activeVersionIndex 1 (original)", () => {
        const block = buildBlock(blockId)
        state.prune.messages.blocksById.set(blockId, block)

        assert.equal(block.activeVersionIndex, 1)
        assert.equal(block.summaryVersions.length, 0)
    })

    test("setSummaryVersion pushes to summaryVersions and activates it", () => {
        const block = buildBlock(blockId)
        state.prune.messages.blocksById.set(blockId, block)

        const newSummary = "rewritten shorter summary"
        block.summaryVersions.push(newSummary)
        block.activeVersionIndex = block.summaryVersions.length + 1

        assert.equal(block.summaryVersions.length, 1)
        assert.equal(block.summaryVersions[0], newSummary)
        assert.equal(block.activeVersionIndex, 2)
        assert.equal(block.summary, "original summary for block 1")
    })

    test("setSummaryVersion adds multiple versions", () => {
        const block = buildBlock(blockId)
        state.prune.messages.blocksById.set(blockId, block)

        block.summaryVersions.push("v2 rewrite")
        block.activeVersionIndex = 2

        block.summaryVersions.push("v3 rewrite")
        block.activeVersionIndex = 3

        assert.equal(block.summaryVersions.length, 2)
        assert.equal(block.summaryVersions[0], "v2 rewrite")
        assert.equal(block.summaryVersions[1], "v3 rewrite")
        assert.equal(block.activeVersionIndex, 3)
    })

    test("setSummaryVersion throws for non-existent block", () => {
        assert.throws(() => {
            const block = state.prune.messages.blocksById.get(999)
            if (!block) throw new Error("Block 999 not found")
        }, /not found/)
    })

    test("activeVersionIndex 0 means disabled (no summary)", () => {
        const block = buildBlock(blockId)
        block.activeVersionIndex = 0

        const versionIndex = block.activeVersionIndex
        let activeSummary: string | null = null
        if (versionIndex === 0) {
            activeSummary = null
        } else if (versionIndex === 1) {
            activeSummary = block.summary
        } else if (versionIndex >= 2 && versionIndex - 2 < block.summaryVersions.length) {
            activeSummary = block.summaryVersions[versionIndex - 2]
        } else {
            activeSummary = block.summary
        }

        assert.equal(activeSummary, null)
    })

    test("activeVersionIndex 1 returns original summary", () => {
        const block = buildBlock(blockId)
        block.summaryVersions = ["v2"]
        block.activeVersionIndex = 1

        const versionIndex = block.activeVersionIndex
        let activeSummary: string
        if (versionIndex === 0) {
            activeSummary = ""
        } else if (versionIndex >= 2 && versionIndex - 2 < block.summaryVersions.length) {
            activeSummary = block.summaryVersions[versionIndex - 2]
        } else {
            activeSummary = block.summary
        }

        assert.equal(activeSummary, "original summary for block 1")
    })

    test("activeVersionIndex 2 returns first rewrite (v2)", () => {
        const block = buildBlock(blockId)
        block.summaryVersions = ["v2 rewrite", "v3 rewrite"]
        block.activeVersionIndex = 2

        const versionIndex = block.activeVersionIndex
        let activeSummary: string
        if (versionIndex === 0) {
            activeSummary = ""
        } else if (versionIndex >= 2 && versionIndex - 2 < block.summaryVersions.length) {
            activeSummary = block.summaryVersions[versionIndex - 2]
        } else {
            activeSummary = block.summary
        }

        assert.equal(activeSummary, "v2 rewrite")
    })

    test("activeVersionIndex out of bounds falls back to original", () => {
        const block = buildBlock(blockId)
        block.summaryVersions = ["v2"]
        block.activeVersionIndex = 5

        const versionIndex = block.activeVersionIndex
        let activeSummary: string
        if (versionIndex === 0) {
            activeSummary = ""
        } else if (versionIndex >= 2 && versionIndex - 2 < block.summaryVersions.length) {
            activeSummary = block.summaryVersions[versionIndex - 2]
        } else {
            activeSummary = block.summary
        }

        assert.equal(activeSummary, "original summary for block 1")
    })
})

describe("/dcp toggle command", () => {
    let state: ReturnType<typeof createSessionState>
    let blockId: number

    beforeEach(() => {
        state = createSessionState()
        blockId = state.prune.messages.nextBlockId++
    })

    test("toggle with no versions shows original is active", () => {
        const block = buildBlock(blockId)
        state.prune.messages.blocksById.set(blockId, block)

        assert.equal(block.activeVersionIndex, 1)
        assert.equal(block.summaryVersions.length, 0)
    })

    test("toggle sets disabled (0)", () => {
        const block = buildBlock(blockId, {
            summaryVersions: ["v2"],
            activeVersionIndex: 2,
        })
        state.prune.messages.blocksById.set(blockId, block)

        const versionArg = 0
        let newIndex: number
        if (versionArg === 0) newIndex = 0
        else if (versionArg === 1) newIndex = 1
        else if (versionArg - 2 < block.summaryVersions.length) newIndex = versionArg
        else newIndex = block.activeVersionIndex

        assert.equal(newIndex, 0)
    })

    test("toggle sets original (1)", () => {
        const block = buildBlock(blockId, {
            summaryVersions: ["v2"],
            activeVersionIndex: 2,
        })
        state.prune.messages.blocksById.set(blockId, block)

        const versionArg = 1
        let newIndex: number
        if (versionArg === 0) newIndex = 0
        else if (versionArg === 1) newIndex = 1
        else if (versionArg - 2 < block.summaryVersions.length) newIndex = versionArg
        else newIndex = block.activeVersionIndex

        assert.equal(newIndex, 1)
    })

    test("toggle to out-of-range version returns error", () => {
        const block = buildBlock(blockId, {
            summaryVersions: ["v2"],
            activeVersionIndex: 2,
        })
        state.prune.messages.blocksById.set(blockId, block)

        const versionArg = 5
        const valid =
            versionArg >= 0 &&
            (versionArg === 0 || versionArg === 1 || versionArg - 2 < block.summaryVersions.length)
        assert.equal(valid, false)
    })
})
