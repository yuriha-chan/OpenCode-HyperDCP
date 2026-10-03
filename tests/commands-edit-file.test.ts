import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, writeFileSync } from "node:fs"
import { handleEditFileCommand } from "../lib/commands/edit-file"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock } from "../lib/state/types"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-dcp-edit-file-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-edit-file-config-tests-${process.pid}`)

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
            mode: "range",
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
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

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return { id, messageID, sessionID, type: "text" as const, text }
}

function buildMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-user-1", sessionID, "part-1", "Hello")],
        },
    ]
}

function makeClient() {
    const ignoredMessages: string[] = []
    return {
        client: {
            session: {
                messages: async () => ({ data: [] }),
                prompt: async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
                    ignoredMessages.push(body.parts[0]?.text || "")
                },
            },
        },
        ignoredMessages,
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
        anchorMessageId: "msg-1",
        compressMessageId: "msg-1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "old summary",
        summaryVersions: [],
        activeVersionIndex: 1,
        ...overrides,
    }
}

function seedBlock(state: ReturnType<typeof createSessionState>, overrides?: Partial<CompressionBlock>) {
    const block = makeBlock(overrides ?? {})
    state.prune.messages.blocksById.set(block.blockId, block)
    return block
}

let fileCounter = 0
function writeTempFile(content: string): string {
    fileCounter += 1
    const path = join(tmpdir(), `opencode-dcp-edit-file-${process.pid}-${fileCounter}.txt`)
    writeFileSync(path, content, "utf-8")
    return path
}

test("/dcp edit-file applies file content as a new active version", async () => {
    const sessionID = `ses_edit_file_apply_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    const block = seedBlock(state)
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()
    const path = writeTempFile("Brand new summary\nsecond line")

    await handleEditFileCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: ["1", path],
    })

    assert.equal(block.summaryVersions.length, 1)
    assert.equal(block.summaryVersions[0], "Brand new summary\nsecond line")
    assert.equal(block.activeVersionIndex, 2)
    const output = ignoredMessages.pop() || ""
    assert.match(output, /v2/i)
})

test("/dcp edit-file appends on top of existing versions", async () => {
    const sessionID = `ses_edit_file_append_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    const block = seedBlock(state, { summaryVersions: ["previous rewrite"], activeVersionIndex: 2 })
    const logger = new Logger(false)
    const { client } = makeClient()
    const path = writeTempFile("third version")

    await handleEditFileCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: ["1", path],
    })

    assert.deepEqual(block.summaryVersions, ["previous rewrite", "third version"])
    assert.equal(block.activeVersionIndex, 3)
})

test("/dcp edit-file without arguments shows usage", async () => {
    const sessionID = `ses_edit_file_usage_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    const block = seedBlock(state)
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()

    await handleEditFileCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: [],
    })

    assert.equal(block.summaryVersions.length, 0)
    const output = ignoredMessages.pop() || ""
    assert.match(output, /usage/i)
})

test("/dcp edit-file reports a missing file", async () => {
    const sessionID = `ses_edit_file_missing_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    const block = seedBlock(state)
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()

    await handleEditFileCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: ["1", join(tmpdir(), `definitely-missing-${Date.now()}.txt`)],
    })

    assert.equal(block.summaryVersions.length, 0)
    const output = ignoredMessages.pop() || ""
    assert.match(output, /could not read/i)
})

test("/dcp edit-file rejects an empty file", async () => {
    const sessionID = `ses_edit_file_empty_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    const block = seedBlock(state)
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()
    const path = writeTempFile("   \n\t\n")

    await handleEditFileCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: ["1", path],
    })

    assert.equal(block.summaryVersions.length, 0)
    const output = ignoredMessages.pop() || ""
    assert.match(output, /empty/i)
})

test("/dcp edit-file rejects an invalid block id", async () => {
    const sessionID = `ses_edit_file_badid_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    seedBlock(state)
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()
    const path = writeTempFile("content")

    await handleEditFileCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: ["abc", path],
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /compression number/i)
})

test("/dcp edit-file reports an unknown block", async () => {
    const sessionID = `ses_edit_file_unknown_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    seedBlock(state, { blockId: 1 })
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()
    const path = writeTempFile("content")

    await handleEditFileCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: ["99", path],
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /does not exist/i)
})
