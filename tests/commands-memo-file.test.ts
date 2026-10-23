import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, writeFileSync } from "node:fs"
import { handleMemoFileCommand } from "../lib/commands/memo-file"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { handleMemoCommand } from "../lib/commands/memo"

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
    const promptCalls: Array<{
        path?: { id: string }
        body: { parts: Array<{ text: string }> }
    }> = []
    return {
        client: {
            session: {
                messages: async () => ({ data: [] }),
                prompt: async (input: {
                    path?: { id: string }
                    body: { parts: Array<{ text: string }> }
                }) => {
                    const { body } = input
                    promptCalls.push(input)
                    ignoredMessages.push(body.parts[0]?.text || "")
                },
            },
        },
        ignoredMessages,
        promptCalls,
    }
}

function assertPromptCall(
    promptCalls: ReturnType<typeof makeClient>["promptCalls"],
    sessionID: string,
    expected: RegExp,
) {
    assert.equal(promptCalls.length, 1)
    assert.equal(promptCalls[0]?.path?.id, sessionID)
    assert.match(promptCalls[0]?.body.parts[0]?.text ?? "", expected)
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
    const { client, ignoredMessages, promptCalls } = makeClient()
    const path = writeTempFile("Remember the plan\nsecond line")

    await handleMemoFileCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: [path],
    })

    assert.deepEqual(state.memo, ["Remember the plan\nsecond line"])
    const output = ignoredMessages.pop() || ""
    assert.match(output, /memo updated/i)
    assertPromptCall(promptCalls, sessionID, /memo updated/i)
})

test("/dcp memo-file overwrites an existing memo", async () => {
    const sessionID = `ses_memo_file_overwrite_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.memo = ["old memo"]
    const logger = new Logger(false)
    const { client, promptCalls } = makeClient()
    const path = writeTempFile("new memo")

    await handleMemoFileCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: [path],
    })

    assert.deepEqual(state.memo, ["new memo"])
    assertPromptCall(promptCalls, sessionID, /memo updated/i)
})

test("/dcp memo-file without arguments shows usage", async () => {
    const sessionID = `ses_memo_file_usage_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.memo = ["unchanged"]
    const logger = new Logger(false)
    const { client, ignoredMessages, promptCalls } = makeClient()

    await handleMemoFileCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: [],
    })

    assert.deepEqual(state.memo, ["unchanged"])
    const output = ignoredMessages.pop() || ""
    assert.match(output, /usage/i)
    assertPromptCall(promptCalls, sessionID, /usage/i)
})

test("/dcp memo-file reports a missing file", async () => {
    const sessionID = `ses_memo_file_missing_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.memo = ["unchanged"]
    const logger = new Logger(false)
    const { client, ignoredMessages, promptCalls } = makeClient()

    await handleMemoFileCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: [join(tmpdir(), `definitely-missing-memo-${Date.now()}.txt`)],
    })

    assert.deepEqual(state.memo, ["unchanged"])
    const output = ignoredMessages.pop() || ""
    assert.match(output, /could not read/i)
    assertPromptCall(promptCalls, sessionID, /could not read/i)
})

test("/dcp memo-file normalizes an empty file to a null memo", async () => {
    const sessionID = `ses_memo_file_empty_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.memo = ["unchanged"]
    const logger = new Logger(false)
    const { client, ignoredMessages, promptCalls } = makeClient()
    const path = writeTempFile("   \n\t\n")

    await handleMemoFileCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: [path],
    })

    assert.equal(state.memo, null)
    const output = ignoredMessages.pop() || ""
    assert.match(output, /empty|cleared/i)
    assertPromptCall(promptCalls, sessionID, /empty|cleared/i)
})

