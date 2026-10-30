import type { CompressionBlock, SessionState } from "../state/types"

export interface PendingCompressionDuration {
    messageId: string
    callId: string
    durationMs: number
}

export interface CompressionTimingState {
    startsByCallId: Map<string, number>
    pendingByCallId: Map<string, PendingCompressionDuration>
}

export function buildCompressionTimingKey(messageId: string, callId: string): string {
    return `${messageId}:${callId}`
}

export function consumeCompressionStart(
    state: SessionState,
    messageId: string,
    callId: string,
): number | undefined {
    const key = buildCompressionTimingKey(messageId, callId)
    const start = state.compressionTiming.startsByCallId.get(key)
    state.compressionTiming.startsByCallId.delete(key)
    return start
}

export function resolveCompressionDuration(
    startedAt: number | undefined,
    eventTime: number | undefined,
    partTime: { start?: unknown; end?: unknown } | undefined,
): number | undefined {
    const runningAt =
        typeof partTime?.start === "number" && Number.isFinite(partTime.start)
            ? partTime.start
            : eventTime
    const pendingToRunningMs =
        typeof startedAt === "number" && typeof runningAt === "number"
            ? Math.max(0, runningAt - startedAt)
            : undefined

    const toolStart = partTime?.start
    const toolEnd = partTime?.end
    const runtimeMs =
        typeof toolStart === "number" &&
        Number.isFinite(toolStart) &&
        typeof toolEnd === "number" &&
        Number.isFinite(toolEnd)
            ? Math.max(0, toolEnd - toolStart)
            : undefined

    return typeof pendingToRunningMs === "number" ? pendingToRunningMs : runtimeMs
}

export function applyPendingCompressionDurations(state: SessionState): number {
    const pendingByCallId = state.compressionTiming.pendingByCallId
    if (pendingByCallId.size === 0) {
        return 0
    }

    const blocksByPair = new Map<string, Map<string | undefined, CompressionBlock[]>>()
    for (const block of state.prune.messages.blocksById.values()) {
        let blocksByCallId = blocksByPair.get(block.compressMessageId)
        if (!blocksByCallId) {
            blocksByCallId = new Map()
            blocksByPair.set(block.compressMessageId, blocksByCallId)
        }

        const callId = block.compressCallId
        const matches = blocksByCallId.get(callId)
        if (matches) {
            matches.push(block)
        } else {
            blocksByCallId.set(callId, [block])
        }
    }

    let updates = 0
    for (const [key, entry] of pendingByCallId) {
        if (typeof entry.durationMs !== "number" || !Number.isFinite(entry.durationMs)) {
            continue
        }

        const matches = blocksByPair.get(entry.messageId)?.get(entry.callId)
        if (!matches) {
            continue
        }

        for (const block of matches) {
            block.durationMs = entry.durationMs
            updates++
        }
        pendingByCallId.delete(key)
    }

    return updates
}
