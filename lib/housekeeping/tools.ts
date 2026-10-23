import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "../compress/types"
import { finalizeSession } from "../compress/pipeline"
import type { WithParts } from "../state"
import { saveSessionStateStrict } from "../state/persistence"
import { finalizePendingBuffers } from "../expand-block"
import {
    captureEligibleSourceParts,
    findToolCallPart,
    projectEligibleSourceMessages,
    projectHousekeepingHistory,
} from "./history"
import { withSessionCoordinator } from "./coordinator"
import { loadAndReconcileSession } from "./state"
import { buildEntryGuidance, cloneDraft, publishDraft } from "./state"
import type { HousekeepingTransaction } from "../state"
import type { ToolExecutionContext } from "./types"

async function loadSessionMessages(ctx: ToolContext, sessionID: string): Promise<WithParts[]> {
    const response = await ctx.client.session.messages({ path: { id: sessionID } })
    return response.data as WithParts[]
}

async function prepareToolSession(ctx: ToolContext, sessionID: string): Promise<WithParts[]> {
    return loadAndReconcileSession(ctx, sessionID)
}

function callIdentity(context: ToolExecutionContext): string | undefined {
    return context.callID || undefined
}

function completedEntry(
    state: ToolContext["state"],
    messageId: string,
    callId: string | undefined,
): HousekeepingTransaction | undefined {
    return callId
        ? state.housekeepingHistory.find(
              (transaction) =>
                  transaction.entryCallId === callId && transaction.entryMessageId === messageId,
          )
        : undefined
}

export function createEnterHousekeepingTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description:
            "Enter housekeeping mode and return eligible ranges and maintenance guidance. Keep the mode active for the entire maintenance pass: memo updates, planned compression, and all summary edits across affected blocks. Call leave_housekeeping only after completing all intended changes.",
        args: {},
        async execute(_args, untypedToolContext) {
            const toolContext = untypedToolContext as ToolExecutionContext
            return withSessionCoordinator(ctx.state, async () => {
                const messages = await prepareToolSession(ctx, toolContext.sessionID)
                const callId = callIdentity(toolContext)
                const previous = completedEntry(ctx.state, toolContext.messageID, callId)
                if (
                    previous?.sessionId === toolContext.sessionID &&
                    previous.entryMessageId === toolContext.messageID
                )
                    return previous.entryGuidance ?? "Housekeeping entry already completed."
                const active = ctx.state.housekeeping
                if (active && active.entryCallId === callId) {
                    return (
                        active.entryGuidance ??
                        "Housekeeping is active. Complete all intended memo, compression, and summary work across every affected block before calling leave_housekeeping once for the whole maintenance pass."
                    )
                }
                if (active) {
                    throw new Error(
                        "Housekeeping is already active; recursive entry is not allowed.",
                    )
                }
                if (ctx.state.isSubAgent && !ctx.config.experimental.allowSubAgents) {
                    throw new Error("Housekeeping is unavailable in this subagent session.")
                }
                if (ctx.config.compress.permission === "deny") {
                    throw new Error("Compression permission is denied.")
                }

                const priorWork = projectHousekeepingHistory(
                    messages,
                    ctx.state.housekeepingHistory,
                )
                const sourceParts = captureEligibleSourceParts(
                    messages,
                    toolContext.messageID,
                    callId ?? "",
                    ctx.state.housekeepingHistory,
                )
                const eligibleBeforeEntry = projectEligibleSourceMessages(priorWork, {
                    sourceParts,
                })
                const candidateState = structuredClone(ctx.state)
                const guidance = buildEntryGuidance(
                    candidateState,
                    eligibleBeforeEntry,
                    ctx.prompts.getRuntimePrompts().housekeepingGuidance,
                    ctx.config,
                )
                const entryPart = findToolCallPart(messages, toolContext.messageID, callId ?? "")
                const entryMessage = messages.find(
                    (message) => message.info.id === toolContext.messageID,
                )
                const transaction: HousekeepingTransaction = {
                    id: `${toolContext.sessionID}:${toolContext.messageID}:${callId ?? ""}`,
                    sessionId: toolContext.sessionID,
                    entryMessageId: toolContext.messageID,
                    entryPartId: entryPart?.partId ?? null,
                    entryCallId: callId ?? "",
                    entryCreatedAt: entryMessage?.info.time.created ?? 0,
                    sourceParts,
                    baseRevision: candidateState.contentRevision,
                    base: cloneDraft(candidateState),
                    draft: cloneDraft(candidateState),
                    operations: {},
                    operationResults: {},
                    operationRecords: [],
                    entryGuidance: guidance,
                    operationOrder: [],
                    operationDrafts: {},
                }
                candidateState.housekeeping = transaction
                candidateState.housekeepingHistory = [
                    ...candidateState.housekeepingHistory,
                    structuredClone(transaction),
                ]
                await saveSessionStateStrict(candidateState, ctx.logger)
                ctx.state.messageIds = candidateState.messageIds
                ctx.state.housekeeping = transaction
                ctx.state.housekeepingHistory = candidateState.housekeepingHistory
                ctx.state.revision = candidateState.revision
                return guidance
            })
        },
    })
}

