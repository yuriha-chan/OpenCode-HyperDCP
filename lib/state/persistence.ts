/**
 * State persistence module for DCP plugin.
 * Persists pruned tool IDs across sessions so they survive OpenCode restarts.
 * Storage location: ~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json
 */

import * as fs from "fs/promises"
import { randomUUID } from "crypto"
import { existsSync } from "fs"
import { join } from "path"
import type {
    CompressionBlock,
    PrunedMessageEntry,
    SessionState,
    SessionStats,
    HousekeepingDraftRef,
    HousekeepingSnapshotRef,
    HousekeepingTransaction,
    SkillContext,
} from "./types"
import type { Logger } from "../logger"
import { STORAGE_DIR, getSessionFilePath } from "../paths"
import { serializePruneMessagesState } from "./utils"
import {
    HOUSEKEEPING_DRAFT_VIEW,
    type HousekeepingDraftViewMarker,
} from "../housekeeping/coordinator"
import { withSessionCoordinator } from "../housekeeping/coordinator"
import type { Memo } from "../memo"
import { decodePersistedMemo, isRecord } from "./housekeeping-draft-codec"
import { isHousekeepingRefId } from "./housekeeping-draft-store"

/** Prune state as stored on disk */
export interface PersistedPruneMessagesState {
    byMessageId: Record<string, PrunedMessageEntry>
    blocksById: Record<string, CompressionBlock>
    activeBlockIds: number[]
    activeByAnchorMessageId: Record<string, number>
    nextBlockId: number
    nextRunId: number
    lastSeenUserMessageId?: string
    activeMessageIds?: string[]
}

export interface PersistedPrune {
    tools?: Record<string, number>
    messages?: PersistedPruneMessagesState
}

export interface PersistedNudges {
    contextLimitAnchors: string[]
    turnNudgeAnchors?: string[]
    iterationNudgeAnchors?: string[]
}

export interface PersistedMessageIds {
    byRawId: Record<string, string>
    nextRef: number
}

export interface PersistedSessionState {
    sessionName?: string
    prune: PersistedPrune
    nudges: PersistedNudges
    stats: SessionStats
    protectedRefs?: string[]
    loadedSkills?: SkillContext[]
    protectedSkills?: SkillContext[]
    memo?: string | Memo | null
    messageIds?: PersistedMessageIds
    autotoggle?: boolean
    revision?: number
    contentRevision?: number
    lastUpdated: string
    housekeeping?: Record<string, unknown> | null
    housekeepingHistory?: Array<Record<string, unknown>>
}

type LoadedSessionState = Omit<PersistedSessionState, "memo"> & { memo?: Memo | null }

const writeQueues = new Map<string, Promise<void>>()
const persistedRevisions = new Map<string, number>()

function serializeTransaction(transaction: HousekeepingTransaction): Record<string, unknown> {
    return {
        id: transaction.id,
        sessionId: transaction.sessionId,
        entryMessageId: transaction.entryMessageId,
        entryPartId: transaction.entryPartId,
        entryCallId: transaction.entryCallId,
        entryCreatedAt: transaction.entryCreatedAt,
        sourceParts: transaction.sourceParts,
        baseRevision: transaction.baseRevision,
        baseRef: transaction.baseRef,
        draftRef: transaction.draftRef,
        operations: transaction.operations,
        operationResults: transaction.operationResults,
        operationRecords: transaction.operationRecords,
        entryGuidance: transaction.entryGuidance,
        notifications: transaction.notifications,
        batchTopic: transaction.batchTopic,
        operationOrder: transaction.operationOrder,
        operationDraftRefs: transaction.operationDraftRefs,
        reverted: transaction.reverted,
        completed: transaction.completed
            ? {
                  leaveMessageId: transaction.completed.leaveMessageId,
                  leavePartId: transaction.completed.leavePartId,
                  leaveCallId: transaction.completed.leaveCallId,
                  receipt: transaction.completed.receipt,
                  commitRevision: transaction.completed.commitRevision,
                  committedDraftRef: transaction.completed.committedDraftRef,
              }
            : undefined,
    }
}

export class HousekeepingMetadataError extends Error {}

function invalidTransaction(detail: string): never {
    throw new HousekeepingMetadataError(`Invalid housekeeping transaction metadata: ${detail}`)
}

