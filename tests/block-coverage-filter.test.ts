import assert from "node:assert/strict"
import test from "node:test"
import { onChainCoverage } from "../lib/messages/coverage"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock } from "../lib/state/types"

function block(effectiveMessageIds: string[]): CompressionBlock {
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
        anchorMessageId: "anchor-1",
        compressMessageId: "anchor-1",
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
    }
}

test("onChainCoverage: all IDs active returns full list", () => {
    const b = block(["a", "b", "c"])
    const active = new Set(["a", "b", "c", "d", "e"])
    const result = onChainCoverage(b, active)
    assert.deepEqual(result, ["a", "b", "c"])
})

test("onChainCoverage: all IDs off-chain returns null", () => {
    const b = block(["x", "y", "z"])
    const active = new Set(["a", "b", "c"])
    const result = onChainCoverage(b, active)
    assert.equal(result, null)
})

test("onChainCoverage: mixed IDs returns on-chain subset preserving block order", () => {
    const b = block(["a", "x", "b", "y", "c"])
    const active = new Set(["a", "b", "c"])
    const result = onChainCoverage(b, active)
    assert.deepEqual(result, ["a", "b", "c"])
})

test("onChainCoverage: empty block returns null", () => {
    const b = block([])
    const active = new Set(["a", "b"])
    const result = onChainCoverage(b, active)
    assert.equal(result, null)
})
