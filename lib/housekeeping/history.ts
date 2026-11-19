import type {
    HousekeepingDraft,
    HousekeepingDraftRef,
    HousekeepingTransaction,
    SessionState,
    WithParts,
} from "../state"
import { readHousekeepingDraft } from "../state/housekeeping-draft-store"
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

const OPERATION_CATEGORIES = new Map<string, string>([
    ["compress", "compression"],
    ["toggle_summary_version", "summary toggle"],
    ["command:toggle", "summary toggle"],
    ["edit_memo", "memo edit"],
    ["command:memo", "memo edit"],
    ["command:memo-file", "memo edit"],
    ["edit_summary", "summary edit"],
    ["append_summary", "summary edit"],
    ["rewrite_summary", "summary edit"],
    ["command:edit", "summary edit"],
    ["command:edit-file", "summary edit"],
    ["expand_block", "expansion"],
    ["command:decompress", "expansion"],
    ["command:recompress", "recompression"],
    ["command:sweep", "sweep"],
])

const OPERATION_CATEGORY_ORDER = [
    "compression",
    "summary toggle",
    "memo edit",
    "summary edit",
    "expansion",
    "recompression",
    "sweep",
] as const

function formatOperationCounts(transaction: HousekeepingTransaction): string {
    const counts = new Map<string, number>()
    for (const operation of transaction.operationRecords) {
        const category = OPERATION_CATEGORIES.get(operation.tool)
        if (category) counts.set(category, (counts.get(category) ?? 0) + 1)
    }
    const summary = OPERATION_CATEGORY_ORDER.flatMap((category) => {
        const count = counts.get(category) ?? 0
        if (!count) return []
        return [`${count} ${category}${count === 1 ? "" : "s"}`]
    }).join(", ")
    return `${summary ? `${summary}. ` : ""}details truncated.`
}

export function captureEligibleSourceMessages(
    messages: WithParts[],
    entryMessageId: string,
    entryCallId: string,
    transactions: HousekeepingTransaction[],
): string[] {
    const projected = projectHousekeepingHistory(messages, transactions)
    const sourceMessageIds: string[] = []
    const seen = new Set<string>()
    for (const message of projected) {
        if (!seen.has(message.info.id)) {
            seen.add(message.info.id)
            sourceMessageIds.push(message.info.id)
        }
        const containsEntry = message.parts.some(
            (part) => part.type === "tool" && part.callID === entryCallId,
        )
        if (message.info.id === entryMessageId && containsEntry) return sourceMessageIds
    }
    return sourceMessageIds
}

