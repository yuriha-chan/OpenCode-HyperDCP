import type {
    HousekeepingSourcePart,
    HousekeepingTransaction,
    SessionState,
    WithParts,
} from "../state"
import { operationIdentity } from "./types"

const HOUSEKEEPING_TOOL_NAMES = new Set([
    "enter_housekeeping",
    "leave_housekeeping",
    "compress",
    "edit_memo",
    "rewrite_summary",
    "toggle_summary_version",
    "expand_block",
    "edit_summary",
    "append_summary",
    "read_memo",
    "fetch_summary_versions",
    "recall_compressed",
])

export function captureEligibleSourceParts(
    messages: WithParts[],
    entryMessageId: string,
    entryCallId: string,
    transactions: HousekeepingTransaction[],
): HousekeepingSourcePart[] {
    const projected = projectHousekeepingHistory(messages, transactions)
    const source: HousekeepingSourcePart[] = []
    for (const message of projected) {
        for (const part of message.parts) {
            if (
                message.info.id === entryMessageId &&
                part.type === "tool" &&
                part.callID === entryCallId
            ) {
                return source
            }
            if (part.type === "tool" && HOUSEKEEPING_TOOL_NAMES.has(part.tool)) continue
            if (part.id) source.push({ messageId: message.info.id, partId: part.id })
        }
    }
    return source
}

export function projectEligibleSourceMessages(
    messages: WithParts[],
    transaction: Pick<HousekeepingTransaction, "sourceParts">,
): WithParts[] {
    const allowed = new Set(
        transaction.sourceParts.map((part) => `${part.messageId}\0${part.partId}`),
    )
    return messages.flatMap((message) => {
        const parts: WithParts["parts"] = []
        for (const part of message.parts) {
            if (!allowed.has(`${message.info.id}\0${part.id}`)) continue
            if (part.type === "text" || part.type === "reasoning") {
                const text = part.text
                    .replace(/\n?<dcp-message-id\b[^>]*>[\s\S]*?<\/dcp-message-id>/g, "")
                    .trimEnd()
                if (text) parts.push({ ...part, text })
            } else {
                parts.push(part)
            }
        }
        return parts.length ? [{ ...message, parts }] : []
    })
}

export function findToolCallPart(
    messages: WithParts[],
    messageId: string,
    callId: string,
): { messageId: string; partId: string; callId: string } | null {
    const message = messages.find((item) => item.info.id === messageId)
    const part = message?.parts.find((item) => item.type === "tool" && item.callID === callId)
    return part?.type === "tool" ? { messageId, partId: part.id, callId } : null
}

function partMatches(
    message: WithParts,
    partIndex: number,
    messageId: string,
    callId: string,
    partId: string | null = null,
): boolean {
    const part = message.parts[partIndex]
    return (
        message.info.id === messageId &&
        part?.type === "tool" &&
        part.callID === callId &&
        (partId === null || part.id === partId)
    )
}

