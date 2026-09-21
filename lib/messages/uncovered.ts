import type { SessionState, WithParts } from "../state"
import type { CompressionBlock } from "../state/types"
import { isIgnoredUserMessage } from "../messages/query"
import { countAllMessageTokens } from "../token-utils"
import { assignMessageRefs } from "../message-ids"
import { formatTokenCount } from "../ui/utils"
import { onChainCoverage } from "./coverage"

function refToNumber(ref: string): number {
    const m = ref.match(/^m(\d+)$/)
    return m ? parseInt(m[1], 10) : 0
}

function findAdjacentBlocks(
    blocksById: Map<number, CompressionBlock>,
    rangeStart: string,
    rangeEnd: string,
): { preceding: CompressionBlock | null; following: CompressionBlock | null } {
    let preceding: CompressionBlock | null = null  // latest (largest endId < rangeStart)
    let following: CompressionBlock | null = null  // earliest (smallest startId > rangeEnd)
    const rangeStartNum = refToNumber(rangeStart)
    const rangeEndNum = refToNumber(rangeEnd)

    for (const [, block] of blocksById) {
        const blockEndNum = refToNumber(block.endId)
        const blockStartNum = refToNumber(block.startId)

        if (blockEndNum < rangeStartNum) {
            if (!preceding || refToNumber(preceding.endId) < blockEndNum) {
                preceding = block
            }
        }

        if (blockStartNum > rangeEndNum) {
            if (!following || refToNumber(following.startId) > blockStartNum) {
                following = block
            }
        }
    }

    return { preceding, following }
}

export interface UncoveredRange {
    startId: string
    endId: string
    messageCount: number
    tokenEstimate: number
}

/**
 * Finds contiguous gaps in the message list that are not covered by any active compression block.
 * Skips covered messages and returns the uncovered ranges with reference IDs and token estimates.
 * Blocks are filtered to on-chain coverage, so blocks from inactive branches do not count as covering.
 */
export function findUncoveredRanges(
    state: SessionState,
    activeMessages: WithParts[],
): UncoveredRange[] {
    assignMessageRefs(state, activeMessages)

    const activeSet = new Set<string>()
    for (const message of activeMessages) {
        if (isIgnoredUserMessage(message)) continue
        activeSet.add(message.info.id)
    }

    const coveredIds = new Set<string>()
    for (const [, block] of state.prune.messages.blocksById) {
        if (!block.active) continue
        const ids = onChainCoverage(block, activeSet)
        if (ids === null) continue
        for (const id of ids) {
            coveredIds.add(id)
        }
    }

    const ranges: UncoveredRange[] = []
    let currentStart: WithParts | null = null
    let currentEnd: WithParts | null = null
    let currentCount = 0
    let currentTokens = 0

    function flushRange() {
        if (!currentStart) return
        const startRef = state.messageIds.byRawId.get(currentStart.info.id) ?? currentStart.info.id
        const endRef = currentEnd
            ? (state.messageIds.byRawId.get(currentEnd.info.id) ?? currentEnd.info.id)
            : startRef
        ranges.push({
            startId: startRef,
            endId: endRef,
            messageCount: currentCount,
            tokenEstimate: currentTokens,
        })
        currentStart = null
        currentEnd = null
        currentCount = 0
        currentTokens = 0
    }

    for (const message of activeMessages) {
        if (isIgnoredUserMessage(message)) continue

        if (coveredIds.has(message.info.id)) {
            flushRange()
            continue
        }

        if (!currentStart) {
            currentStart = message
        }
        currentEnd = message
        currentCount++
        currentTokens += countAllMessageTokens(message)
    }

    // Flush trailing uncovered range
    flushRange()

    return ranges
}

export function formatUncoveredRanges(
    ranges: UncoveredRange[],
    blocksById: Map<number, CompressionBlock>,
): string {
    if (ranges.length === 0) return ""

    const lines: string[] = []
    lines.push("UNCOVERED MESSAGE RANGES (not in any active compression block):")

    for (const range of ranges) {
        const tokenStr = formatTokenCount(range.tokenEstimate, true /* compact — formatTokenCount already appends "tokens" in non-compact mode */)
        const { preceding, following } = findAdjacentBlocks(
            blocksById,
            range.startId,
            range.endId,
        )

        const parts: string[] = []
        if (range.startId && range.endId) {
            parts.push(
                `${range.startId} → ${range.endId}: ${range.messageCount} messages, ${tokenStr} tokens`,
            )
        } else if (range.startId) {
            parts.push(`${range.startId}: ${range.messageCount} messages, ${tokenStr} tokens`)
        } else {
            parts.push(`${range.messageCount} messages, ${tokenStr} tokens`)
        }

        const adj: string[] = []
        if (preceding) {
            adj.push(`preceding: b${preceding.blockId} ${preceding.topic}`)
        }
        if (following) {
            adj.push(`following: b${following.blockId} ${following.topic}`)
        }
        if (adj.length > 0) {
            parts.push(`(${adj.join(", ")})`)
        }

        lines.push(`- ${parts.join(" ")}`)
    }

    return lines.join("\n")
}
