import type { SessionState, HousekeepingDraft, HousekeepingTransaction, WithParts } from "../state"
import { assignMessageRefs } from "../message-ids"
import { findUncoveredRanges, formatUncoveredRanges } from "../messages/uncovered"
import type { ToolContext } from "../compress/types"
import type { Logger } from "../logger"
import { saveSessionStateStrict } from "../state/persistence"
import { operationIdentity, type ToolExecutionContext } from "./types"
import { HOUSEKEEPING_DRAFT_VIEW, withSessionCoordinator } from "./coordinator"
import { ensureSessionInitialized } from "../state"
import { findLastCompactionTimestamp, resetOnCompaction } from "../state/utils"
import { reconcileHousekeepingHistory } from "./history"
import { findToolCallPart } from "./history"
import { buildPriorityMap } from "../messages/priority"
import {
    buildCompressedBlockGuidance,
    renderMessagePriorityGuidance,
} from "../prompts/extensions/nudge"

const DRAFT_FIELDS = new Set(["prune", "stats", "memo", "nudges"])

export function cloneDraft(state: SessionState): HousekeepingDraft {
    return structuredClone({
        prune: state.prune,
        stats: state.stats,
        memo: state.memo,
        nudges: state.nudges,
    })
}

export function draftState(state: SessionState): SessionState {
    const transaction = state.housekeeping
    if (!transaction)
        throw new Error("Call enter_housekeeping before making context-maintenance edits.")
    return makeDraftView(state, transaction, transaction.draft)
}

function makeDraftView(
    root: SessionState,
    transaction: HousekeepingTransaction,
    draft: HousekeepingDraft,
): SessionState {
    return new Proxy(root, {
        get(target, property, receiver) {
            if (property === HOUSEKEEPING_DRAFT_VIEW) return { root, transaction, draft }
            if (property === "housekeeping") return transaction
            if (typeof property === "string" && DRAFT_FIELDS.has(property)) {
                return draft[property as keyof HousekeepingDraft]
            }
            return Reflect.get(target, property, receiver)
        },
        set(_target, property, value) {
            if (typeof property !== "string" || !DRAFT_FIELDS.has(property)) {
                throw new Error(
                    `Housekeeping operation cannot mutate runtime session field ${String(property)}.`,
                )
            }
            Reflect.set(draft, property, value)
            return true
        },
    })
}

export function publishDraft(state: SessionState, draft: HousekeepingDraft): void {
    state.prune = structuredClone(draft.prune)
    state.stats = structuredClone(draft.stats)
    state.memo = draft.memo
    state.nudges = structuredClone(draft.nudges)
}

export async function runHousekeepingMutation<T>(
    ctx: ToolContext,
    toolContext: ToolExecutionContext,
    toolName: string,
    input: unknown,
    operation: (operationContext: ToolContext) => Promise<T>,
): Promise<T> {
    return withSessionCoordinator(ctx.state, async () => {
        const messages = await loadAndReconcileSession(ctx, toolContext.sessionID)
        const callId = toolContext.callID
        const operationId = callId ? operationIdentity(toolContext.messageID, callId) : undefined
        const completedRetry = operationId
            ? ctx.state.housekeepingHistory.find(
                  (entry) =>
                      entry.sessionId === toolContext.sessionID &&
                      entry.operationResults[operationId] !== undefined,
              )?.operationResults[operationId]
            : undefined
        if (completedRetry) return completedRetry.result as T
        const transaction = ctx.state.housekeeping
        if (!transaction)
            throw new Error("Call enter_housekeeping before making context-maintenance edits.")
        const prior = operationId ? transaction.operationResults[operationId] : undefined
        if (prior) return prior.result as T
        const candidateDraft = structuredClone(transaction.draft)
        const candidateTransaction = structuredClone(transaction)
        candidateTransaction.draft = candidateDraft
        const operationContext = {
            ...ctx,
            state: makeDraftView(ctx.state, candidateTransaction, candidateDraft),
        }
        const result = await operation(operationContext)
        if (callId) {
            const record = {
                callId,
                messageId: toolContext.messageID,
                partId: findToolCallPart(messages, toolContext.messageID, callId)?.partId ?? null,
                tool: toolName,
                input: structuredClone(input),
                result: typeof result === "string" ? result : "",
            }
            candidateTransaction.operationRecords = [
                ...candidateTransaction.operationRecords,
                record,
            ]
            candidateTransaction.operationResults[operationId!] = { result: record.result }
            candidateTransaction.operations[operationId!] = record.result
            candidateTransaction.operationOrder.push(operationId!)
            candidateTransaction.operationDrafts[operationId!] = structuredClone(candidateDraft)
        }
        const historyIndex = ctx.state.housekeepingHistory.findIndex(
            (entry) => entry.id === transaction.id,
        )
        const candidateRoot = structuredClone(ctx.state)
        candidateRoot.housekeeping = candidateTransaction
        if (historyIndex >= 0) {
            const historyEntry = structuredClone(candidateRoot.housekeepingHistory[historyIndex]!)
            historyEntry.draft = structuredClone(candidateDraft)
            historyEntry.operationRecords = structuredClone(candidateTransaction.operationRecords)
            historyEntry.operationResults = structuredClone(candidateTransaction.operationResults)
            historyEntry.operations = structuredClone(candidateTransaction.operations)
            historyEntry.operationOrder = [...candidateTransaction.operationOrder]
            historyEntry.operationDrafts = structuredClone(candidateTransaction.operationDrafts)
            candidateRoot.housekeepingHistory[historyIndex] = historyEntry
        }
        await saveSessionStateStrict(candidateRoot, ctx.logger)
        ctx.state.housekeeping = candidateTransaction
        ctx.state.housekeepingHistory = candidateRoot.housekeepingHistory
        ctx.state.revision = candidateRoot.revision
        return result
    })
}