export function projectEligibleSourceMessages(
    messages: WithParts[],
    transaction: Pick<HousekeepingTransaction, "sourceMessageIds">,
): WithParts[] {
    const allowed = new Set(transaction.sourceMessageIds)
    return messages.flatMap((message) => {
        if (!allowed.has(message.info.id)) return []
        const parts: WithParts["parts"] = []
        for (const part of message.parts) {
            if (part.type === "tool" && isHousekeepingToolName(part.tool)) continue
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

export interface ProjectionPart {
    messageId: string
    messageIndex: number
    callId?: string
}

function markHiddenInclusive(difference: Int32Array, start: number, end: number): void {
    if (end < start) return
    difference[start] += 1
    difference[end + 1] -= 1
}

function maskingSegments(
    difference: Int32Array,
    start: number,
    end: number,
    retained: ReadonlySet<number>,
): void {
    let segmentStart = start
    for (const position of [...retained].sort((left, right) => left - right)) {
        if (position < start || position > end) continue
        if (position > segmentStart) markHiddenInclusive(difference, segmentStart, position - 1)
        segmentStart = position + 1
    }
    markHiddenInclusive(difference, segmentStart, end)
}

export function planHousekeepingProjection(
    parts: readonly ProjectionPart[],
    transactions: readonly HousekeepingTransaction[],
    messageIds: readonly string[],
    messageEnds: readonly number[],
) {
    const hidden = new Int32Array(parts.length + 1)
    const boundaryEdits = new Map<number, { output: string; title: string }>()
    const callPositions = new Map<string, Map<string, number[]>>()
    for (const [position, part] of parts.entries()) {
        if (part.callId === undefined) continue
        let calls = callPositions.get(part.messageId)
        if (!calls) {
            calls = new Map()
            callPositions.set(part.messageId, calls)
        }
        const positions = calls.get(part.callId)
        if (positions) positions.push(position)
        else calls.set(part.callId, [position])
    }
    const matchingPositions = (messageId: string, callId: string): number[] =>
        callPositions.get(messageId)?.get(callId) ?? []
    const endOfMessage = (position: number): number => messageEnds[parts[position].messageIndex]

    for (const transaction of transactions) {
        const entryPositions = matchingPositions(
            transaction.entryMessageId,
            transaction.entryCallId,
        )
        const entryPosition = entryPositions.at(-1)
        const leavePositions = transaction.completed
            ? matchingPositions(
                  transaction.completed.leaveMessageId,
                  transaction.completed.leaveCallId,
              )
            : []
        const leavePosition = leavePositions.at(-1)
        if (transaction.completed) {
            const output = formatOperationCounts(transaction)
            for (const current of entryPositions) {
                boundaryEdits.set(current, {
                    output,
                    title: "Housekeeping entry",
                })
            }
            for (const current of leavePositions) {
                boundaryEdits.set(current, {
                    output: transaction.completed.receipt,
                    title: "Housekeeping receipt",
                })
            }
        }
        if (!transaction.completed && entryPosition !== undefined) continue

        let start: number | undefined
        if (entryPosition !== undefined) {
            start = endOfMessage(entryPosition)
        } else {
            const sourceIds = new Set(transaction.sourceMessageIds)
            let sourceIndex = -1
            messageIds.forEach((messageId, index) => {
                if (sourceIds.has(messageId)) sourceIndex = index
            })
            if (sourceIndex >= 0) start = messageEnds[sourceIndex]
        }
        if (start === undefined) continue

        if (leavePosition !== undefined) {
            const leaveMessageIndex = parts[leavePosition].messageIndex
            const retained = new Set(
                leavePositions.filter(
                    (position) => parts[position].messageIndex === leaveMessageIndex,
                ),
            )
            maskingSegments(hidden, start + 1, endOfMessage(leavePosition), retained)
            continue
        }

        let operationMaximum: number | undefined
        for (const operation of transaction.operationRecords) {
            for (const current of matchingPositions(operation.messageId, operation.callId)) {
                if (operationMaximum === undefined || current > operationMaximum) {
                    operationMaximum = current
                }
            }
        }
        if (operationMaximum !== undefined) {
            markHiddenInclusive(hidden, start + 1, operationMaximum - 1)
        }
    }
    let hiddenDepth = 0
    for (let position = 0; position < parts.length; position++) {
        hiddenDepth += hidden[position]
        hidden[position] = hiddenDepth
    }
    return { hidden, boundaryEdits }
}

export function projectHousekeepingHistory(
    messages: WithParts[],
    transactions: HousekeepingTransaction[],
): WithParts[] {
    const parts: ProjectionPart[] = []
    const messageIds: string[] = []
    const messageEnds: number[] = []
    messages.forEach((message, messageIndex) => {
        messageIds.push(message.info.id)
        for (const part of message.parts) {
            parts.push({
                messageId: message.info.id,
                messageIndex,
                callId: part.type === "tool" ? part.callID : undefined,
            })
        }
        messageEnds.push(parts.length - 1)
    })
    const { hidden, boundaryEdits } = planHousekeepingProjection(
        parts,
        transactions,
        messageIds,
        messageEnds,
    )
    let position = 0
    const result: WithParts[] = []
    for (const message of messages) {
        const parts = message.parts.flatMap((part) => {
            const current = position++
            if (hidden[current] > 0) return []
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

export async function reconcileHousekeepingHistory(
    state: SessionState,
    messages: WithParts[],
): Promise<boolean> {
    let changed = false
    const hasCall = (messageId: string, callId: string): boolean =>
        messages.some(
            (message) =>
                message.info.id === messageId &&
                message.parts.some(
                    (part) => part.type === "tool" && part.callID === callId,
                ),
        )
    const callSurvives = (record: HousekeepingTransaction["operationRecords"][number]): boolean =>
        record.tool.startsWith("command:")
            ? messages.some((message) => message.info.id === record.messageId)
            : hasCall(record.messageId, record.callId)
    const readDraft = (transaction: HousekeepingTransaction, ref: HousekeepingDraftRef) =>
        readHousekeepingDraft(transaction.sessionId, ref)
    const survivingOperationRefs = (
        transaction: HousekeepingTransaction,
        operations: HousekeepingTransaction["operationRecords"],
        active?: HousekeepingTransaction,
    ): Record<string, HousekeepingTransaction["operationDraftRefs"][string]> =>
        Object.fromEntries(
            operations.flatMap((operation) => {
                const key = operationIdentity(operation.messageId, operation.callId)
                const ref = active?.operationDraftRefs[key] ?? transaction.operationDraftRefs[key]
                return ref ? [[key, structuredClone(ref)] as const] : []
            }),
        )
    const lastDraftRef = (
        refs: Record<string, HousekeepingTransaction["operationDraftRefs"][string]>,
        order: string[],
        baseRef: HousekeepingTransaction["baseRef"],
    ): HousekeepingDraftRef => {
        if (!order.length) return structuredClone(baseRef)
        const key = order.at(-1)!
        const ref = refs[key]
        if (!ref) throw new Error(`Missing housekeeping checkpoint reference for ${key}.`)
        return structuredClone(ref)
    }
    const transactions = [...state.housekeepingHistory]
    const undoTransactions = transactions
        .filter((transaction) => {
            if (!transaction.completed) return false
            const entrySurvives = hasCall(
                transaction.entryMessageId,
                transaction.entryCallId,
            )
            const leaveSurvives = hasCall(
                transaction.completed.leaveMessageId,
                transaction.completed.leaveCallId,
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
        )
        const leaveSurvives = transaction.completed
            ? hasCall(
                  transaction.completed.leaveMessageId,
                  transaction.completed.leaveCallId,
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
                const operationDraftRefs = survivingOperationRefs(
                    transaction,
                    survivingOperations,
                    active,
                )
                active.operationOrder = survivingOrder
                active.operationRecords = survivingOperations
                active.operationDraftRefs = operationDraftRefs
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
                active.draftRef = lastDraftRef(operationDraftRefs, survivingOrder, active.baseRef)
                transaction.operationOrder = [...active.operationOrder]
                transaction.operationRecords = [...active.operationRecords]
                transaction.operationDraftRefs = structuredClone(active.operationDraftRefs)
                transaction.operationResults = structuredClone(active.operationResults)
                transaction.operations = structuredClone(active.operations)
                transaction.draftRef = structuredClone(active.draftRef)
                changed = true
            }
            continue
        }

        if (transaction.completed && (!entrySurvives || !leaveSurvives) && !compactedPastEntry) {
            if (!transaction.reverted) {
                const workingDraft = await readDraft(transaction, transaction.draftRef)
                const baseDraft = await readDraft(transaction, transaction.baseRef)
                applyDraftDelta(state, workingDraft, baseDraft)
                state.contentRevision = transaction.baseRevision
                transaction.reverted = true
                changed = true
            }
            if (entrySurvives) {
                const operationDraftRefs = survivingOperationRefs(transaction, survivingOperations)
                const reopened: HousekeepingTransaction = {
                    ...structuredClone(transaction),
                    completed: undefined,
                    operationOrder: [...survivingOrder],
                    operationRecords: survivingOperations,
                    operationDraftRefs,
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
                    draftRef: lastDraftRef(operationDraftRefs, survivingOrder, transaction.baseRef),
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
            const baseDraft = await readDraft(transaction, transaction.baseRef)
            const committedDraft = await readDraft(
                transaction,
                transaction.completed.committedDraftRef,
            )
            applyDraftDelta(state, baseDraft, committedDraft)
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
    from: HousekeepingDraft,
    to: HousekeepingDraft,
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
    if (JSON.stringify(target.protectedSkills) === JSON.stringify(from.protectedSkills))
        target.protectedSkills = structuredClone(to.protectedSkills)
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
