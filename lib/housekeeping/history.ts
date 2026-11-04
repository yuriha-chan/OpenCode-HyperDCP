import type {
    HousekeepingDraft,
    HousekeepingDraftRef,
    HousekeepingSourcePart,
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

type PartPositions = Map<string, Map<string | null, number[]>>

function appendPosition(
    index: PartPositions,
    messageId: string,
    key: string | null,
    position: number,
): void {
    let byKey = index.get(messageId)
    if (!byKey) {
        byKey = new Map()
        index.set(messageId, byKey)
    }
    const positions = byKey.get(key)
    if (positions) positions.push(position)
    else byKey.set(key, [position])
}

function lastPosition(positions: number[] | undefined): number | undefined {
    return positions?.[positions.length - 1]
}

function boundaryPositions(
    partPositions: PartPositions,
    toolCallPositions: PartPositions,
    parts: WithParts["parts"],
    messageId: string,
    callId: string,
    partId: string | null,
): number[] {
    if (partId === null) {
        return toolCallPositions.get(messageId)?.get(callId) ?? []
    }
    const candidates = partPositions.get(messageId)?.get(partId) ?? []
    return candidates.filter((position) => {
        const part = parts[position]
        return part.type === "tool" && part.callID === callId
    })
}

function markHiddenInterval(difference: Int32Array, start: number, end: number): void {
    if (end <= start + 1) return
    difference[start + 1] += 1
    difference[end] -= 1
}

export function projectHousekeepingHistory(
    messages: WithParts[],
    transactions: HousekeepingTransaction[],
): WithParts[] {
    const partPositions: PartPositions = new Map()
    const toolCallPositions: PartPositions = new Map()
    const parts: WithParts["parts"] = []
    for (const message of messages) {
        for (const part of message.parts) {
            const position = parts.length
            parts.push(part)
            appendPosition(partPositions, message.info.id, part.id, position)
            if (part.type === "tool") {
                appendPosition(toolCallPositions, message.info.id, part.callID, position)
            }
        }
    }
    const hidden = new Int32Array(parts.length + 1)
    const boundaryEdits = new Map<number, { output: string; title: string }>()
    for (const transaction of transactions) {
        const entryPositions = boundaryPositions(
            partPositions,
            toolCallPositions,
            parts,
            transaction.entryMessageId,
            transaction.entryCallId,
            transaction.entryPartId,
        )
        const entryPosition = lastPosition(entryPositions)
        if (transaction.completed && entryPositions?.length) {
            const output = formatOperationCounts(transaction)
            for (const current of entryPositions) {
                boundaryEdits.set(current, {
                    output,
                    title: "Housekeeping entry",
                })
            }
        }
        let leavePositions: number[] | undefined
        let leavePosition: number | undefined
        if (transaction.completed) {
            leavePositions = boundaryPositions(
                partPositions,
                toolCallPositions,
                parts,
                transaction.completed.leaveMessageId,
                transaction.completed.leaveCallId,
                transaction.completed.leavePartId,
            )
            leavePosition = lastPosition(leavePositions)
            for (const current of leavePositions) {
                boundaryEdits.set(current, {
                    output: transaction.completed.receipt,
                    title: "Housekeeping receipt",
                })
            }
        }
        let sourceBoundaryPosition: number | undefined
        for (const source of transaction.sourceParts) {
            const candidate = lastPosition(partPositions.get(source.messageId)?.get(source.partId))
            if (
                candidate !== undefined &&
                (sourceBoundaryPosition === undefined || candidate > sourceBoundaryPosition)
            ) {
                sourceBoundaryPosition = candidate
            }
        }
        let operationMaximum: number | undefined
        for (const operation of transaction.operationRecords) {
            const positions = partPositions.get(operation.messageId)?.get(operation.partId)
            if (!positions) continue
            for (const current of positions) {
                const part = parts[current]
                if (part.type !== "tool" || part.callID !== operation.callId) continue
                if (operationMaximum === undefined || current > operationMaximum) {
                    operationMaximum = current
                }
            }
        }
        if (entryPosition !== undefined && leavePosition !== undefined) {
            markHiddenInterval(hidden, entryPosition, leavePosition)
        } else if (entryPosition === undefined && sourceBoundaryPosition !== undefined) {
            const end =
                leavePosition ??
                Math.max(sourceBoundaryPosition, operationMaximum ?? sourceBoundaryPosition)
            markHiddenInterval(hidden, sourceBoundaryPosition, end)
        }
    }
    let position = 0
    let hiddenDepth = 0
    const result: WithParts[] = []
    for (const message of messages) {
        const parts = message.parts.flatMap((part) => {
            const current = position++
            hiddenDepth += hidden[current]
            if (hiddenDepth > 0) return []
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
