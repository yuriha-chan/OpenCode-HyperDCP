import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { handleProtectCommand } from "../lib/commands/protect"
import { handleUnprotectCommand } from "../lib/commands/unprotect"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-dcp-protect-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-protect-config-tests-${process.pid}`)

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
            parts: [textPart("raw-1", sessionID, "p-1", "Implement feature X")],
        },
        {
            info: {
                id: "raw-2",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [textPart("raw-2", sessionID, "p-2", "Working on it")],
        },
        {
            info: {
                id: "raw-3",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 3 },
            } as WithParts["info"],
            parts: [textPart("raw-3", sessionID, "p-3", "Also fix bug Y")],
        },
    ]
}

function setupState(rawMessages: WithParts[]): ReturnType<typeof createSessionState> {
    const state = createSessionState()
    state.messageIds.byRawId.set("raw-1", "m0001")
    state.messageIds.byRef.set("m0001", "raw-1")
    state.messageIds.byRawId.set("raw-2", "m0002")
    state.messageIds.byRef.set("m0002", "raw-2")
    state.messageIds.byRawId.set("raw-3", "m0003")
    state.messageIds.byRef.set("m0003", "raw-3")
    return state
}

// ── /dcp protect tests ──────────────────────────────────────────────────────

test("/dcp protect with no args lists protected messages", async () => {
    const sessionID = `ses_protect_list_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = setupState(rawMessages)
    const logger = new Logger(false)
    const ignoredMessages: string[] = []

    state.protectedRefs.add("m0001")
    state.protectedRefs.add("m0003")

    const client = {
        session: {
            messages: async () => ({ data: rawMessages }),
            prompt: async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
                ignoredMessages.push(body.parts[0]?.text || "")
            },
        },
    }

    await handleProtectCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: [],
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /m0001/)
    assert.match(output, /m0003/)
    assert.match(output, /2 protected/)
})

test("/dcp protect <n> adds message ref to protected set", async () => {
    const sessionID = `ses_protect_add_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = setupState(rawMessages)
    const logger = new Logger(false)
    const ignoredMessages: string[] = []

    const client = {
        session: {
            messages: async () => ({ data: rawMessages }),
            get: async () => ({ data: { parentID: null } }),
            prompt: async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
                ignoredMessages.push(body.parts[0]?.text || "")
            },
        },
    }

    assert.equal(state.protectedRefs.size, 0)

    await handleProtectCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["m0002"],
    })

    assert.ok(state.protectedRefs.has("m0002"))
    const output = ignoredMessages.pop() || ""
    assert.match(output, /protected/i)
    assert.match(output, /m0002/)
})

test("/dcp protect numeric arg works", async () => {
    const sessionID = `ses_protect_numeric_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = setupState(rawMessages)
    const logger = new Logger(false)
    const ignoredMessages: string[] = []

    const client = {
        session: {
            messages: async () => ({ data: rawMessages }),
            get: async () => ({ data: { parentID: null } }),
            prompt: async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
                ignoredMessages.push(body.parts[0]?.text || "")
            },
        },
    }

    await handleProtectCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["1"],
    })

    assert.ok(state.protectedRefs.has("m0001"))
})

test("/dcp protect already-protected message shows info", async () => {
    const sessionID = `ses_protect_dup_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = setupState(rawMessages)
    state.protectedRefs.add("m0001")
    const logger = new Logger(false)
    const ignoredMessages: string[] = []

    const client = {
        session: {
            messages: async () => ({ data: rawMessages }),
            get: async () => ({ data: { parentID: null } }),
            prompt: async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
                ignoredMessages.push(body.parts[0]?.text || "")
            },
        },
    }

    await handleProtectCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["m0001"],
    })

    assert.ok(state.protectedRefs.has("m0001"))
    const output = ignoredMessages.pop() || ""
    assert.match(output, /already protected/i)
})

test("/dcp protect invalid ref shows error", async () => {
    const sessionID = `ses_protect_bad_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = setupState(rawMessages)
    const logger = new Logger(false)
    const ignoredMessages: string[] = []

    const client = {
        session: {
            messages: async () => ({ data: rawMessages }),
            prompt: async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
                ignoredMessages.push(body.parts[0]?.text || "")
            },
        },
    }

    await handleProtectCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["abc"],
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /message.*id|invalid/i)
})

test("/dcp protect non-existent ref shows error", async () => {
    const sessionID = `ses_protect_noexist_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = setupState(rawMessages)
    const logger = new Logger(false)
    const ignoredMessages: string[] = []

    const client = {
        session: {
            messages: async () => ({ data: rawMessages }),
            prompt: async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
                ignoredMessages.push(body.parts[0]?.text || "")
            },
        },
    }

    await handleProtectCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["m0099"],
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /not.*context/i)
})

// ── /dcp unprotect tests ────────────────────────────────────────────────────

test("/dcp unprotect with no args lists protected messages", async () => {
    const sessionID = `ses_unprotect_list_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = setupState(rawMessages)
    state.protectedRefs.add("m0001")
    const logger = new Logger(false)
    const ignoredMessages: string[] = []

    const client = {
        session: {
            messages: async () => ({ data: rawMessages }),
            prompt: async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
                ignoredMessages.push(body.parts[0]?.text || "")
            },
        },
    }

    await handleUnprotectCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: [],
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /m0001/)
})

test("/dcp unprotect <n> removes message ref from protected set", async () => {
    const sessionID = `ses_unprotect_remove_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = setupState(rawMessages)
    state.protectedRefs.add("m0001")
    const logger = new Logger(false)
    const ignoredMessages: string[] = []

    const client = {
        session: {
            messages: async () => ({ data: rawMessages }),
            get: async () => ({ data: { parentID: null } }),
            prompt: async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
                ignoredMessages.push(body.parts[0]?.text || "")
            },
        },
    }

    assert.ok(state.protectedRefs.has("m0001"))

    await handleUnprotectCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["m0001"],
    })

    assert.equal(state.protectedRefs.has("m0001"), false)
    const output = ignoredMessages.pop() || ""
    assert.match(output, /unprotected/i)
})

test("/dcp unprotect not-protected message shows info", async () => {
    const sessionID = `ses_unprotect_not_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = setupState(rawMessages)
    const logger = new Logger(false)
    const ignoredMessages: string[] = []

    const client = {
        session: {
            messages: async () => ({ data: rawMessages }),
            prompt: async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
                ignoredMessages.push(body.parts[0]?.text || "")
            },
        },
    }

    await handleUnprotectCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["m0001"],
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /not.*protected/i)
})
