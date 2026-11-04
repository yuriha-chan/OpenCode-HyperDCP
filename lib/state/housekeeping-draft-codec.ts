import type { HousekeepingDraft } from "./types"
import { loadPruneMap, loadPruneMessagesState, serializePruneMessagesState } from "./utils"
import { parseMemo, validateMemo, type Memo } from "../memo"

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function serializeHousekeepingDraft(draft: HousekeepingDraft): Record<string, unknown> {
    return {
        prune: {
            tools: Object.fromEntries(draft.prune.tools),
            messages: serializePruneMessagesState(draft.prune.messages),
        },
        stats: structuredClone(draft.stats),
        memo: draft.memo,
        nudges: {
            contextLimitAnchors: [...draft.nudges.contextLimitAnchors],
            turnNudgeAnchors: [...draft.nudges.turnNudgeAnchors],
            iterationNudgeAnchors: [...draft.nudges.iterationNudgeAnchors],
        },
    }
}

const BLOCK_NUMBER_FIELDS = [
    "blockId",
    "runId",
    "compressedTokens",
    "summaryTokens",
    "durationMs",
    "createdAt",
    "activeVersionIndex",
] as const
const BLOCK_STRING_FIELDS = [
    "topic",
    "startId",
    "endId",
    "anchorMessageId",
    "compressMessageId",
    "summary",
] as const
const BLOCK_BOOLEAN_FIELDS = ["active", "deactivatedByUser"] as const
const BLOCK_NUMBER_ARRAY_FIELDS = [
    "includedBlockIds",
    "consumedBlockIds",
    "parentBlockIds",
] as const
const BLOCK_STRING_ARRAY_FIELDS = [
    "directMessageIds",
    "directToolIds",
    "effectiveMessageIds",
    "effectiveToolIds",
    "summaryVersions",
] as const
const BLOCK_OPTIONAL_STRING_FIELDS = ["batchTopic", "compressCallId", "pendingEditBuffer"] as const

function invalid(detail: string): never {
    throw new Error(detail)
}

function isNumber(value: unknown): value is number {
    return typeof value === "number"
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

function isNumberArray(value: unknown): value is number[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === "number")
}

function validatePrunedMessageEntry(value: unknown, messageId: string): void {
    if (!isRecord(value))
        invalid(`prune.messages.byMessageId[${JSON.stringify(messageId)}] is not an object.`)
    if (!isNumber(value.tokenCount))
        invalid(
            `prune.messages.byMessageId[${JSON.stringify(messageId)}].tokenCount is not a number.`,
        )
    if (!isNumberArray(value.allBlockIds))
        invalid(
            `prune.messages.byMessageId[${JSON.stringify(messageId)}].allBlockIds is not a number array.`,
        )
    if (!isNumberArray(value.activeBlockIds))
        invalid(
            `prune.messages.byMessageId[${JSON.stringify(messageId)}].activeBlockIds is not a number array.`,
        )
}

function validateCompressionBlock(value: unknown, blockId: string): void {
    if (!isRecord(value))
        invalid(`prune.messages.blocksById[${JSON.stringify(blockId)}] is not an object.`)
    for (const field of BLOCK_NUMBER_FIELDS) {
        if (!isNumber(value[field]))
            invalid(
                `prune.messages.blocksById[${JSON.stringify(blockId)}].${field} is not a number.`,
            )
    }
    for (const field of BLOCK_STRING_FIELDS) {
        if (typeof value[field] !== "string")
            invalid(
                `prune.messages.blocksById[${JSON.stringify(blockId)}].${field} is not a string.`,
            )
    }
    for (const field of BLOCK_BOOLEAN_FIELDS) {
        if (typeof value[field] !== "boolean")
            invalid(
                `prune.messages.blocksById[${JSON.stringify(blockId)}].${field} is not a boolean.`,
            )
    }
    for (const field of BLOCK_NUMBER_ARRAY_FIELDS) {
        if (!isNumberArray(value[field]))
            invalid(
                `prune.messages.blocksById[${JSON.stringify(blockId)}].${field} is not a number array.`,
            )
    }
    for (const field of BLOCK_STRING_ARRAY_FIELDS) {
        if (!isStringArray(value[field]))
            invalid(
                `prune.messages.blocksById[${JSON.stringify(blockId)}].${field} is not a string array.`,
            )
    }
    for (const field of BLOCK_OPTIONAL_STRING_FIELDS) {
        if (value[field] !== undefined && typeof value[field] !== "string")
            invalid(
                `prune.messages.blocksById[${JSON.stringify(blockId)}].${field} is not a string.`,
            )
    }
    if (value.mode !== undefined && value.mode !== "range" && value.mode !== "message")
        invalid(
            `prune.messages.blocksById[${JSON.stringify(blockId)}].mode is not a compression mode.`,
        )
    if (value.deactivatedAt !== undefined && !isNumber(value.deactivatedAt))
        invalid(
            `prune.messages.blocksById[${JSON.stringify(blockId)}].deactivatedAt is not a number.`,
        )
    if (value.deactivatedByBlockId !== undefined && !isNumber(value.deactivatedByBlockId))
        invalid(
            `prune.messages.blocksById[${JSON.stringify(blockId)}].deactivatedByBlockId is not a number.`,
        )
    if (
        value.pendingExpandedMessageIds !== undefined &&
        !isStringArray(value.pendingExpandedMessageIds)
    )
        invalid(
            `prune.messages.blocksById[${JSON.stringify(blockId)}].pendingExpandedMessageIds is not a string array.`,
        )
}

