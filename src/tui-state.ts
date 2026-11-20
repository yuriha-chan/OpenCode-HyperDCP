import type { TuiMessageEntry } from "./tui-client"
import { getSessionFilePath } from "../lib/paths"
import { renderStoredMemo } from "./memo"
import { readFile, stat } from "node:fs/promises"

export interface BlockInfo {
    blockId: number
    active: boolean
    activeVersionIndex: number
    topic: string
    batchTopic?: string
    mode?: string
    compressedTokens: number
    summaryTokens: number
    startId: string
    endId: string
    durationMs: number
    deactivatedByUser: boolean
    parentBlockIds: number[]
    includedBlockIds: number[]
    versions: string[]
}

export interface MessageEntry {
    rawId: string
    ref: string
    tokenCount: number
    activeBlockIds: number[]
}

export type DcpStats = {
    totalPruneTokens: number
    totalMessagesPruned: number
    totalToolsPruned: number
    compressionRatio: number
}

export type TuiCachedState = {
    blocks: BlockInfo[]
    trackedMessages: MessageEntry[]
    memo: string | null
    stats: DcpStats | null
}

export type TuiCacheSnapshot = {
    messages: readonly TuiMessageEntry[]
    state: TuiCachedState
}

export function createDcpStateReader(
    resolvePath: (sessionID: string) => string = getSessionFilePath,
): (sessionID: string) => Promise<TuiCachedState> {
    const cache = new Map<string, { stamp: FileStamp; state: TuiCachedState }>()

    return async (sessionID: string): Promise<TuiCachedState> => {
        const path = resolvePath(sessionID)
        const previous = cache.get(sessionID)

        let info
        try {
            info = await stat(path, { bigint: true })
        } catch (error) {
            if (isEnoent(error)) return previous?.state ?? emptyState()
            throw error
        }

        const stamp: FileStamp = { ino: info.ino, size: info.size, mtimeNs: info.mtimeNs }
        if (previous !== undefined && sameStamp(previous.stamp, stamp)) return previous.state

        let content: string
        try {
            content = await readFile(path, "utf-8")
        } catch (error) {
            if (isEnoent(error)) return previous?.state ?? emptyState()
            throw error
        }

        const root = JSON.parse(content)
        const state = projectCommittedState(root)
        cache.set(sessionID, { stamp, state })
        return state
    }
}

type FileStamp = {
    ino: bigint
    size: bigint
    mtimeNs: bigint
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
    return a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs
}

function isEnoent(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
    )
}

function emptyState(): TuiCachedState {
    return { blocks: [], trackedMessages: [], memo: null, stats: null }
}

function estimateTokens(text: string): number {
    return Math.round(text.length / 4)
}

function versionTextOf(versions: string[], idx: number): string {
    if (idx <= 0) return ""
    const text = versions[idx - 1]
    return typeof text === "string" ? text : ""
}

function versionTokens(versions: string[], idx: number): number {
    return estimateTokens(versionTextOf(versions, idx))
}

function projectCommittedState(root: any): TuiCachedState {
    return {
        blocks: projectBlocks(root),
        trackedMessages: projectMessages(root),
        memo: renderStoredMemo(root?.memo),
        stats: projectStats(root),
    }
}

function projectBlocks(root: any): BlockInfo[] {
    const blocks = root?.prune?.messages?.blocksById
    if (!blocks || typeof blocks !== "object") return []
    return Object.values(blocks).map((block: any) => {
        const activeVersionIndex = block.activeVersionIndex ?? 1
        const summaryVersions: string[] = Array.isArray(block.summaryVersions)
            ? block.summaryVersions
            : []
        const baseSummary = typeof block.summary === "string" ? block.summary : ""
        const versions: string[] = [baseSummary, ...summaryVersions]
        const info: BlockInfo = {
            blockId: block.blockId ?? 0,
            active: block.active ?? false,
            activeVersionIndex,
            topic: block.topic ?? "",
            compressedTokens: block.compressedTokens ?? 0,
            summaryTokens: versionTokens(versions, activeVersionIndex),
            startId: block.startId ?? "",
            endId: block.endId ?? "",
            durationMs: block.durationMs ?? 0,
            deactivatedByUser: block.deactivatedByUser ?? false,
            parentBlockIds: Array.isArray(block.parentBlockIds) ? block.parentBlockIds : [],
            includedBlockIds: Array.isArray(block.includedBlockIds) ? block.includedBlockIds : [],
            versions,
        }
        if (block.batchTopic !== undefined) info.batchTopic = block.batchTopic
        if (block.mode !== undefined) info.mode = block.mode
        return info
    })
}

function projectMessages(root: any): MessageEntry[] {
    // Build ref map from messageIds.byRawId (ALL messages known to DCP)
    const byRawId: Record<string, string> =
        root?.messageIds?.byRawId && typeof root.messageIds.byRawId === "object"
            ? root.messageIds.byRawId
            : {}

    // Build compression info from byMessageId (compressed messages only)
    const byMessageId: Record<string, any> =
        root?.prune?.messages?.byMessageId && typeof root.prune.messages.byMessageId === "object"
            ? root.prune.messages.byMessageId
            : {}

    // Collect all unique rawIds from both sources, preserving byRawId order (DCP ref order)
    const seen = new Set<string>()
    const allRawIds: string[] = []
    for (const rawId of Object.keys(byRawId)) {
        if (!seen.has(rawId)) {
            seen.add(rawId)
            allRawIds.push(rawId)
        }
    }
    // Also include compressed-only messages (edge case if byRawId is somehow missing them)
    for (const rawId of Object.keys(byMessageId)) {
        if (!seen.has(rawId)) {
            seen.add(rawId)
            allRawIds.push(rawId)
        }
    }

    return allRawIds.map((rawId) => {
        const entry = byMessageId[rawId]
        const ref = byRawId[rawId] ?? "?"
        return {
            rawId,
            ref,
            tokenCount: entry?.tokenCount ?? 0,
            activeBlockIds: Array.isArray(entry?.activeBlockIds) ? entry.activeBlockIds : [],
        }
    })
}

function projectStats(root: any): DcpStats | null {
    const stats = root?.stats
    if (!stats) return null
    return {
        totalPruneTokens: stats.totalPruneTokens ?? 0,
        totalMessagesPruned: stats.totalMessagesPruned ?? 0,
        totalToolsPruned: stats.totalToolsPruned ?? 0,
        compressionRatio: stats.compressionRatio ?? 0,
    }
}