export function projectHousekeepingHistory(
    messages: WithParts[],
    transactions: HousekeepingTransaction[],
): WithParts[] {
    const positions = new Map<string, number>()
    let position = 0
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
        for (let partIndex = 0; partIndex < messages[messageIndex].parts.length; partIndex++) {
            positions.set(`${messageIndex}:${partIndex}`, position++)
        }
    }
    const hidden = new Set<number>()
    const boundaryEdits = new Map<number, { output: string; title: string }>()
    for (const transaction of transactions) {
        let entryPosition: number | undefined
        let leavePosition: number | undefined
        let sourceBoundaryPosition: number | undefined
        const operationPositions: number[] = []
        messages.forEach((message, messageIndex) =>
            message.parts.forEach((_part, partIndex) => {
                const current = positions.get(`${messageIndex}:${partIndex}`)
                if (
                    transaction.sourceParts.some(
                        (source) =>
                            source.messageId === message.info.id && source.partId === _part.id,
                    )
                ) {
                    sourceBoundaryPosition = current
                }
                if (
                    partMatches(
                        message,
                        partIndex,
                        transaction.entryMessageId,
                        transaction.entryCallId,
                        transaction.entryPartId,
                    )
                ) {
                    entryPosition = current
                    if (transaction.completed) {
                        boundaryEdits.set(current!, {
                            output: "Housekeeping completed; its working history is hidden.",
                            title: "Housekeeping entry",
                        })
                    }
                }
                if (
                    transaction.completed &&
                    partMatches(
                        message,
                        partIndex,
                        transaction.completed!.leaveMessageId,
                        transaction.completed!.leaveCallId,
                        transaction.completed!.leavePartId,
                    )
                ) {
                    leavePosition = current
                    boundaryEdits.set(current!, {
                        output: transaction.completed!.receipt,
                        title: "Housekeeping receipt",
                    })
                }
                for (const operation of transaction.operationRecords) {
                    if (
                        operation.messageId === message.info.id &&
                        operation.partId === _part.id &&
                        _part.type === "tool" &&
                        _part.callID === operation.callId
                    ) {
                        operationPositions.push(current!)
                    }
                }
            }),
        )
        if (entryPosition !== undefined && leavePosition !== undefined) {
            for (let current = entryPosition + 1; current < leavePosition; current++)
                hidden.add(current)
        } else if (entryPosition === undefined && sourceBoundaryPosition !== undefined) {
            const end = leavePosition ?? Math.max(sourceBoundaryPosition, ...operationPositions)
            if (end > sourceBoundaryPosition) {
                for (let current = sourceBoundaryPosition + 1; current < end; current++)
                    hidden.add(current)
            }
        }
    }
    position = 0
    const result: WithParts[] = []
    for (const message of messages) {
        const parts = message.parts.flatMap((part) => {
            const current = position++
            if (hidden.has(current)) return []
            const edit = boundaryEdits.get(current)
            if (edit && part.type === "tool" && part.state.status === "completed") {
                return [
                    { ...part, state: { ...part.state, output: edit.output, title: edit.title } },
                ]
            }
            return [part]
        })
        if (parts.length) result.push({ ...message, parts })
    }
    return result
}

export function eligibleConversationMessages(
    messages: WithParts[],
    transactions: HousekeepingTransaction[],
): WithParts[] {
    const projected = projectHousekeepingHistory(messages, transactions)
    const callIds = new Set(
        transactions.flatMap((transaction) => [
            transaction.entryCallId,
            ...(transaction.completed ? [transaction.completed.leaveCallId] : []),
        ]),
    )
    return projected.flatMap((message) => {
        const parts = message.parts.filter(
            (part) =>
                part.type !== "tool" ||
                (!callIds.has(part.callID) && !isHousekeepingToolName(part.tool)),
        )
        return parts.length ? [{ ...message, parts }] : []
    })
}

function isHousekeepingToolName(name: string): boolean {
    return (
        HOUSEKEEPING_TOOL_NAMES.has(name) ||
        (name.startsWith("functions.") &&
            HOUSEKEEPING_TOOL_NAMES.has(name.slice("functions.".length)))
    )
}

