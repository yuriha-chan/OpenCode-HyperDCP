import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { createToggleSummaryVersionTool } from "../lib/toggle-summary-version"
import { createSessionState, type CompressionBlock } from "../lib/state"
import { Logger } from "../lib/logger"
import type { PluginConfig } from "../lib/config"

const testDataHome = join(tmpdir(), `opencode-dcp-toggle-summary-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-toggle-summary-config-tests-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission: "allow",
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
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}

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
        summaryVersions: ["v2 rewrite", "v3 rewrite"],
        activeVersionIndex: 1,
        ...overrides,
    }
}

function makeCtx(state: ReturnType<typeof createSessionState>) {
    return {
        client: {},
        state,
        logger: new Logger(false),
        config: buildConfig(),
        prompts: {
            reload: () => undefined,
            getRuntimePrompts: () => ({}),
        },
    } as any
}

const toolCtx = {
    ask: async () => undefined,
    metadata: () => undefined,
    sessionID: "ses_toggle",
    messageID: "msg-toggle",
}

test("toggle_summary_version throws when autotoggle is disabled", async () => {
    const state = createSessionState()
    state.autotoggle = false
    const blockId = state.prune.messages.nextBlockId++
    state.prune.messages.blocksById.set(blockId, buildBlock(blockId))
    const tool = createToggleSummaryVersionTool(makeCtx(state))

    await assert.rejects(
        () => tool.execute({ blockId, version: 1 }, toolCtx),
        /autotoggle/i,
    )
    assert.equal(state.prune.messages.blocksById.get(blockId)!.activeVersionIndex, 1, "block untouched")
})

test("toggle_summary_version throws when autotoggle flag missing entirely", async () => {
    const state = createSessionState()
    delete (state as any).autotoggle
    const blockId = state.prune.messages.nextBlockId++
    state.prune.messages.blocksById.set(blockId, buildBlock(blockId))
    const tool = createToggleSummaryVersionTool(makeCtx(state))

    await assert.rejects(
        () => tool.execute({ blockId, version: 1 }, toolCtx),
        /autotoggle/i,
    )
})

test("toggle_summary_version throws when block does not exist", async () => {
    const state = createSessionState()
    state.autotoggle = true
    const tool = createToggleSummaryVersionTool(makeCtx(state))

    await assert.rejects(
        () => tool.execute({ blockId: 999, version: 1 }, toolCtx),
        /block.*not found/i,
    )
})

test("toggle_summary_version throws when version is negative", async () => {
    const state = createSessionState()
    state.autotoggle = true
    const blockId = state.prune.messages.nextBlockId++
    state.prune.messages.blocksById.set(blockId, buildBlock(blockId))
    const tool = createToggleSummaryVersionTool(makeCtx(state))

    await assert.rejects(
        () => tool.execute({ blockId, version: -1 }, toolCtx),
        /version/i,
    )
})

test("toggle_summary_version throws when version is out of range", async () => {
    const state = createSessionState()
    state.autotoggle = true
    const blockId = state.prune.messages.nextBlockId++
    const block = buildBlock(blockId, { summaryVersions: ["v2"], activeVersionIndex: 1 })
    state.prune.messages.blocksById.set(blockId, block)
    const tool = createToggleSummaryVersionTool(makeCtx(state))

    await assert.rejects(
        () => tool.execute({ blockId, version: 5 }, toolCtx),
        /version/i,
    )
})

test("toggle_summary_version sets version 0 (disabled)", async () => {
    const state = createSessionState()
    state.autotoggle = true
    const blockId = state.prune.messages.nextBlockId++
    state.prune.messages.blocksById.set(blockId, buildBlock(blockId, { activeVersionIndex: 2 }))
    const tool = createToggleSummaryVersionTool(makeCtx(state))

    const result = await tool.execute({ blockId, version: 0 }, toolCtx)

    assert.match(result, new RegExp(`block #${blockId}.*disabled`, "i"))
    assert.equal(state.prune.messages.blocksById.get(blockId)!.activeVersionIndex, 0)
})

test("toggle_summary_version sets version 1 (original)", async () => {
    const state = createSessionState()
    state.autotoggle = true
    const blockId = state.prune.messages.nextBlockId++
    state.prune.messages.blocksById.set(blockId, buildBlock(blockId, { activeVersionIndex: 3 }))
    const tool = createToggleSummaryVersionTool(makeCtx(state))

    const result = await tool.execute({ blockId, version: 1 }, toolCtx)

    assert.match(result, /v1|original/i)
    assert.equal(state.prune.messages.blocksById.get(blockId)!.activeVersionIndex, 1)
})

test("toggle_summary_version sets version 2 (first rewrite)", async () => {
    const state = createSessionState()
    state.autotoggle = true
    const blockId = state.prune.messages.nextBlockId++
    state.prune.messages.blocksById.set(blockId, buildBlock(blockId, { activeVersionIndex: 1 }))
    const tool = createToggleSummaryVersionTool(makeCtx(state))

    const result = await tool.execute({ blockId, version: 2 }, toolCtx)

    assert.match(result, /v2/)
    assert.equal(state.prune.messages.blocksById.get(blockId)!.activeVersionIndex, 2)
})

test("toggle_summary_version sets version 3 (second rewrite)", async () => {
    const state = createSessionState()
    state.autotoggle = true
    const blockId = state.prune.messages.nextBlockId++
    state.prune.messages.blocksById.set(blockId, buildBlock(blockId, { activeVersionIndex: 1 }))
    const tool = createToggleSummaryVersionTool(makeCtx(state))

    const result = await tool.execute({ blockId, version: 3 }, toolCtx)

    assert.match(result, /v3/)
    assert.equal(state.prune.messages.blocksById.get(blockId)!.activeVersionIndex, 3)
})

test("toggle_summary_version mutates block state in-place", async () => {
    const state = createSessionState()
    state.autotoggle = true
    const blockId = state.prune.messages.nextBlockId++
    state.prune.messages.blocksById.set(blockId, buildBlock(blockId, { activeVersionIndex: 1 }))
    const tool = createToggleSummaryVersionTool(makeCtx(state))

    await tool.execute({ blockId, version: 2 }, toolCtx)

    const block = state.prune.messages.blocksById.get(blockId)!
    assert.equal(block.activeVersionIndex, 2)
})
