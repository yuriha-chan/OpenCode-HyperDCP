import type { WithParts } from "../state"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import { assignMessageRefs } from "../message-ids"
import { isIgnoredUserMessage } from "../messages/query"
import { deduplicate, purgeErrors } from "../strategies"
import { getCurrentParams, getCurrentTokenUsage } from "../token-utils"
import {
    deliverCompressNotification,
    sendIgnoredMessage,
    type NotificationDelivery,
} from "../ui/notification"
import type { CompressionOperationContext, ToolContext } from "./types"
import { buildSearchContext, fetchSessionMessages } from "./search"
import type { SearchContext } from "./types"
import { applyPendingCompressionDurations } from "./timing"
import { projectEligibleSourceMessages } from "../housekeeping/history"
import { loadAndReconcileSession } from "../housekeeping/state"

interface RunContext {
    ask(input: {
        permission: string
        patterns: string[]
        always: string[]
        metadata: Record<string, unknown>
    }): Promise<void>
    metadata(input: { title: string }): void
    sessionID: string
}

export interface NotificationEntry {
    blockId: number
    runId: number
    summary: string
    summaryTokens: number
}

export interface PreparedSession {
    rawMessages: WithParts[]
    searchContext: SearchContext
}

export async function prepareSession(
    ctx: ToolContext,
    toolCtx: RunContext,
    title: string,
): Promise<PreparedSession> {
    assertCompressionManualMode(ctx.state)

    await toolCtx.ask({
        permission: "compress",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
    })

    toolCtx.metadata({ title })

    const rawMessages = await fetchSessionMessages(ctx.client, toolCtx.sessionID)

    await ensureSessionInitialized(
        ctx.client,
        ctx.state,
        toolCtx.sessionID,
        ctx.logger,
        rawMessages,
        ctx.config.manualMode.enabled,
    )

    return prepareCompressionMessages(ctx, rawMessages)
}

export function assertCompressionManualMode(state: ToolContext["state"]): void {
    if (state.manualMode && state.manualMode !== "compress-pending") {
        throw new Error(
            "Manual mode: compress blocked. Do not retry until `<compress triggered manually>` appears in user context.",
        )
    }
}

export function prepareCompressionMessages(
    ctx: Pick<ToolContext, "state" | "logger" | "config">,
    rawMessages: WithParts[],
): PreparedSession {
    const eligibleMessages = ctx.state.housekeeping
        ? projectEligibleSourceMessages(rawMessages, ctx.state.housekeeping)
        : rawMessages
    if (!ctx.state.housekeeping) assignMessageRefs(ctx.state, eligibleMessages)

    if (!ctx.state.housekeeping) {
        deduplicate(ctx.state, ctx.logger, ctx.config, eligibleMessages)
        purgeErrors(ctx.state, ctx.logger, ctx.config, eligibleMessages)
    }

    return {
        rawMessages: eligibleMessages,
        searchContext: buildSearchContext(ctx.state, eligibleMessages),
    }
}

export function compressionOperationContext(
    ctx: ToolContext,
    toolCtx: RunContext,
): CompressionOperationContext {
    return {
        ...ctx,
        refreshSession: (sessionID) => loadAndReconcileSession(ctx, sessionID),
        fetchMessages: (sessionID) => fetchSessionMessages(ctx.client, sessionID),
        reportCompressionStart: async (title) => {
            await toolCtx.ask({
                permission: "compress",
                patterns: ["*"],
                always: ["*"],
                metadata: {},
            })
            toolCtx.metadata({ title })
        },
    }
}

export async function finalizeCompression(
    ctx: Pick<ToolContext, "state" | "logger" | "config">,
    sessionID: string,
    rawMessages: WithParts[],
    entries: NotificationEntry[],
    batchTopic: string | undefined,
    delivery: NotificationDelivery,
): Promise<void> {
    if (ctx.state.housekeeping) return
    if (ctx.state.manualMode !== "compress-pending") {
        ctx.state.manualMode = ctx.state.manualMode ? "active" : false
    }
    applyPendingCompressionDurations(ctx.state)
    await saveSessionState(ctx.state, ctx.logger)

    const params = getCurrentParams(ctx.state, rawMessages, ctx.logger)
    const sessionMessageIds = rawMessages
        .filter((msg) => !isIgnoredUserMessage(msg))
        .map((msg) => msg.info.id)

    await deliverCompressNotification(
        delivery,
        ctx.logger,
        ctx.config,
        ctx.state,
        sessionID,
        entries,
        batchTopic,
        sessionMessageIds,
        params,
    )
}

export async function finalizeSession(
    ctx: ToolContext,
    toolCtx: RunContext,
    rawMessages: WithParts[],
    entries: NotificationEntry[],
    batchTopic: string | undefined,
): Promise<void> {
    await finalizeCompression(ctx, toolCtx.sessionID, rawMessages, entries, batchTopic, {
        sendMessage: (text, params) =>
            sendIgnoredMessage(ctx.client, toolCtx.sessionID, text, params, ctx.logger),
        showToast: async (toast) => {
            await ctx.client.tui.showToast({ body: toast })
        },
    })
}
