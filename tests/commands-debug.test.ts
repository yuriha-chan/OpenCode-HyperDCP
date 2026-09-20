import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join, isAbsolute } from "node:path"
import { tmpdir } from "node:os"
import { handleDebugCommand } from "../lib/commands/debug"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-dcp-debug-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-debug-config-tests-${process.pid}`)

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

// ── /dcp debug tests ────────────────────────────────────────────────────────

test("/dcp debug with no args shows OFF status by default", async () => {
    const sessionID = `ses_debug_off_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()

    await handleDebugCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: [],
        workingDirectory: tmpdir(),
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /OFF/)
    assert.match(output, /debug/i)
})

test("/dcp debug on <dir> enables and stores absolute directory", async () => {
    const sessionID = `ses_debug_on_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()

    const dir = join(tmpdir(), `dcp-debug-target-${Date.now()}`)
    mkdirSync(dir, { recursive: true })

    await handleDebugCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["on", dir],
        workingDirectory: tmpdir(),
    })

    assert.equal(state.debug?.enabled, true)
    assert.ok(state.debug?.directory)
    assert.ok(isAbsolute(state.debug!.directory!))
    assert.equal(state.debug!.directory, dir)
    const output = ignoredMessages.pop() || ""
    assert.match(output, /ON/)
})

test("/dcp debug off disables debug and clears directory", async () => {
    const sessionID = `ses_debug_off_disable_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    state.debug = { enabled: true, directory: join(tmpdir(), "somewhere") }
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()

    await handleDebugCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["off"],
        workingDirectory: tmpdir(),
    })

    assert.equal(state.debug?.enabled, false)
    assert.equal(state.debug?.directory, null)
    const output = ignoredMessages.pop() || ""
    assert.match(output, /OFF/)
})

