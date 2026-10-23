import "./storage-env"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TestContext } from "node:test"
import type { PluginConfig } from "../../lib/config"
import type { ToolContext } from "../../lib/compress/types"
import { createCompressMessageTool, createCompressRangeTool } from "../../lib/compress"
import {
    createAppendSummaryTool,
    createEditSummaryTool,
    createExpandBlockTool,
} from "../../lib/expand-block"
import { createFetchSummaryVersionsTool } from "../../lib/fetch-summary-versions"
import {
    createEnterHousekeepingTool,
    createLeaveHousekeepingTool,
} from "../../lib/housekeeping/tools"
import { createToolExecuteBeforeHandler } from "../../lib/housekeeping/guard"
import { createChatMessageTransformHandler, createCommandExecuteHandler } from "../../lib/hooks"
import { Logger } from "../../lib/logger"
import { PromptStore } from "../../lib/prompts/store"
import { createReadMemoTool } from "../../lib/read-memo"
import { createRecallCompressedTool } from "../../lib/recall"
import { createRewriteSummaryTool } from "../../lib/rewrite-summary"
import { createEditMemoTool } from "../../lib/set-memo"
import { createSessionState, type SessionState, type WithParts } from "../../lib/state"
import { createToggleSummaryVersionTool } from "../../lib/toggle-summary-version"

export interface HarnessOptions {
    mode?: "message" | "range"
    allowedTools?: string[]
    permission?: "allow" | "ask" | "deny"
    messages?: WithParts[]
    parentID?: string
    allowSubAgents?: boolean
    configure?: (config: PluginConfig) => void
    sharedState?: SessionState
    todo?: () => Promise<{ data?: unknown; error?: unknown }>
}

export function ordinaryMessage(
    sessionID: string,
    id: string,
    role: "user" | "assistant",
    text: string,
): WithParts {
    return {
        info: {
            id,
            sessionID,
            role,
            agent: "assistant",
            model: { providerID: "test", modelID: "test" },
            time: { created: 1 },
        } as WithParts["info"],
        parts: [{ id: `${id}-text`, messageID: id, sessionID, type: "text", text }],
    }
}

export function visibleText(messages: WithParts[]): string {
    return messages
        .flatMap((message) =>
            message.parts.map((part) => {
                if (part.type === "text" || part.type === "reasoning") return part.text
                if (part.type === "tool" && part.state.status === "completed")
                    return part.state.output
                return ""
            }),
        )
        .join("\n")
}