export function reconcileHousekeepingHistory(state: SessionState, messages: WithParts[]): boolean {
    let changed = false
    const hasCall = (messageId: string, callId: string, partId: string | null): boolean =>
        messages.some(
            (message) =>
                message.info.id === messageId &&
                message.parts.some(
                    (part) =>
                        part.type === "tool" &&
                        part.callID === callId &&
                        (partId === null || part.id === partId),
                ),
        )
    const callSurvives = (record: HousekeepingTransaction["operationRecords"][number]): boolean =>
        record.tool.startsWith("command:")
            ? messages.some((message) => message.info.id === record.messageId)
            : hasCall(record.messageId, record.callId, record.partId)
    const transactions = [...state.housekeepingHistory]
    const undoTransactions = transactions
        .filter((transaction) => {
            if (!transaction.completed) return false
            const entrySurvives = hasCall(
                transaction.entryMessageId,
                transaction.entryCallId,
                transaction.entryPartId,
            )
            const leaveSurvives = hasCall(
                transaction.completed.leaveMessageId,
                transaction.completed.leaveCallId,
                transaction.completed.leavePartId,
            )
            return (
                (!entrySurvives || !leaveSurvives) && !(state.lastCompaction > 0 && !entrySurvives)
            )
        })
        .reverse()
    const undoIds = new Set(undoTransactions.map((transaction) => transaction.id))
    for (const transaction of [
        ...undoTransactions,
        ...transactions.filter((item) => !undoIds.has(item.id)),
    ]) {
        const entrySurvives = hasCall(
            transaction.entryMessageId,
            transaction.entryCallId,
            transaction.entryPartId,
        )
        const leaveSurvives = transaction.completed
            ? hasCall(
                  transaction.completed.leaveMessageId,
                  transaction.completed.leaveCallId,
                  transaction.completed.leavePartId,
              )
            : false
        const active = state.housekeeping?.id === transaction.id ? state.housekeeping : undefined
        const survivingOperations = transaction.operationRecords.filter(callSurvives)
        const survivingOrder = survivingOperations.map((operation) =>
            operationIdentity(operation.messageId, operation.callId),
        )
        const compactedPastEntry = state.lastCompaction > 0 && !entrySurvives

        if (!entrySurvives && compactedPastEntry) continue

        if (active && entrySurvives && !leaveSurvives) {
            if (!sameOrder(active.operationOrder, survivingOrder)) {
                const operationDrafts = Object.fromEntries(
                    survivingOperations.flatMap((operation) => {
                        const key = operationIdentity(operation.messageId, operation.callId)
                        const checkpoint =
                            active.operationDrafts[key] ?? transaction.operationDrafts[key]
                        return checkpoint ? [[key, checkpoint] as const] : []
                    }),
                )
                active.operationOrder = survivingOrder
                active.operationRecords = survivingOperations
                active.operationDrafts = operationDrafts
                active.operationResults = Object.fromEntries(
                    survivingOperations.flatMap((operation) => {
                        const key = operationIdentity(operation.messageId, operation.callId)
                        const result =
                            active.operationResults[key] ?? transaction.operationResults[key]
                        return result ? [[key, result] as const] : []
                    }),
                )
                active.operations = Object.fromEntries(
                    survivingOperations.map((operation) => [
                        operationIdentity(operation.messageId, operation.callId),
                        operation.result,
                    ]),
                )
                active.draft = survivingOrder.length
                    ? structuredClone(operationDrafts[survivingOrder.at(-1)!] ?? active.base)
                    : structuredClone(active.base)
                transaction.operationOrder = [...active.operationOrder]
                transaction.operationRecords = [...active.operationRecords]
                transaction.operationDrafts = structuredClone(active.operationDrafts)
                transaction.operationResults = structuredClone(active.operationResults)
                transaction.operations = structuredClone(active.operations)
                transaction.draft = structuredClone(active.draft)
                changed = true
            }
            continue
        }

        if (transaction.completed && (!entrySurvives || !leaveSurvives) && !compactedPastEntry) {
            if (!transaction.reverted) {
                applyDraftDelta(state, transaction.draft, transaction.base)
                state.contentRevision = transaction.baseRevision
                transaction.reverted = true
                changed = true
            }
            if (entrySurvives) {
                const reopened: HousekeepingTransaction = {
                    ...structuredClone(transaction),
                    completed: undefined,
                    operationOrder: [...survivingOrder],
                    operationRecords: survivingOperations,
                    operationResults: Object.fromEntries(
                        survivingOperations.map((operation) => {
                            const key = operationIdentity(operation.messageId, operation.callId)
                            return [key, { result: operation.result }]
                        }),
                    ),
                    operations: Object.fromEntries(
                        survivingOperations.map((operation) => [
                            operationIdentity(operation.messageId, operation.callId),
                            operation.result,
                        ]),
                    ),
                    draft: survivingOrder.length
                        ? structuredClone(
                              transaction.operationDrafts[survivingOrder.at(-1)!] ??
                                  transaction.base,
                          )
                        : structuredClone(transaction.base),
                }
                state.housekeeping = reopened
                changed = true
            } else if (state.housekeeping?.id === transaction.id) {
                state.housekeeping = null
                changed = true
            }
            continue
        }

        if (transaction.completed && entrySurvives && leaveSurvives && transaction.reverted) {
            applyDraftDelta(state, transaction.base, transaction.completed.committedDraft)
            state.contentRevision = transaction.baseRevision + 1
            transaction.reverted = false
            if (state.housekeeping?.id === transaction.id) state.housekeeping = null
            changed = true
        }
        if (!entrySurvives && active) {
            state.housekeeping = null
            transaction.reverted = true
            changed = true
        }
    }
    return changed
}

function sameOrder(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index])
}