test("/dcp memo set replaces the structured memo and retains header-only sections", async () => {
    const sessionID = `ses_memo_set_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.memo = ["old memo"]
    const { client, ignoredMessages, promptCalls } = makeClient()

    await handleMemoCommand(
        {
            client,
            state,
            logger: new Logger(false),
            sessionId: sessionID,
            messages: buildMessages(sessionID),
        },
        ["set", "# Plan\n- first step\n## Empty"],
    )

    assert.deepEqual(state.memo, [
        { topic: "Plan", items: ["first step", { topic: "Empty", items: [] }] },
    ])
    assert.match(ignoredMessages.join("\n"), /Memo set/i)
    assertPromptCall(promptCalls, sessionID, /Memo set/i)
})

test("blank /dcp memo set normalizes the memo to null", async () => {
    const sessionID = `ses_memo_set_blank_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.memo = ["old memo"]
    const { client, promptCalls } = makeClient()

    await handleMemoCommand(
        {
            client,
            state,
            logger: new Logger(false),
            sessionId: sessionID,
            messages: buildMessages(sessionID),
        },
        ["set", "   "],
    )

    assert.equal(state.memo, null)
    assertPromptCall(promptCalls, sessionID, /Memo cleared/i)
})

test("/dcp memo clear removes the entire structured tree", async () => {
    const sessionID = `ses_memo_clear_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.memo = [{ topic: "Plan", items: ["first", { topic: "Details", items: ["second"] }] }]
    const { client, promptCalls } = makeClient()

    await handleMemoCommand(
        {
            client,
            state,
            logger: new Logger(false),
            sessionId: sessionID,
            messages: buildMessages(sessionID),
        },
        ["clear"],
    )

    assert.equal(state.memo, null)
    assertPromptCall(promptCalls, sessionID, /Memo cleared/i)
})

test("/dcp memo set repairs malformed headings without restoring the previous memo", async () => {
    const sessionID = `ses_memo_set_repair_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.memo = ["previous content"]
    const { client, promptCalls } = makeClient()

    await handleMemoCommand(
        {
            client,
            state,
            logger: new Logger(false),
            sessionId: sessionID,
            messages: buildMessages(sessionID),
        },
        ["set", "# Topic/Name\n- supplied content"],
    )

    assert.deepEqual(state.memo, [{ topic: "Topic-Name", items: ["supplied content"] }])
    assertPromptCall(promptCalls, sessionID, /Memo set/i)
})

test("/dcp memo show renders nested headings and unindented bullets", async () => {
    const sessionID = `ses_memo_show_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.memo = [{ topic: "Plan", items: ["first", { topic: "Details", items: ["second"] }] }]
    const { client, promptCalls } = makeClient()

    await handleMemoCommand(
        {
            client,
            state,
            logger: new Logger(false),
            sessionId: sessionID,
            messages: buildMessages(sessionID),
        },
        ["show"],
    )

    assert.equal(promptCalls.length, 1)
    assert.equal(promptCalls[0]?.path?.id, sessionID)
    assert.equal(
        promptCalls[0]?.body.parts[0]?.text,
        "[Memo]\n# Plan\n- first\n## Details\n- second",
    )
})

test("memo-file parses and replaces a structured memo instead of merging old content", async () => {
    const sessionID = `ses_memo_file_structured_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.memo = ["old memo"]
    const { client, promptCalls } = makeClient()
    const path = writeTempFile("# Plan\n- first step\n## Empty")

    await handleMemoFileCommand({
        client,
        state,
        logger: new Logger(false),
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: [path],
    })

    assert.deepEqual(state.memo, [
        { topic: "Plan", items: ["first step", { topic: "Empty", items: [] }] },
    ])
    assertPromptCall(promptCalls, sessionID, /Memo updated/i)
})

test("memo-file keeps repaired supplied content instead of restoring the previous memo", async () => {
    const sessionID = `ses_memo_file_repair_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.memo = ["previous content"]
    const { client, promptCalls } = makeClient()
    const path = writeTempFile("# Topic/Name\n- supplied content")

    await handleMemoFileCommand({
        client,
        state,
        logger: new Logger(false),
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: [path],
    })

    assert.deepEqual(state.memo, [{ topic: "Topic-Name", items: ["supplied content"] }])
    assertPromptCall(promptCalls, sessionID, /Memo updated/i)
})