function buildCommitReceipt(
    base: HousekeepingTransaction["base"],
    candidate: HousekeepingTransaction["draft"],
): string {
    const changed = [...candidate.prune.messages.blocksById.values()]
        .filter((block) => {
            const before = base.prune.messages.blocksById.get(block.blockId)
            return !before || JSON.stringify(before) !== JSON.stringify(block)
        })
        .sort((left, right) => left.blockId - right.blockId)
    const affected = changed.length
        ? changed.map((block) => `b${block.blockId} v${block.activeVersionIndex}`).join(", ")
        : "no blocks"
    const memo =
        JSON.stringify(candidate.memo) === JSON.stringify(base.memo)
            ? "unchanged"
            : candidate.memo
              ? "updated"
              : "cleared"
    return `Housekeeping complete: committed ${affected}; memo ${memo}.`
}

export function createLeaveHousekeepingTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description:
            "Commit the accumulated housekeeping draft and exit the mode. Finish all intended memo updates, compression, expansions, rewrites, version changes, and summary edits first. Preserve essential findings from housekeeping, then call leave_housekeeping once to publish all changes together. Do not leave between individual edits or blocks. Reading back the draft is optional.",
        args: {},
        async execute(_args, untypedToolContext) {
            const toolContext = untypedToolContext as ToolExecutionContext
            return withSessionCoordinator(ctx.state, async () => {
                const rawMessages = await prepareToolSession(ctx, toolContext.sessionID)
                const callId = callIdentity(toolContext)
                const existingReceipt = callId
                    ? ctx.state.housekeepingHistory.find(
                          (transaction) =>
                              transaction.sessionId === toolContext.sessionID &&
                              transaction.completed?.leaveCallId === callId &&
                              transaction.completed.leaveMessageId === toolContext.messageID,
                      )?.completed?.receipt
                    : undefined
                if (existingReceipt) return existingReceipt
                const transaction = ctx.state.housekeeping
                if (!transaction) {
                    throw new Error(
                        "No active housekeeping transaction; call enter_housekeeping first.",
                    )
                }
                if (ctx.state.contentRevision !== transaction.baseRevision) {
                    throw new Error(
                        "Committed context changed during housekeeping. Re-enter housekeeping from the current session state before committing.",
                    )
                }
                const candidateDraft = structuredClone(transaction.draft)
                finalizePendingBuffers(candidateDraft)
                candidateDraft.nudges = {
                    contextLimitAnchors: new Set(),
                    turnNudgeAnchors: new Set(),
                    iterationNudgeAnchors: new Set(),
                }
                const receipt = buildCommitReceipt(transaction.base, candidateDraft)
                const candidateState = structuredClone(ctx.state)
                publishDraft(candidateState, candidateDraft)
                candidateState.contentRevision = transaction.baseRevision + 1
                const completed = {
                    leaveMessageId: toolContext.messageID,
                    leavePartId:
                        findToolCallPart(rawMessages, toolContext.messageID, callId ?? "")
                            ?.partId ?? null,
                    leaveCallId: callId ?? "",
                    receipt,
                    commitRevision: candidateState.revision + 1,
                    committedDraft: structuredClone(candidateDraft),
                }
                const completedTransaction: HousekeepingTransaction = {
                    ...structuredClone(transaction),
                    draft: candidateDraft,
                    completed,
                }
                candidateState.housekeeping = null
                candidateState.housekeepingHistory = candidateState.housekeepingHistory.map(
                    (entry) =>
                        entry.id === transaction.id ? structuredClone(completedTransaction) : entry,
                )
                await saveSessionStateStrict(candidateState, ctx.logger)
                publishDraft(ctx.state, candidateDraft)
                ctx.state.contentRevision = candidateState.contentRevision
                ctx.state.housekeeping = null
                ctx.state.housekeepingHistory = candidateState.housekeepingHistory
                ctx.state.revision = candidateState.revision

                if (transaction.notifications?.length) {
                    try {
                        const messages = await loadSessionMessages(ctx, toolContext.sessionID)
                        await finalizeSession(
                            ctx,
                            toolContext as unknown as Parameters<typeof finalizeSession>[1],
                            messages,
                            transaction.notifications,
                            transaction.batchTopic,
                        )
                    } catch (error) {
                        ctx.logger.warn("Housekeeping committed, but its notification failed", {
                            error: error instanceof Error ? error.message : String(error),
                        })
                    }
                }
                return receipt
            })
        },
    })
}
