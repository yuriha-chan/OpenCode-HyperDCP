import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, existsSync, readFileSync } from "node:fs"
import { handleViewCommand } from "../lib/commands/view"
import { handleEditCommand } from "../lib/commands/edit"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-dcp-commands-view-edit-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-commands-view-edit-config-${process.pid}`)

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
        commands: {
            enabled: true,
            protectedTools: [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: false,
            customPrompts: false,
        },
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
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
    }
}

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function buildMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-user-1", sessionID, "part-1", "Investigate the issue")],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [textPart("msg-assistant-1", sessionID, "part-2", "I mapped the code path")],
        },
        {
            info: {
                id: "msg-assistant-2",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 3 },
            } as WithParts["info"],
            parts: [textPart("msg-assistant-2", sessionID, "part-3", "I also ran a task tool")],
        },
    ]
}

function addCompressionBlock(
    state: ReturnType<typeof createSessionState>,
    rawMessages: WithParts[],
    sessionID: string,
    overrides: {
        blockId: number
        runId: number
        mode?: "range" | "message"
        topic?: string
        summary?: string
        batchTopic?: string
        active?: boolean
        deactivatedByUser?: boolean
        compressedTokens?: number
        summaryTokens?: number
        durationMs?: number
        startId?: string
        endId?: string
        anchorMessageId?: string
        compressMessageId?: string
        includedBlockIds?: number[]
        consumedBlockIds?: number[]
        parentBlockIds?: number[]
    },
) {
    const block = {
        blockId: overrides.blockId,
        runId: overrides.runId,
        active: overrides.active ?? true,
        deactivatedByUser: overrides.deactivatedByUser ?? false,
        compressedTokens: overrides.compressedTokens ?? 500,
        summaryTokens: overrides.summaryTokens ?? 80,
        durationMs: overrides.durationMs ?? 1000,
        mode: overrides.mode ?? "range",
        topic: overrides.topic ?? `Topic for block ${overrides.blockId}`,
        batchTopic: overrides.batchTopic,
        startId: overrides.startId ?? `m${String(overrides.blockId).padStart(4, "0")}`,
        endId: overrides.endId ?? `m${String(overrides.blockId).padStart(4, "0")}`,
        anchorMessageId: overrides.anchorMessageId ?? `anchor-${overrides.blockId}`,
        compressMessageId: overrides.compressMessageId ?? `compress-${overrides.blockId}`,
        compressCallId: `call-${overrides.blockId}`,
        includedBlockIds: overrides.includedBlockIds ?? [],
        consumedBlockIds: overrides.consumedBlockIds ?? [],
        parentBlockIds: overrides.parentBlockIds ?? [],
        directMessageIds: [`msg-${overrides.blockId}`],
        directToolIds: [],
        effectiveMessageIds: [`msg-${overrides.blockId}`],
        effectiveToolIds: [],
        createdAt: Date.now(),
        deactivatedAt: undefined,
        deactivatedByBlockId: undefined,
        summary: overrides.summary ?? `[Compressed conversation section]\nSummary for block ${overrides.blockId}.\nDetails here.`,
    }

    state.prune.messages.blocksById.set(overrides.blockId, block)

    if (block.active) {
        state.prune.messages.activeBlockIds.add(overrides.blockId)
        state.prune.messages.activeByAnchorMessageId.set(block.anchorMessageId, overrides.blockId)
    }

    rawMessages.push({
        info: {
            id: block.compressMessageId,
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created: rawMessages.length + 1 },
        } as WithParts["info"],
        parts: [
            textPart(block.compressMessageId, sessionID, `${block.compressMessageId}-part`, "compress tool output"),
        ],
    })

    return block
}

// ── /dcp view tests ──────────────────────────────────────────────────────────

test("/dcp view with no args lists available compressions with summaries", async () => {
    const sessionID = `ses_view_list_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
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

    addCompressionBlock(state, rawMessages, sessionID, { blockId: 1, runId: 1, topic: "Auth System", summary: "Summary of auth." })
    addCompressionBlock(state, rawMessages, sessionID, { blockId: 2, runId: 2, topic: "Database Layer", summary: "Summary of db." })

    await handleViewCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: [],
    })

    const output = ignoredMessages.join("\n")
    assert.match(output, /Auth System/)
    assert.match(output, /Database Layer/)
    assert.match(output, /Summary of auth/)
    assert.match(output, /Summary of db/)
    assert.match(output, /1 \(/, "should show block ID")
})

test("/dcp view with non-numeric arg shows error", async () => {
    const sessionID = `ses_view_bad_id_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
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

    addCompressionBlock(state, rawMessages, sessionID, { blockId: 1, runId: 1 })

    await handleViewCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["abc"],
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /compression number/i)
})

test("/dcp view with non-existent block ID shows error", async () => {
    const sessionID = `ses_view_missing_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
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

    await handleViewCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["99"],
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /does not exist/)
})