function restoreDraftRef(value: unknown, label: string): HousekeepingDraftRef {
    if (!isRecord(value) || typeof value.kind !== "string")
        invalidTransaction(`${label} is missing its reference kind.`)
    if (value.kind === "snapshot") {
        if (!isHousekeepingRefId(value.snapshotId))
            invalidTransaction(`${label} is not a valid snapshot reference.`)
        if ("baseSnapshotId" in value)
            invalidTransaction(`${label} snapshot must not carry a base identifier.`)
        return { kind: "snapshot", snapshotId: value.snapshotId }
    }
    if (value.kind === "delta") {
        if (!isHousekeepingRefId(value.snapshotId) || !isHousekeepingRefId(value.baseSnapshotId))
            invalidTransaction(`${label} is not a valid delta reference.`)
        return {
            kind: "delta",
            snapshotId: value.snapshotId,
            baseSnapshotId: value.baseSnapshotId,
        }
    }
    invalidTransaction(`${label} has an invalid reference kind.`)
}

function restoreSnapshotRef(value: unknown, label: string): HousekeepingSnapshotRef {
    const ref = restoreDraftRef(value, label)
    if (ref.kind !== "snapshot") invalidTransaction(`${label} must be a snapshot reference.`)
    return ref
}

function restoreCheckpointRef(
    value: unknown,
    baseRef: HousekeepingSnapshotRef,
    label: string,
): HousekeepingDraftRef {
    const ref = restoreDraftRef(value, label)
    if (ref.kind === "snapshot") {
        if (ref.snapshotId !== baseRef.snapshotId)
            invalidTransaction(`${label} does not reference the transaction base snapshot.`)
        return ref
    }
    if (ref.baseSnapshotId !== baseRef.snapshotId)
        invalidTransaction(`${label} does not reference the transaction base snapshot.`)
    return ref
}

export function restoreHousekeepingTransaction(value: unknown): HousekeepingTransaction | null {
    if (value === undefined || value === null) return null
    if (!isRecord(value)) invalidTransaction("transaction is not an object.")
    const baseRef = restoreSnapshotRef(value.baseRef, "baseRef")
    const draftRef = restoreCheckpointRef(value.draftRef, baseRef, "draftRef")
    if (
        typeof value.id !== "string" ||
        typeof value.sessionId !== "string" ||
        typeof value.entryMessageId !== "string" ||
        typeof value.entryCallId !== "string"
    )
        invalidTransaction("identity fields are incomplete.")
    if (value.entryPartId !== null && typeof value.entryPartId !== "string")
        invalidTransaction("entryPartId is not a string or null.")
    if (typeof value.entryCreatedAt !== "number")
        invalidTransaction("entryCreatedAt is not a number.")
    if (
        !Array.isArray(value.sourceParts) ||
        !value.sourceParts.every(
            (part) =>
                isRecord(part) &&
                typeof part.messageId === "string" &&
                typeof part.partId === "string",
        )
    )
        invalidTransaction("sourceParts is malformed.")
    if (
        !Array.isArray(value.operationOrder) ||
        !value.operationOrder.every((id) => typeof id === "string")
    )
        invalidTransaction("operationOrder is malformed.")
    if (
        !isRecord(value.operations) ||
        !Object.values(value.operations).every((result) => typeof result === "string")
    )
        invalidTransaction("operations is malformed.")
    if (
        !isRecord(value.operationResults) ||
        !Object.values(value.operationResults).every(
            (result) => isRecord(result) && typeof result.result === "string",
        )
    )
        invalidTransaction("operationResults is malformed.")
    if (!isRecord(value.operationDraftRefs))
        invalidTransaction("operationDraftRefs is missing or not an object.")
    const operationDraftRefs: Record<string, HousekeepingDraftRef> = {}
    for (const [id, ref] of Object.entries(value.operationDraftRefs))
        operationDraftRefs[id] = restoreCheckpointRef(
            ref,
            baseRef,
            `operationDraftRefs[${JSON.stringify(id)}]`,
        )
    if (
        !Array.isArray(value.operationRecords) ||
        !value.operationRecords.every(
            (record) =>
                isRecord(record) &&
                typeof record.callId === "string" &&
                typeof record.messageId === "string" &&
                (record.partId === null || typeof record.partId === "string") &&
                typeof record.tool === "string" &&
                typeof record.result === "string",
        )
    )
        invalidTransaction("operationRecords is malformed.")
    if (typeof value.baseRevision !== "number") invalidTransaction("baseRevision is not a number.")
    let completed: HousekeepingTransaction["completed"]
    if (value.completed !== undefined && value.completed !== null) {
        if (
            !isRecord(value.completed) ||
            typeof value.completed.leaveMessageId !== "string" ||
            (value.completed.leavePartId !== null &&
                typeof value.completed.leavePartId !== "string") ||
            typeof value.completed.leaveCallId !== "string" ||
            typeof value.completed.receipt !== "string" ||
            typeof value.completed.commitRevision !== "number"
        )
            invalidTransaction("completed marker is malformed.")
        completed = {
            leaveMessageId: value.completed.leaveMessageId,
            leavePartId: value.completed.leavePartId,
            leaveCallId: value.completed.leaveCallId,
            receipt: value.completed.receipt,
            commitRevision: value.completed.commitRevision,
            committedDraftRef: restoreCheckpointRef(
                value.completed.committedDraftRef,
                baseRef,
                "completed.committedDraftRef",
            ),
        }
    }
    return {
        id: value.id,
        sessionId: value.sessionId,
        entryMessageId: value.entryMessageId,
        entryPartId: value.entryPartId,
        entryCallId: value.entryCallId,
        entryCreatedAt: value.entryCreatedAt,
        sourceParts: value.sourceParts as HousekeepingTransaction["sourceParts"],
        baseRevision: value.baseRevision,
        baseRef,
        draftRef,
        operations: value.operations as Record<string, string>,
        operationResults: value.operationResults as HousekeepingTransaction["operationResults"],
        operationRecords: value.operationRecords as HousekeepingTransaction["operationRecords"],
        entryGuidance: typeof value.entryGuidance === "string" ? value.entryGuidance : undefined,
        notifications: Array.isArray(value.notifications)
            ? (value.notifications as HousekeepingTransaction["notifications"])
            : undefined,
        batchTopic: typeof value.batchTopic === "string" ? value.batchTopic : undefined,
        operationOrder: value.operationOrder,
        operationDraftRefs,
        reverted: value.reverted === true,
        completed,
    }
}

