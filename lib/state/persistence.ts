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
    HousekeepingTransaction,
} from "./types"
import type { Logger } from "../logger"
import { STORAGE_DIR, getSessionFilePath } from "../paths"
import { serializePruneMessagesState, loadPruneMessagesState, loadPruneMap } from "./utils"
import {
    HOUSEKEEPING_DRAFT_VIEW,
    type HousekeepingDraftViewMarker,
} from "../housekeeping/coordinator"
import { withSessionCoordinator } from "../housekeeping/coordinator"

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
    memo?: string | null
    messageIds?: PersistedMessageIds
    autotoggle?: boolean
    revision?: number
    contentRevision?: number
    lastUpdated: string
    housekeeping?: Record<string, unknown> | null
    housekeepingHistory?: Array<Record<string, unknown>>
}

const writeQueues = new Map<string, Promise<void>>()
const persistedRevisions = new Map<string, number>()

function serializeTransaction(transaction: HousekeepingTransaction): Record<string, unknown> {
    const serializeDraft = (draft: HousekeepingTransaction["draft"]): Record<string, unknown> => ({
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
    })
    return {
        ...transaction,
        base: serializeDraft(transaction.base),
        draft: serializeDraft(transaction.draft),
        completed: transaction.completed
            ? {
                  ...transaction.completed,
                  committedDraft: serializeDraft(transaction.completed.committedDraft),
              }
            : undefined,
        operationDrafts: Object.fromEntries(
            Object.entries(transaction.operationDrafts).map(([id, draft]) => [
                id,
                serializeDraft(draft),
            ]),
        ),
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function restoreDraft(value: unknown): HousekeepingTransaction["draft"] | null {
    if (!isRecord(value) || !isRecord(value.prune) || !isRecord(value.nudges)) return null
    if (
        !isRecord(value.stats) ||
        typeof value.stats.pruneTokenCounter !== "number" ||
        typeof value.stats.totalPruneTokens !== "number"
    )
        return null
    if (value.memo !== null && typeof value.memo !== "string") return null
    const asStringArray = (input: unknown): string[] | null =>
        Array.isArray(input) && input.every((entry) => typeof entry === "string") ? input : null
    const contextLimitAnchors = asStringArray(value.nudges.contextLimitAnchors)
    const turnNudgeAnchors = asStringArray(value.nudges.turnNudgeAnchors)
    const iterationNudgeAnchors = asStringArray(value.nudges.iterationNudgeAnchors)
    if (!contextLimitAnchors || !turnNudgeAnchors || !iterationNudgeAnchors) return null
    const pruneTools = isRecord(value.prune.tools) ? value.prune.tools : {}
    if (!Object.values(pruneTools).every((count) => typeof count === "number")) return null
    if (!isRecord(value.prune.messages)) return null
    return {
        prune: {
            tools: loadPruneMap(pruneTools as Record<string, number>),
            messages: loadPruneMessagesState(
                value.prune.messages as unknown as Parameters<typeof loadPruneMessagesState>[0],
            ),
        },
        stats: {
            pruneTokenCounter: value.stats.pruneTokenCounter,
            totalPruneTokens: value.stats.totalPruneTokens,
        },
        memo: value.memo,
        nudges: {
            contextLimitAnchors: new Set(contextLimitAnchors),
            turnNudgeAnchors: new Set(turnNudgeAnchors),
            iterationNudgeAnchors: new Set(iterationNudgeAnchors),
        },
    }
}

export function restoreHousekeepingTransaction(value: unknown): HousekeepingTransaction | null {
    if (!isRecord(value)) return null
    const base = restoreDraft(value.base)
    const draft = restoreDraft(value.draft)
    if (!base || !draft) return null
    if (
        typeof value.id !== "string" ||
        typeof value.sessionId !== "string" ||
        typeof value.entryMessageId !== "string" ||
        typeof value.entryCallId !== "string"
    )
        return null
    if (value.entryPartId !== null && typeof value.entryPartId !== "string") return null
    if (typeof value.entryCreatedAt !== "number") return null
    if (
        !Array.isArray(value.sourceParts) ||
        !value.sourceParts.every(
            (part) =>
                isRecord(part) &&
                typeof part.messageId === "string" &&
                typeof part.partId === "string",
        )
    )
        return null
    if (
        !Array.isArray(value.operationOrder) ||
        !value.operationOrder.every((id) => typeof id === "string")
    )
        return null
    if (
        !isRecord(value.operations) ||
        !Object.values(value.operations).every((result) => typeof result === "string")
    )
        return null
    if (
        !isRecord(value.operationResults) ||
        !Object.values(value.operationResults).every(
            (result) => isRecord(result) && typeof result.result === "string",
        )
    )
        return null
    if (!isRecord(value.operationDrafts)) return null
    const operationDrafts: Record<string, HousekeepingTransaction["draft"]> = {}
    for (const [id, snapshot] of Object.entries(value.operationDrafts)) {
        const restored = restoreDraft(snapshot)
        if (!restored) return null
        operationDrafts[id] = restored
    }
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
        return null
    if (typeof value.baseRevision !== "number") return null
    return {
        id: value.id,
        sessionId: value.sessionId,
        entryMessageId: value.entryMessageId,
        entryPartId: value.entryPartId,
        entryCallId: value.entryCallId,
        entryCreatedAt: value.entryCreatedAt,
        sourceParts: value.sourceParts as HousekeepingTransaction["sourceParts"],
        baseRevision: value.baseRevision,
        base,
        draft,
        operations: value.operations as Record<string, string>,
        operationResults: value.operationResults as HousekeepingTransaction["operationResults"],
        operationRecords: value.operationRecords as HousekeepingTransaction["operationRecords"],
        entryGuidance: typeof value.entryGuidance === "string" ? value.entryGuidance : undefined,
        notifications: Array.isArray(value.notifications)
            ? (value.notifications as HousekeepingTransaction["notifications"])
            : undefined,
        batchTopic: typeof value.batchTopic === "string" ? value.batchTopic : undefined,
        operationOrder: value.operationOrder,
        operationDrafts,
        reverted: value.reverted === true,
        completed:
            isRecord(value.completed) &&
            typeof value.completed.leaveMessageId === "string" &&
            (value.completed.leavePartId === null ||
                typeof value.completed.leavePartId === "string") &&
            typeof value.completed.leaveCallId === "string" &&
            typeof value.completed.receipt === "string" &&
            typeof value.completed.commitRevision === "number" &&
            restoreDraft(value.completed.committedDraft)
                ? {
                      leaveMessageId: value.completed.leaveMessageId,
                      leavePartId: value.completed.leavePartId,
                      leaveCallId: value.completed.leaveCallId,
                      receipt: value.completed.receipt,
                      commitRevision: value.completed.commitRevision,
                      committedDraft: restoreDraft(value.completed.committedDraft)!,
                  }
                : undefined,
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
): Promise<PersistedSessionState | null> {
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

        return state
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