test("/dcp view with valid block ID shows full summary and metadata", async () => {
    const sessionID = `ses_view_detail_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
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

    addCompressionBlock(state, rawMessages, sessionID, {
        blockId: 1,
        runId: 1,
        topic: "Auth System Exploration",
        summary: "[Compressed conversation section]\nDetailed analysis of the auth module.\nMultiple findings documented.",
        compressedTokens: 1200,
        summaryTokens: 45,
        durationMs: 2500,
        mode: "range",
        parentBlockIds: [],
    })

    await handleViewCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["1"],
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /Auth System Exploration/, "should show topic")
    assert.match(output, /Detailed analysis of the auth module/, "should show summary text")
    assert.match(output, /Multiple findings documented/, "should show all summary content")
    assert.match(output, /1\.2K/, "should show compressed tokens")
    assert.match(output, /45/, "should show summary tokens")
    assert.match(output, /active/, "should show active status")
    assert.match(output, /range/, "should show mode")
})

test("/dcp view with message-mode grouped blocks shows grouping info", async () => {
    const sessionID = `ses_view_grouped_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
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

    addCompressionBlock(state, rawMessages, sessionID, {
        blockId: 3,
        runId: 2,
        mode: "message",
        topic: "First note",
        batchTopic: "Batch: stale notes",
        summary: "First compressed message.",
    })
    addCompressionBlock(state, rawMessages, sessionID, {
        blockId: 4,
        runId: 2,
        mode: "message",
        topic: "Second note",
        batchTopic: "Batch: stale notes",
        summary: "Second compressed message.",
    })

    await handleViewCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["3"],
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /Batch: stale notes/, "should show batch topic")
    assert.match(output, /2 blocks/, "should indicate multiple blocks in the group")
    assert.match(output, /First compressed message/, "should show first block summary")
    assert.match(output, /Second compressed message/, "should show second block summary")
})

// ── /dcp edit tests ──────────────────────────────────────────────────────────

test("/dcp edit with no args lists available compressions", async () => {
    const sessionID = `ses_edit_list_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
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

    addCompressionBlock(state, rawMessages, sessionID, { blockId: 1, runId: 1, topic: "Auth System", summary: "Summary of auth." })
    addCompressionBlock(state, rawMessages, sessionID, { blockId: 2, runId: 2, topic: "Database Layer", summary: "Summary of db." })

    await handleEditCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: [],
    })

    const output = ignoredMessages.join("\n")
    assert.match(output, /Auth System/)
    assert.match(output, /Database Layer/)
})

test("/dcp edit with non-numeric arg shows error", async () => {
    const sessionID = `ses_edit_bad_id_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
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

    addCompressionBlock(state, rawMessages, sessionID, { blockId: 1, runId: 1 })

    await handleEditCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["abc"],
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /compression number/i)
})

test("/dcp edit with non-existent block ID shows error", async () => {
    const sessionID = `ses_edit_missing_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
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

    await handleEditCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["99", "new", "text"],
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /does not exist/)
})

test("/dcp edit with block ID but no replacement text shows error", async () => {
    const sessionID = `ses_edit_no_text_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
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

    addCompressionBlock(state, rawMessages, sessionID, { blockId: 1, runId: 1 })

    await handleEditCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["1"],
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /provide.*text|replacement|edit/i)
})

test("/dcp edit replaces block summary and persists", async () => {
    const sessionID = `ses_edit_replace_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    state.sessionId = sessionID
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

    const block = addCompressionBlock(state, rawMessages, sessionID, {
        blockId: 1,
        runId: 1,
        topic: "Auth System",
        summary: "Original summary about auth system.",
    })

    await handleEditCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["1", "Updated", "summary", "about", "auth", "module."],
    })

    assert.equal(block.summary, "Updated summary about auth module.")
    const output = ignoredMessages.pop() || ""
    assert.match(output, /updated/i)
    assert.match(output, /1/)
})

test("/dcp edit with -a flag appends text to existing summary", async () => {
    const sessionID = `ses_edit_append_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    state.sessionId = sessionID
    const logger = new Logger(false)
    const ignoredMessages: string[] = []

    const client = {
        session: {
            messages: async () => ({ data: rawMessages }),
            get: async () => ({ data: rawMessages }),
            prompt: async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
                ignoredMessages.push(body.parts[0]?.text || "")
            },
        },
    }

    const block = addCompressionBlock(state, rawMessages, sessionID, {
        blockId: 1,
        runId: 1,
        topic: "Auth System",
        summary: "Original summary.",
    })

    await handleEditCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["1", "-a", "Appended", "detail."],
    })

    assert.equal(block.summary, "Original summary.\n\nAppended detail.")
    const output = ignoredMessages.pop() || ""
    assert.match(output, /appended/i)
})

test("/dcp edit on deactivated block still works", async () => {
    const sessionID = `ses_edit_inactive_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    state.sessionId = sessionID
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

    const block = addCompressionBlock(state, rawMessages, sessionID, {
        blockId: 1,
        runId: 1,
        topic: "Auth System",
        summary: "Original summary.",
        active: false,
        deactivatedByUser: true,
    })

    await handleEditCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["1", "Fixed", "summary."],
    })

    assert.equal(block.summary, "Fixed summary.")
    assert.equal(block.active, false, "should remain inactive after edit")
})

test("/dcp edit with -a flag and no text shows error", async () => {
    const sessionID = `ses_edit_append_no_text_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
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

    addCompressionBlock(state, rawMessages, sessionID, { blockId: 1, runId: 1 })

    await handleEditCommand({
        client,
        state,
        logger,
        sessionId: sessionID,
        messages: rawMessages,
        args: ["1", "-a"],
    })

    const output = ignoredMessages.pop() || ""
    assert.match(output, /provide.*text|replacement|edit/i)
})