export function validateHousekeepingDraftPayload(value: unknown): void {
    if (!isRecord(value)) invalid("housekeeping draft payload is not an object.")
    if (!isRecord(value.prune)) invalid("housekeeping draft prune state is not an object.")
    if (!isRecord(value.prune.tools))
        invalid("housekeeping draft prune.tools is missing or not an object.")
    for (const [tool, count] of Object.entries(value.prune.tools)) {
        if (!isNumber(count))
            invalid(`housekeeping draft prune.tools[${JSON.stringify(tool)}] is not a number.`)
    }
    const messages = value.prune.messages
    if (!isRecord(messages))
        invalid("housekeeping draft prune.messages is missing or not an object.")
    if (!isRecord(messages.byMessageId))
        invalid("housekeeping draft prune.messages.byMessageId is missing or not an object.")
    for (const [messageId, entry] of Object.entries(messages.byMessageId))
        validatePrunedMessageEntry(entry, messageId)
    if (!isRecord(messages.blocksById))
        invalid("housekeeping draft prune.messages.blocksById is missing or not an object.")
    for (const [blockId, block] of Object.entries(messages.blocksById))
        validateCompressionBlock(block, blockId)
    if (!isNumberArray(messages.activeBlockIds))
        invalid("housekeeping draft prune.messages.activeBlockIds is not a number array.")
    if (!isRecord(messages.activeByAnchorMessageId))
        invalid(
            "housekeeping draft prune.messages.activeByAnchorMessageId is missing or not an object.",
        )
    for (const [anchorMessageId, blockId] of Object.entries(messages.activeByAnchorMessageId)) {
        if (!isNumber(blockId))
            invalid(
                `housekeeping draft prune.messages.activeByAnchorMessageId[${JSON.stringify(anchorMessageId)}] is not a number.`,
            )
    }
    if (!isNumber(messages.nextBlockId))
        invalid("housekeeping draft prune.messages.nextBlockId is not a number.")
    if (!isNumber(messages.nextRunId))
        invalid("housekeeping draft prune.messages.nextRunId is not a number.")
    if (
        messages.lastSeenUserMessageId !== undefined &&
        typeof messages.lastSeenUserMessageId !== "string"
    )
        invalid("housekeeping draft prune.messages.lastSeenUserMessageId is not a string.")
    if (messages.activeMessageIds !== undefined && !isStringArray(messages.activeMessageIds))
        invalid("housekeeping draft prune.messages.activeMessageIds is not a string array.")
}

export function decodePersistedMemo(value: unknown): Memo | null {
    if (value === undefined || value === null) return null
    if (typeof value === "string") {
        const memo = parseMemo(value)
        return memo.length ? memo : null
    }
    try {
        validateMemo(value)
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`Invalid persisted memo: ${detail}`)
    }
    return value.length ? value : null
}

export function restoreHousekeepingDraft(value: unknown): HousekeepingDraft | null {
    if (!isRecord(value) || !isRecord(value.prune) || !isRecord(value.nudges)) return null
    if (
        !isRecord(value.stats) ||
        typeof value.stats.pruneTokenCounter !== "number" ||
        typeof value.stats.totalPruneTokens !== "number"
    )
        return null
    let memo: Memo | null
    try {
        memo = decodePersistedMemo(value.memo)
    } catch (error) {
        if (error instanceof Error) return null
        throw error
    }
    const asStringArray = (input: unknown): string[] | null =>
        Array.isArray(input) && input.every((entry) => typeof entry === "string") ? input : null
    const contextLimitAnchors = asStringArray(value.nudges.contextLimitAnchors)
    const turnNudgeAnchors = asStringArray(value.nudges.turnNudgeAnchors)
    const iterationNudgeAnchors = asStringArray(value.nudges.iterationNudgeAnchors)
    if (!contextLimitAnchors || !turnNudgeAnchors || !iterationNudgeAnchors) return null
    const pruneTools = isRecord(value.prune.tools) ? value.prune.tools : {}
    if (!Object.values(pruneTools).every((count) => typeof count === "number")) return null
    if (!isRecord(value.prune.messages)) return null
    const messages = loadPruneMessagesState(
        value.prune.messages as unknown as Parameters<typeof loadPruneMessagesState>[0],
    )
    const rawBlocks = isRecord(value.prune.messages.blocksById)
        ? value.prune.messages.blocksById
        : {}
    for (const [blockId, rawBlock] of Object.entries(rawBlocks)) {
        const restoredBlock = messages.blocksById.get(Number.parseInt(blockId, 10))
        if (!restoredBlock || !isRecord(rawBlock)) continue
        if (typeof rawBlock.pendingEditBuffer === "string")
            restoredBlock.pendingEditBuffer = rawBlock.pendingEditBuffer
        if (Array.isArray(rawBlock.pendingExpandedMessageIds))
            restoredBlock.pendingExpandedMessageIds = rawBlock.pendingExpandedMessageIds.filter(
                (entry): entry is string => typeof entry === "string",
            )
    }
    return {
        prune: {
            tools: loadPruneMap(pruneTools as Record<string, number>),
            messages,
        },
        stats: {
            pruneTokenCounter: value.stats.pruneTokenCounter,
            totalPruneTokens: value.stats.totalPruneTokens,
        },
        memo,
        nudges: {
            contextLimitAnchors: new Set(contextLimitAnchors),
            turnNudgeAnchors: new Set(turnNudgeAnchors),
            iterationNudgeAnchors: new Set(iterationNudgeAnchors),
        },
    }
}