export function applyDraftDelta(
    target: SessionState,
    from: HousekeepingTransaction["draft"],
    to: HousekeepingTransaction["draft"],
): void {
    const messageState = target.prune.messages
    const touchedMessages = new Set<string>()
    const blockIds = new Set([
        ...from.prune.messages.blocksById.keys(),
        ...to.prune.messages.blocksById.keys(),
    ])
    for (const blockId of blockIds) {
        const before = from.prune.messages.blocksById.get(blockId)
        const after = to.prune.messages.blocksById.get(blockId)
        if (JSON.stringify(before) === JSON.stringify(after)) continue
        const current = messageState.blocksById.get(blockId)
        for (const messageId of before?.effectiveMessageIds ?? []) touchedMessages.add(messageId)
        for (const messageId of after?.effectiveMessageIds ?? []) touchedMessages.add(messageId)
        if (!after) {
            if (JSON.stringify(current) === JSON.stringify(before))
                messageState.blocksById.delete(blockId)
            continue
        }
        if (!before) {
            if (!current) messageState.blocksById.set(blockId, structuredClone(after))
            continue
        }
        if (!current) continue
        const merged = structuredClone(current)
        const keys = new Set([...Object.keys(before), ...Object.keys(after)])
        for (const key of keys) {
            const previousValue = (before as unknown as Record<string, unknown>)[key]
            const nextValue = (after as unknown as Record<string, unknown>)[key]
            if (JSON.stringify(previousValue) === JSON.stringify(nextValue)) continue
            const currentValue = (current as unknown as Record<string, unknown>)[key]
            if (JSON.stringify(currentValue) !== JSON.stringify(previousValue)) continue
            if (key in after)
                (merged as unknown as Record<string, unknown>)[key] = structuredClone(nextValue)
            else delete (merged as unknown as Record<string, unknown>)[key]
        }
        messageState.blocksById.set(blockId, merged)
    }
    for (const [toolId, count] of from.prune.tools) {
        if (to.prune.tools.get(toolId) === count) continue
        if (target.prune.tools.get(toolId) === count) {
            if (to.prune.tools.has(toolId))
                target.prune.tools.set(toolId, to.prune.tools.get(toolId)!)
            else target.prune.tools.delete(toolId)
        }
    }
    for (const [toolId, count] of to.prune.tools) {
        if (!from.prune.tools.has(toolId) && !target.prune.tools.has(toolId))
            target.prune.tools.set(toolId, count)
    }
    for (const messageId of touchedMessages) {
        const prior =
            messageState.byMessageId.get(messageId) ??
            from.prune.messages.byMessageId.get(messageId) ??
            to.prune.messages.byMessageId.get(messageId)
        if (!prior) continue
        const allBlockIds = [...messageState.blocksById.values()]
            .filter((block) => block.effectiveMessageIds.includes(messageId))
            .map((block) => block.blockId)
            .sort((a, b) => a - b)
        if (!allBlockIds.length) {
            messageState.byMessageId.delete(messageId)
            continue
        }
        messageState.byMessageId.set(messageId, {
            tokenCount: prior.tokenCount,
            allBlockIds,
            activeBlockIds: allBlockIds.filter((id) => messageState.blocksById.get(id)?.active),
        })
    }
    messageState.activeBlockIds = new Set(
        [...messageState.blocksById.values()]
            .filter((block) => block.active)
            .map((block) => block.blockId),
    )
    messageState.activeByAnchorMessageId = new Map(
        [...messageState.blocksById.values()]
            .filter((block) => block.active)
            .map((block) => [block.anchorMessageId, block.blockId]),
    )
    messageState.nextBlockId = Math.max(
        messageState.nextBlockId,
        from.prune.messages.nextBlockId,
        to.prune.messages.nextBlockId,
    )
    messageState.nextRunId = Math.max(
        messageState.nextRunId,
        from.prune.messages.nextRunId,
        to.prune.messages.nextRunId,
    )
    target.stats.pruneTokenCounter += to.stats.pruneTokenCounter - from.stats.pruneTokenCounter
    target.stats.totalPruneTokens += to.stats.totalPruneTokens - from.stats.totalPruneTokens
    if (JSON.stringify(target.memo) === JSON.stringify(from.memo))
        target.memo = structuredClone(to.memo)
    mergeSetDelta(
        target.nudges.contextLimitAnchors,
        from.nudges.contextLimitAnchors,
        to.nudges.contextLimitAnchors,
    )
    mergeSetDelta(
        target.nudges.turnNudgeAnchors,
        from.nudges.turnNudgeAnchors,
        to.nudges.turnNudgeAnchors,
    )
    mergeSetDelta(
        target.nudges.iterationNudgeAnchors,
        from.nudges.iterationNudgeAnchors,
        to.nudges.iterationNudgeAnchors,
    )
}

function mergeSetDelta(target: Set<string>, from: Set<string>, to: Set<string>): void {
    for (const value of from) if (!to.has(value)) target.delete(value)
    for (const value of to) if (!from.has(value)) target.add(value)
}
