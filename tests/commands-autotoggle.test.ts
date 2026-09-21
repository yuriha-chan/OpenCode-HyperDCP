import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { handleAutotoggleCommand } from "../lib/commands/autotoggle"
import { createSessionState, type WithParts } from "../lib/state"
import { Logger } from "../lib/logger"
import type { PluginConfig } from "../lib/config"
import { resetSessionState } from "../lib/state/state"

const testDataHome = join(tmpdir(), `opencode-dcp-autotoggle-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-autotoggle-config-tests-${process.pid}`)

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

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return { id, messageID, sessionID, type: "text" as const, text }
}

function buildMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "raw-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("raw-1", sessionID, "p-1", "Hello")],
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

// ── /dcp autotoggle tests ─────────────────────────────────────────────────────

test("/dcp autotoggle with no args shows OFF status by default", async () => {
    const sessionID = `ses_autotoggle_off_${Date.now()}`
    const state = createSessionState()
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()

    await handleAutotoggleCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: [],
    } as any)

    const output = ignoredMessages.pop() || ""
    assert.match(output, /OFF/i)
    assert.match(output, /autotoggle/i)
})

test("/dcp autotoggle on enables the flag", async () => {
    const sessionID = `ses_autotoggle_on_${Date.now()}`
    const state = createSessionState()
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()

    await handleAutotoggleCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: ["on"],
    } as any)

    assert.equal(state.autotoggle, true)
    const output = ignoredMessages.pop() || ""
    assert.match(output, /ON/i)
})

test("/dcp autotoggle off disables the flag", async () => {
    const sessionID = `ses_autotoggle_off_${Date.now()}`
    const state = createSessionState()
    state.autotoggle = true
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()

    await handleAutotoggleCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: ["off"],
    } as any)

    assert.equal(state.autotoggle, false)
    const output = ignoredMessages.pop() || ""
    assert.match(output, /OFF/i)
})

test("/dcp autotoggle with unknown subcommand shows usage", async () => {
    const sessionID = `ses_autotoggle_bogus_${Date.now()}`
    const state = createSessionState()
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()

    await handleAutotoggleCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: ["bogus"],
    } as any)

    const output = ignoredMessages.pop() || ""
    assert.match(output, /usage/i)
    assert.equal(state.autotoggle, false)
})

test("/dcp autotoggle status when ON shows enabled in output", async () => {
    const sessionID = `ses_autotoggle_status_${Date.now()}`
    const state = createSessionState()
    state.autotoggle = true
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()

    await handleAutotoggleCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: buildMessages(sessionID),
        args: [],
    } as any)

    const output = ignoredMessages.pop() || ""
    assert.match(output, /ON/i)
})

test("autotoggle flag is reset by resetSessionState (per-session)", () => {
    const state = createSessionState()
    state.autotoggle = true

    resetSessionState(state)

    assert.equal(state.autotoggle, false)
})