async function ensureStorageDir(): Promise<void> {
    if (!existsSync(STORAGE_DIR)) {
        await fs.mkdir(STORAGE_DIR, { recursive: true })
    }
}

async function writePersistedSessionState(
    sessionId: string,
    state: PersistedSessionState,
    logger: Logger,
    strict = false,
): Promise<void> {
    const previous = writeQueues.get(sessionId) ?? Promise.resolve()
    const write = previous
        .catch(() => undefined)
        .then(async () => {
            const lastRevision = persistedRevisions.get(sessionId) ?? -1
            if (state.revision !== undefined && state.revision < lastRevision) {
                if (strict)
                    throw new Error(
                        `Refusing stale session-state revision ${state.revision}; revision ${lastRevision} is already persisted.`,
                    )
                return
            }
            await ensureStorageDir()
            const filePath = getSessionFilePath(sessionId)
            const temporaryPath = `${filePath}.${randomUUID()}.tmp`
            try {
                await fs.writeFile(temporaryPath, JSON.stringify(state, null, 2), "utf-8")
                await fs.rename(temporaryPath, filePath)
            } catch (error) {
                await fs.rm(temporaryPath, { force: true })
                throw error
            }
            if (state.revision !== undefined) persistedRevisions.set(sessionId, state.revision)
            logger.info("Saved session state atomically", {
                sessionId,
                totalTokensSaved: state.stats.totalPruneTokens,
            })
        })
    writeQueues.set(sessionId, write)
    try {
        await write
    } finally {
        if (writeQueues.get(sessionId) === write) writeQueues.delete(sessionId)
    }
}