export async function loadAndReconcileSession(
    ctx: ToolContext,
    sessionID: string,
): Promise<WithParts[]> {
    const response = await ctx.client.session.messages({ path: { id: sessionID } })
    const messages = response.data as WithParts[]
    await ensureSessionInitialized(
        ctx.client,
        ctx.state,
        sessionID,
        ctx.logger,
        messages,
        ctx.config.manualMode.enabled,
    )
    const compaction = findLastCompactionTimestamp(messages)
    if (compaction > ctx.state.lastCompaction) {
        ctx.state.lastCompaction = compaction
        resetOnCompaction(ctx.state)
        await saveSessionStateStrict(ctx.state, ctx.logger)
    }
    const reconciledState = structuredClone(ctx.state)
    if (reconcileHousekeepingHistory(reconciledState, messages)) {
        await saveSessionStateStrict(reconciledState, ctx.logger)
        Object.assign(ctx.state, reconciledState)
    }
    return messages
}

export async function runHousekeepingCommandMutation<T>(
    state: SessionState,
    logger: Logger,
    label: string,
    input: unknown,
    messageId: string,
    operation: (draft: SessionState) => Promise<T>,
): Promise<T> {
    return withSessionCoordinator(state, async () => {
        const transaction = state.housekeeping
        if (!transaction) return operation(state)
        const draft = structuredClone(transaction.draft)
        const candidateTransaction = structuredClone(transaction)
        candidateTransaction.draft = draft
        const view = makeDraftView(state, candidateTransaction, draft)
        const result = await operation(view)
        const callId = `command:${state.revision + 1}:${label}`
        const operationId = operationIdentity(messageId, callId)
        const record = {
            callId,
            messageId,
            partId: null,
            tool: `command:${label}`,
            input: structuredClone(input),
            result: typeof result === "string" ? result : "",
        }
        candidateTransaction.operationRecords.push(record)
        candidateTransaction.operationOrder.push(operationId)
        candidateTransaction.operationDrafts[operationId] = structuredClone(draft)
        candidateTransaction.operationResults[operationId] = { result: record.result }
        candidateTransaction.operations[operationId] = record.result
        const candidateRoot = structuredClone(state)
        candidateRoot.housekeeping = candidateTransaction
        const index = candidateRoot.housekeepingHistory.findIndex(
            (entry) => entry.id === transaction.id,
        )
        if (index >= 0) {
            const historyEntry = structuredClone(candidateRoot.housekeepingHistory[index]!)
            historyEntry.draft = structuredClone(draft)
            historyEntry.operationRecords = structuredClone(candidateTransaction.operationRecords)
            historyEntry.operationResults = structuredClone(candidateTransaction.operationResults)
            historyEntry.operations = structuredClone(candidateTransaction.operations)
            historyEntry.operationOrder = [...candidateTransaction.operationOrder]
            historyEntry.operationDrafts = structuredClone(candidateTransaction.operationDrafts)
            candidateRoot.housekeepingHistory[index] = historyEntry
        }
        await saveSessionStateStrict(candidateRoot, logger)
        state.housekeeping = candidateTransaction
        state.housekeepingHistory = candidateRoot.housekeepingHistory
        state.revision = candidateRoot.revision
        return result
    })
}

export function buildEntryGuidance(
    state: SessionState,
    messages: WithParts[],
    registeredGuidance = "",
    config?: ToolContext["config"],
): string {
    assignMessageRefs(state, messages)
    const ranges = findUncoveredRanges(state, messages)
    const rangeText = formatUncoveredRanges(ranges, state.prune.messages.blocksById)
    const sourceMessageIds = messages.map((message) => message.info.id)
    const priorityGuidance =
        config?.compress.mode === "message"
            ? renderMessagePriorityGuidance(
                  "High",
                  [...buildPriorityMap(config, state, messages).values()]
                      .filter(
                          (entry) =>
                              entry.priority === "high" && !state.protectedRefs.has(entry.ref),
                      )
                      .map((entry) => entry.ref),
              )
            : ""
    const visibleRefs = ranges.length
        ? messages
              .map((message) => state.messageIds.byRawId.get(message.info.id))
              .filter((ref): ref is string => ref !== undefined)
        : []
    return [
        "HOUSEKEEPING ENTRY",
        registeredGuidance.trim(),
        buildCompressedBlockGuidance(state),
        priorityGuidance,
        rangeText ||
            "No eligible uncovered ranges are available. Memo and summary maintenance can still be performed.",
        ...(visibleRefs.length
            ? [`Eligible message references: ${[...new Set(visibleRefs)].join(", ")}.`]
            : []),
        `Eligible messages: ${sourceMessageIds.length}; estimated tokens: ${ranges.reduce((sum, range) => sum + range.tokenEstimate, 0)}.`,
        "Use compress, edit_memo, edit_summary, append_summary, rewrite_summary, toggle_summary_version, and expand_block to stage changes. Inspect draft state with read_memo and fetch_summary_versions. Complete all intended memo, compression, and summary work across every affected block before calling leave_housekeeping once to publish the accumulated draft.",
    ]
        .filter(Boolean)
        .join("\n\n")
}