test("/dcp debug on without directory shows usage error", async () => {
    const sessionID = `ses_debug_on_nodir_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()

    await handleDebugCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["on"],
        workingDirectory: tmpdir(),
    })

    assert.equal(state.debug?.enabled ?? false, false)
    const output = ignoredMessages.pop() || ""
    assert.match(output, /usage/i)
})

test("/dcp debug on with non-existent directory creates it", async () => {
    const sessionID = `ses_debug_on_create_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()

    const dir = join(tmpdir(), `dcp-debug-mkdir-${Date.now()}-${process.pid}`)
    assert.equal(existsSync(dir), false)

    try {
        await handleDebugCommand({
            client,
            state,
            logger,
            sessionId: sessionID,
            messages: rawMessages,
            args: ["on", dir],
            workingDirectory: tmpdir(),
        })

        assert.equal(state.debug?.enabled, true)
        assert.equal(existsSync(dir), true, "directory should be created")
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("/dcp debug on with relative path resolves against workingDirectory", async () => {
    const sessionID = `ses_debug_on_rel_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const { client } = makeClient()

    const workDir = join(tmpdir(), `dcp-debug-work-${Date.now()}`)
    mkdirSync(workDir, { recursive: true })

    try {
        await handleDebugCommand({
            client,
            state,
            logger,
            sessionId: sessionID,
            messages: rawMessages,
            args: ["on", "relative-debug-dir"],
            workingDirectory: workDir,
        })

        assert.equal(state.debug?.enabled, true)
        assert.equal(state.debug!.directory, join(workDir, "relative-debug-dir"))
        assert.equal(existsSync(state.debug!.directory!), true)
    } finally {
        rmSync(join(workDir, "relative-debug-dir"), { recursive: true, force: true })
        rmSync(workDir, { recursive: true, force: true })
    }
})

test("/dcp debug when ON shows directory in status", async () => {
    const sessionID = `ses_debug_on_status_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const dir = join(tmpdir(), `dcp-debug-status-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    state.debug = { enabled: true, directory: dir }
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()

    await handleDebugCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: [],
        workingDirectory: tmpdir(),
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /ON/)
    assert.match(output, new RegExp(dir.replace(/[/\\]/g, "\\$&")))
})

test("/dcp debug with unknown subcommand shows usage", async () => {
    const sessionID = `ses_debug_unknown_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const { client, ignoredMessages } = makeClient()

    await handleDebugCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["bogus"],
        workingDirectory: tmpdir(),
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /usage/i)
})

// ── query dump tests (integration via chat transform) ────────────────────────

test("chat transform dumps transformed messages to debug directory with YYYYMMDDHHMMSS.SSSS filename", async () => {
    const { createChatMessageTransformHandler } = await import("../lib/hooks")
    const dir = join(tmpdir(), `dcp-debug-dump-${Date.now()}-${process.pid}`)
    mkdirSync(dir, { recursive: true })
    try {
        const sessionID = `ses_debug_dump_${Date.now()}`
        const messages: WithParts[] = [
            {
                info: {
                    id: "raw-1",
                    role: "user",
                    sessionID,
                    agent: "assistant",
                    model: { providerID: "anthropic", modelID: "claude-test" },
                    time: { created: 1 },
                } as WithParts["info"],
                parts: [textPart("raw-1", sessionID, "p-1", "hi")],
            },
        ]
        const state = createSessionState()
        state.debug = { enabled: true, directory: dir }
        const logger = new Logger(false)
        const config = buildConfig()
        const prompts = {
            reload: () => undefined,
            getRuntimePrompts: () => ({
                baseSystem: "",
                toolPermission: "",
                compress: "",
                compressRange: "",
                compressMessage: "",
            }),
        } as any
        const hostPermissions = { global: undefined, agents: {} }

        const client = {
            session: {
                get: async () => ({ data: { parentID: null } }),
            },
        }

        const handler = createChatMessageTransformHandler(
            client,
            state,
            logger,
            config,
            prompts,
            hostPermissions,
        )

        await handler({}, { messages: messages as any })

        const files = readdirSync(dir)
        const jsonFiles = files.filter((f) => f.endsWith(".json"))
        assert.equal(jsonFiles.length, 1, "exactly one dump file")
        const name = jsonFiles[0]!
        assert.match(name, /^\d{8}\d{6}\.\d{4}\.json$/, "filename matches YYYYMMDDHHMMSS.SSSS.json")

        const content = JSON.parse(readFileSync(join(dir, name), "utf-8"))
        assert.ok(Array.isArray(content))
        assert.equal(content.length, 1)
        assert.equal(content[0].info.id, "raw-1")
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("chat transform does NOT dump when debug is disabled", async () => {
    const { createChatMessageTransformHandler } = await import("../lib/hooks")
    const dir = join(tmpdir(), `dcp-debug-off-${Date.now()}-${process.pid}`)
    mkdirSync(dir, { recursive: true })
    try {
        const sessionID = `ses_debug_off_dump_${Date.now()}`
        const messages: WithParts[] = [
            {
                info: {
                    id: "raw-1",
                    role: "user",
                    sessionID,
                    agent: "assistant",
                    model: { providerID: "anthropic", modelID: "claude-test" },
                    time: { created: 1 },
                } as WithParts["info"],
                parts: [textPart("raw-1", sessionID, "p-1", "hi")],
            },
        ]
        const state = createSessionState()
        state.debug = { enabled: false, directory: dir }
        const logger = new Logger(false)
        const config = buildConfig()
        const prompts = {
            reload: () => undefined,
            getRuntimePrompts: () => ({
                baseSystem: "",
                toolPermission: "",
                compress: "",
                compressRange: "",
                compressMessage: "",
            }),
        } as any
        const hostPermissions = { global: undefined, agents: {} }

        const client = {
            session: {
                get: async () => ({ data: { parentID: null } }),
            },
        }

        const handler = createChatMessageTransformHandler(
            client,
            state,
            logger,
            config,
            prompts,
            hostPermissions,
        )

        await handler({}, { messages: messages as any })

        const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
        assert.equal(files.length, 0, "no dump when debug disabled")
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