export async function saveSessionState(
    sessionState: SessionState,
    logger: Logger,
    sessionName?: string,
): Promise<void> {
    return withSessionCoordinator(sessionState, async () => {
        try {
            if (
                (
                    sessionState as SessionState & {
                        [HOUSEKEEPING_DRAFT_VIEW]?: HousekeepingDraftViewMarker
                    }
                )[HOUSEKEEPING_DRAFT_VIEW]
            ) {
                return
            }
            if (!sessionState.sessionId) {
                return
            }

            sessionState.revision++
            if (!sessionState.housekeeping) sessionState.contentRevision++

            const state: PersistedSessionState = {
                sessionName: sessionName,
                prune: {
                    tools: Object.fromEntries(sessionState.prune.tools),
                    messages: serializePruneMessagesState(sessionState.prune.messages),
                },
                nudges: {
                    contextLimitAnchors: Array.from(sessionState.nudges.contextLimitAnchors),
                    turnNudgeAnchors: Array.from(sessionState.nudges.turnNudgeAnchors),
                    iterationNudgeAnchors: Array.from(sessionState.nudges.iterationNudgeAnchors),
                },
                protectedRefs: Array.from(sessionState.protectedRefs),
                loadedSkills: structuredClone(sessionState.loadedSkills),
                protectedSkills: structuredClone(sessionState.protectedSkills),
                memo: sessionState.memo,
                autotoggle: sessionState.autotoggle,
                revision: sessionState.revision,
                contentRevision: sessionState.contentRevision,
                messageIds: {
                    byRawId: Object.fromEntries(sessionState.messageIds.byRawId),
                    nextRef: sessionState.messageIds.nextRef,
                },
                stats: sessionState.stats,
                lastUpdated: new Date().toISOString(),
                housekeeping: sessionState.housekeeping
                    ? serializeTransaction(sessionState.housekeeping)
                    : null,
                housekeepingHistory: sessionState.housekeepingHistory.map(serializeTransaction),
            }

            await writePersistedSessionState(sessionState.sessionId, state, logger)
        } catch (error: any) {
            logger.error("Failed to save session state", {
                sessionId: sessionState.sessionId,
                error: error?.message,
            })
        }
    })
}

export async function saveSessionStateStrict(
    sessionState: SessionState,
    logger: Logger,
    sessionName?: string,
): Promise<void> {
    if (
        (
            sessionState as SessionState & {
                [HOUSEKEEPING_DRAFT_VIEW]?: HousekeepingDraftViewMarker
            }
        )[HOUSEKEEPING_DRAFT_VIEW]
    ) {
        throw new Error("A housekeeping draft must be committed through the session coordinator.")
    }
    return withSessionCoordinator(sessionState, async () => {
        if (!sessionState.sessionId) return
        sessionState.revision =
            Math.max(sessionState.revision, persistedRevisions.get(sessionState.sessionId) ?? -1) +
            1
        const state: PersistedSessionState = {
            sessionName,
            prune: {
                tools: Object.fromEntries(sessionState.prune.tools),
                messages: serializePruneMessagesState(sessionState.prune.messages),
            },
            nudges: {
                contextLimitAnchors: Array.from(sessionState.nudges.contextLimitAnchors),
                turnNudgeAnchors: Array.from(sessionState.nudges.turnNudgeAnchors),
                iterationNudgeAnchors: Array.from(sessionState.nudges.iterationNudgeAnchors),
            },
            protectedRefs: Array.from(sessionState.protectedRefs),
            loadedSkills: structuredClone(sessionState.loadedSkills),
            protectedSkills: structuredClone(sessionState.protectedSkills),
            memo: sessionState.memo,
            autotoggle: sessionState.autotoggle,
            revision: sessionState.revision,
            contentRevision: sessionState.contentRevision,
            messageIds: {
                byRawId: Object.fromEntries(sessionState.messageIds.byRawId),
                nextRef: sessionState.messageIds.nextRef,
            },
            stats: structuredClone(sessionState.stats),
            lastUpdated: new Date().toISOString(),
            housekeeping: sessionState.housekeeping
                ? serializeTransaction(sessionState.housekeeping)
                : null,
            housekeepingHistory: sessionState.housekeepingHistory.map(serializeTransaction),
        }
        await writePersistedSessionState(sessionState.sessionId, state, logger, true)
    })
}