export async function createHousekeepingHarness(t: TestContext, options: HarnessOptions = {}) {
    const root = await mkdtemp(join(tmpdir(), "hyperdcp-housekeeping-"))
    const oldConfigHome = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = root
    t.after(async () => {
        if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = oldConfigHome
        await rm(root, { recursive: true, force: true })
    })
    const sessionID = options.messages?.[0]?.info.sessionID ?? `ses_${randomUUID()}`
    const config: PluginConfig & { housekeeping: { allowedTools: string[] } } = {
        enabled: true,
        autoUpdate: false,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: options.allowSubAgents ?? false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: options.mode ?? "range",
            permission: options.permission ?? "allow",
            showCompression: false,
            summaryBuffer: false,
            maxContextLimit: 150000,
            minContextLimit: 150000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            maxToolOutputChars: 100000,
            minCompressTokens: 0,
        },
        strategies: {
            deduplication: { enabled: false, protectedTools: [] },
            purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
        },
        housekeeping: { allowedTools: options.allowedTools ?? [] },
    }
    options.configure?.(config)
    let history = options.messages ?? [
        ordinaryMessage(sessionID, "source-1", "user", "Investigate the parser boundary."),
        ordinaryMessage(sessionID, "source-2", "assistant", "The parser accepts an empty record."),
        ordinaryMessage(sessionID, "source-3", "user", "Keep the newline constraint."),
        ordinaryMessage(sessionID, "source-4", "assistant", "Use the documented parser API."),
    ]
    const messages = t.mock.fn(async (_input: { path: { id: string } }) => ({
        data: structuredClone(history),
    }))
    const get = t.mock.fn(async (_input: { path: { id: string } }) => ({
        data: { id: sessionID, parentID: options.parentID },
    }))
    const todo = t.mock.fn(options.todo ?? (async () => ({ data: undefined })))
    const prompt = t.mock.fn(async (_input: { path: { id: string }; body: unknown }) => ({
        data: {},
    }))
    const ask = t.mock.fn(async (_input: { permission: string }) => {})
    const client = { session: { messages, get, prompt, todo } }
    const logger = new Logger(false)
    const prompts = new PromptStore(logger, root, false)
    const ctx: ToolContext = {
        client,
        state: options.sharedState ?? createSessionState(),
        logger,
        config,
        prompts,
    }
    const hostPermissions = { global: undefined, agents: {} }
    let counter = 0

    const factories = {
        enter_housekeeping: createEnterHousekeepingTool,
        leave_housekeeping: createLeaveHousekeepingTool,
        compress:
            config.compress.mode === "range" ? createCompressRangeTool : createCompressMessageTool,
        rewrite_summary: createRewriteSummaryTool,
        toggle_summary_version: createToggleSummaryVersionTool,
        expand_block: createExpandBlockTool,
        edit_summary: createEditSummaryTool,
        append_summary: createAppendSummaryTool,
        fetch_summary_versions: createFetchSummaryVersionsTool,
        edit_memo: createEditMemoTool,
        read_memo: createReadMemoTool,
        recall_compressed: createRecallCompressedTool,
    }

    async function render(): Promise<WithParts[]> {
        const output = { messages: structuredClone(history) }
        await createChatMessageTransformHandler(
            client,
            ctx.state,
            logger,
            config,
            prompts,
            hostPermissions,
        )({}, output)
        return output.messages
    }

    async function run(
        name: keyof typeof factories,
        args: Record<string, unknown> = {},
        identity: { callID?: string; messageID?: string } = {},
    ): Promise<string> {
        const callID = identity.callID ?? `call-${++counter}`
        const messageID = identity.messageID ?? `tool-message-${callID}`
        let message = history.find((entry) => entry.info.id === messageID)
        if (!message) {
            message = ordinaryMessage(sessionID, messageID, "assistant", "")
            message.parts = []
            history.push(message)
        }
        let part = message.parts.find(
            (entry) => entry.type === "tool" && entry.callID === callID,
        ) as any
        if (!part) {
            part = {
                id: `part-${callID}`,
                messageID,
                sessionID,
                type: "tool",
                tool: name,
                callID,
                state: { status: "running", input: args, time: { start: 1 } },
            }
            message.parts.push(part)
        }
        const executionContext = {
            sessionID,
            messageID,
            callID,
            agent: "assistant",
            directory: root,
            worktree: root,
            abort: new AbortController().signal,
            ask,
            metadata(_value: unknown) {},
        }
        try {
            const result = await factories[name](ctx).execute(args as any, executionContext as any)
            part.state = {
                status: "completed",
                input: args,
                output: result,
                title: name,
                metadata: {},
                time: { start: 1, end: 2 },
            }
            return result
        } catch (error) {
            part.state = {
                status: "error",
                input: args,
                error: String(error),
                time: { start: 1, end: 2 },
            }
            throw error
        }
    }

    async function command(arguments_: string) {
        const output = { parts: [] as any[] }
        await createCommandExecuteHandler(
            client,
            ctx.state,
            logger,
            config,
            root,
            hostPermissions,
        )({ command: "dcp", sessionID, arguments: arguments_ }, output)
        return output
    }

    function assertSessionReads() {
        assert.ok(messages.mock.callCount() > 0, "expected a host session.messages read")
        for (const call of messages.mock.calls)
            assert.deepEqual(call.arguments[0], { path: { id: sessionID } })
    }

    t.after(() => {
        assert.ok(get.mock.callCount() > 0, "fixture must initialize through the host session API")
        for (const call of get.mock.calls)
            assert.deepEqual(call.arguments[0], { path: { id: sessionID } })
        for (const call of messages.mock.calls)
            assert.deepEqual(call.arguments[0], { path: { id: sessionID } })
        for (const call of prompt.mock.calls) assert.equal(call.arguments[0].path.id, sessionID)
        for (const call of ask.mock.calls) assert.equal(call.arguments[0].permission, "compress")
    })

    await render()
    return {
        ctx,
        config,
        root,
        sessionID,
        client,
        todo,
        ask,
        run,
        render,
        command,
        assertSessionReads,
        enter: () => run("enter_housekeeping"),
        leave: () => run("leave_housekeeping"),
        readMemo: () => run("read_memo"),
        versions: (blockId = 1, version?: number) =>
            run("fetch_summary_versions", {
                blockId,
                ...(version === undefined ? {} : { version }),
            }),
        get history() {
            return history
        },
        setHistory(value: WithParts[]) {
            history = structuredClone(value)
        },
        addText(id: string, text: string, role: "user" | "assistant" = "assistant") {
            history.push(ordinaryMessage(sessionID, id, role, text))
        },
        async restart() {
            ctx.state = createSessionState()
            return render()
        },
        guard: (tool: string, args: unknown = {}) =>
            createToolExecuteBeforeHandler(ctx)(
                { tool, sessionID, callID: `guard-${++counter}` },
                { args },
            ),
    }
}

export type HousekeepingHarness = Awaited<ReturnType<typeof createHousekeepingHarness>>

export async function stageBlock(
    h: HousekeepingHarness,
    summary = "Parser findings.",
    startId = "m0001",
    endId = "m0002",
) {
    if (h.config.compress.mode === "range") {
        return h.run("compress", { topic: "Parser", content: [{ startId, endId, summary }] })
    }
    return h.run("compress", {
        topic: "Parser",
        content: [{ messageId: startId, topic: "Parser", summary }],
    })
}

export async function commitBlock(h: HousekeepingHarness, summary = "Parser findings.") {
    await h.enter()
    await stageBlock(h, summary)
    await h.leave()
}
