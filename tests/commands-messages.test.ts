import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { handleMessagesCommand } from "../lib/commands/messages"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-dcp-messages-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-messages-config-tests-${process.pid}`)

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
    const msgs: WithParts[] = []
    for (let i = 1; i <= 12; i++) {
        const id = `raw-${i}`
        const role = i % 2 === 1 ? "user" : "assistant"
        msgs.push({
            info: {
                id,
                role,
                sessionID,
                agent: "assistant",
                model:
                    role === "user"
                        ? { providerID: "anthropic", modelID: "claude-test" }
                        : undefined,
                time: { created: i },
            } as WithParts["info"],
            parts: [
                textPart(
                    id,
                    sessionID,
                    `p-${i}`,
                    `Message ${i}: This is the content of message number ${i} in the conversation.`,
                ),
            ],
        })
    }
    return msgs
}

function setupState(rawMessages: WithParts[]): ReturnType<typeof createSessionState> {
    const state = createSessionState()
    for (let i = 1; i <= rawMessages.length; i++) {
        const ref = `m${String(i).padStart(4, "0")}`
        state.messageIds.byRawId.set(`raw-${i}`, ref)
        state.messageIds.byRef.set(ref, `raw-${i}`)
    }
    return state
}

// ── /dcp messages tests ─────────────────────────────────────────────────────

test("/dcp messages with no args shows recent 10 messages", async () => {
    const sessionID = `ses_msgs_recent_${Date.now()}`
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

    await handleMessagesCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: [],
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /\d message/, "should show message count header")
    assert.match(output, /m0012/, "should include 12th message")
    assert.doesNotMatch(output, /m0001/, "should NOT include 1st message (outside recent 10)")
    assert.doesNotMatch(output, /m0002/, "should NOT include 2nd message")
    assert.match(output, /- user/, "should show role with status")
    assert.match(output, /- assistant/, "should show role with status")
})

test("/dcp messages with message range shows only those messages", async () => {
    const sessionID = `ses_msgs_range_${Date.now()}`
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

    await handleMessagesCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["m0001", "m0003"],
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /m0001/)
    assert.match(output, /m0002/)
    assert.match(output, /m0003/)
    assert.doesNotMatch(output, /m0004/)
})

test("/dcp messages shows truncation for long content", async () => {
    const sessionID = `ses_msgs_trunc_${Date.now()}`
    const rawMessages: WithParts[] = [
        {
            info: {
                id: "raw-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("raw-1", sessionID, "p-1", "A".repeat(200))],
        },
    ]
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

    await handleMessagesCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: [],
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /\.\.\.$/, "should have trailing ellipsis for truncated content")
    const lineCount = output.split("\n").length
    const line = output.split("\n").filter((l) => l.includes("A"))[0] || ""
    assert.ok(line.length < 180, "truncated line should be under 180 chars")
})

test("/dcp messages marks protected messages", async () => {
    const sessionID = `ses_msgs_protected_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = setupState(rawMessages)
    state.protectedRefs.add("m0012")
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

    await handleMessagesCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: [],
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /P assistant/, "should show P status for protected message")
})

test("/dcp messages shows filename for read/edit and command for bash", async () => {
    const sessionID = `ses_msgs_toolpreview_${Date.now()}`
    const rawMessages: WithParts[] = [
        {
            info: {
                id: "raw-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                {
                    id: "p-1",
                    messageID: "raw-1",
                    sessionID,
                    type: "tool" as const,
                    tool: "read",
                    callID: "c1",
                    state: {
                        status: "completed" as const,
                        input: { filePath: "/src/auth.ts" },
                        output: "...",
                    },
                },
            ],
        },
        {
            info: {
                id: "raw-2",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                {
                    id: "p-2",
                    messageID: "raw-2",
                    sessionID,
                    type: "tool" as const,
                    tool: "bash",
                    callID: "c2",
                    state: {
                        status: "completed" as const,
                        input: { command: "npm test" },
                        output: "...",
                    },
                },
            ],
        },
        {
            info: {
                id: "raw-3",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                {
                    id: "p-3",
                    messageID: "raw-3",
                    sessionID,
                    type: "tool" as const,
                    tool: "edit",
                    callID: "c3",
                    state: {
                        status: "completed" as const,
                        input: { filePath: "/src/index.ts" },
                        output: "...",
                    },
                },
            ],
        },
    ]
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

    await handleMessagesCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: [],
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /\[read \/src\/auth\.ts\]/, "should show read filename")
    assert.match(output, /\[bash npm test\]/, "should show bash command")
    assert.match(output, /\[edit \/src\/index\.ts\]/, "should show edit filename")
})