export async function loadSessionState(
    sessionId: string,
    logger: Logger,
): Promise<LoadedSessionState | null> {
    try {
        const filePath = getSessionFilePath(sessionId)

        if (!existsSync(filePath)) {
            return null
        }

        const content = await fs.readFile(filePath, "utf-8")
        const state = JSON.parse(content) as PersistedSessionState

        const hasPruneTools = state?.prune?.tools && typeof state.prune.tools === "object"
        const hasPruneMessages = state?.prune?.messages && typeof state.prune.messages === "object"
        const hasNudgeFormat = state?.nudges && typeof state.nudges === "object"
        if (
            !state ||
            !state.prune ||
            !hasPruneTools ||
            !hasPruneMessages ||
            !state.stats ||
            !hasNudgeFormat
        ) {
            logger.warn("Invalid session state file, ignoring", {
                sessionId: sessionId,
            })
            return null
        }

        const memo = decodePersistedMemo(state.memo)
        state.memo = memo
        const loadedState: LoadedSessionState = Object.assign(state, { memo })

        const rawContextLimitAnchors = Array.isArray(state.nudges.contextLimitAnchors)
            ? state.nudges.contextLimitAnchors
            : []
        const validAnchors = rawContextLimitAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedAnchors = [...new Set(validAnchors)]
        if (validAnchors.length !== rawContextLimitAnchors.length) {
            logger.warn("Filtered out malformed contextLimitAnchors entries", {
                sessionId: sessionId,
                original: rawContextLimitAnchors.length,
                valid: validAnchors.length,
            })
        }
        state.nudges.contextLimitAnchors = dedupedAnchors

        const rawTurnNudgeAnchors = Array.isArray(state.nudges.turnNudgeAnchors)
            ? state.nudges.turnNudgeAnchors
            : []
        const validSoftAnchors = rawTurnNudgeAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedSoftAnchors = [...new Set(validSoftAnchors)]
        if (validSoftAnchors.length !== rawTurnNudgeAnchors.length) {
            logger.warn("Filtered out malformed turnNudgeAnchors entries", {
                sessionId: sessionId,
                original: rawTurnNudgeAnchors.length,
                valid: validSoftAnchors.length,
            })
        }
        state.nudges.turnNudgeAnchors = dedupedSoftAnchors

        const rawIterationNudgeAnchors = Array.isArray(state.nudges.iterationNudgeAnchors)
            ? state.nudges.iterationNudgeAnchors
            : []
        const validIterationAnchors = rawIterationNudgeAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedIterationAnchors = [...new Set(validIterationAnchors)]
        if (validIterationAnchors.length !== rawIterationNudgeAnchors.length) {
            logger.warn("Filtered out malformed iterationNudgeAnchors entries", {
                sessionId: sessionId,
                original: rawIterationNudgeAnchors.length,
                valid: validIterationAnchors.length,
            })
        }
        state.nudges.iterationNudgeAnchors = dedupedIterationAnchors

        logger.info("Loaded session state from disk", {
            sessionId: sessionId,
        })

        return loadedState
    } catch (error: any) {
        logger.warn("Failed to load session state", {
            sessionId: sessionId,
            error: error?.message,
        })
        return null
    }
}

export interface AggregatedStats {
    totalTokens: number
    totalTools: number
    totalMessages: number
    sessionCount: number
}

export async function loadAllSessionStats(logger: Logger): Promise<AggregatedStats> {
    const result: AggregatedStats = {
        totalTokens: 0,
        totalTools: 0,
        totalMessages: 0,
        sessionCount: 0,
    }

    try {
        if (!existsSync(STORAGE_DIR)) {
            return result
        }

        const files = await fs.readdir(STORAGE_DIR)
        const jsonFiles = files.filter((f) => f.endsWith(".json"))

        for (const file of jsonFiles) {
            try {
                const filePath = join(STORAGE_DIR, file)
                const content = await fs.readFile(filePath, "utf-8")
                const state = JSON.parse(content) as PersistedSessionState

                if (state?.stats?.totalPruneTokens && state?.prune) {
                    result.totalTokens += state.stats.totalPruneTokens
                    result.totalTools += state.prune.tools
                        ? Object.keys(state.prune.tools).length
                        : 0
                    result.totalMessages += state.prune.messages?.byMessageId
                        ? Object.keys(state.prune.messages.byMessageId).length
                        : 0
                    result.sessionCount++
                }
            } catch {
                // Skip invalid files
            }
        }

        logger.debug("Loaded all-time stats", result)
    } catch (error: any) {
        logger.warn("Failed to load all-time stats", { error: error?.message })
    }

    return result
}
