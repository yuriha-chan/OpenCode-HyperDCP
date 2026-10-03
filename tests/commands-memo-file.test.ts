import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, writeFileSync } from "node:fs"
import { handleMemoFileCommand } from "../lib/commands/memo-file"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-dcp-memo-file-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-memo-file-config-tests-${process.pid}`)

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

let fileCounter = 0
function writeTempFile(content: string): string {
    fileCounter += 1
    const path = join(tmpdir(), `opencode-dcp-memo-file-${process.pid}-${fileCounter}.txt`)
    writeFileSync(path, content, "utf-8")
    return path
}

test("/dcp memo-file applies file content to the memo", async () => {
    const sessionID = `ses_memo_file_apply_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()
    const path = writeTempFile("Remember the plan\nsecond line")

    await handleMemoFileCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: [path],
    })

    assert.equal(state.memo, "Remember the plan\nsecond line")
    const output = ignoredMessages.pop() || ""
    assert.match(output, /memo updated/i)
})

test("/dcp memo-file overwrites an existing memo", async () => {
    const sessionID = `ses_memo_file_overwrite_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.memo = "old memo"
    const logger = new Logger(false)
    const { client } = makeClient()
    const path = writeTempFile("new memo")

    await handleMemoFileCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: [path],
    })

    assert.equal(state.memo, "new memo")
})

test("/dcp memo-file without arguments shows usage", async () => {
    const sessionID = `ses_memo_file_usage_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.memo = "unchanged"
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()

    await handleMemoFileCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: [],
    })

    assert.equal(state.memo, "unchanged")
    const output = ignoredMessages.pop() || ""
    assert.match(output, /usage/i)
})

test("/dcp memo-file reports a missing file", async () => {
    const sessionID = `ses_memo_file_missing_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.memo = "unchanged"
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()

    await handleMemoFileCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: [join(tmpdir(), `definitely-missing-memo-${Date.now()}.txt`)],
    })

    assert.equal(state.memo, "unchanged")
    const output = ignoredMessages.pop() || ""
    assert.match(output, /could not read/i)
})

test("/dcp memo-file rejects an empty file", async () => {
    const sessionID = `ses_memo_file_empty_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.memo = "unchanged"
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()
    const path = writeTempFile("   \n\t\n")

    await handleMemoFileCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: [path],
    })

    assert.equal(state.memo, "unchanged")
    const output = ignoredMessages.pop() || ""
    assert.match(output, /empty/i)
})
