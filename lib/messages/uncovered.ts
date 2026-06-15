import type { SessionState, WithParts } from "../state"
import { isIgnoredUserMessage } from "../messages/query"
import { countAllMessageTokens } from "../token-utils"
import { formatTokenCount } from "../ui/utils"
import { assignMessageRefs } from "../message-ids"

export interface UncoveredRange {
    startId: string
    endId: string
    messageCount: number
    tokenEstimate: number
}

/**
 * Finds contiguous gaps in the message list that are not covered by any active compression block.
 * Skips covered messages and returns the uncovered ranges with reference IDs and token estimates.
 */
export function findUncoveredRanges(
    state: SessionState,
    messages: WithParts[],
): UncoveredRange[] {
    assignMessageRefs(state, messages)

    const coveredIds = new Set<string>()
    for (const [, block] of state.prune.messages.blocksById) {
        if (!block.active) continue
        for (const msgId of block.effectiveMessageIds) {
            coveredIds.add(msgId)
        }
    }

    const ranges: UncoveredRange[] = []
    let currentStart: WithParts | null = null
    let currentCount = 0
    let currentTokens = 0

    for (const msg of messages) {
        if (isIgnoredUserMessage(msg)) continue

        if (coveredIds.has(msg.info.id)) {
            // Covered message — flush any pending uncovered range
            if (currentStart) {
                ranges.push({
                    startId: state.messageIds.byRawId.get(currentStart.info.id) || currentStart.info.id,
                    endId: state.messageIds.byRawId.get(messages[messages.indexOf(msg) - 1]?.info.id || "") || "",
                    messageCount: currentCount,
                    tokenEstimate: currentTokens,
                })
                currentStart = null
                currentCount = 0
                currentTokens = 0
            }
            continue
        }

        if (!currentStart) {
            currentStart = msg
        }
        currentCount++
        currentTokens += countAllMessageTokens(msg)
    }

    // Flush trailing uncovered range
    if (currentStart && currentCount > 0) {
        const lastMsg = messages[messages.length - 1]
        ranges.push({
            startId: state.messageIds.byRawId.get(currentStart.info.id) || currentStart.info.id,
            endId: lastMsg ? (state.messageIds.byRawId.get(lastMsg.info.id) || lastMsg.info.id) : "",
            messageCount: currentCount,
            tokenEstimate: currentTokens,
        })
    }

    return ranges
}

export function formatUncoveredRanges(ranges: UncoveredRange[]): string {
    if (ranges.length === 0) return ""

    const lines: string[] = []
    lines.push("UNCOVERED MESSAGE RANGES (not in any active compression block):")

    for (const range of ranges) {
        const tokenStr = formatTokenCount(range.tokenEstimate)
        if (range.startId && range.endId) {
            lines.push(
                `- ${range.startId} → ${range.endId}: ${range.messageCount} messages, ${tokenStr} tokens`,
            )
        } else if (range.startId) {
            lines.push(`- ${range.startId}: ${range.messageCount} messages, ${tokenStr} tokens`)
        } else {
            lines.push(`- ${range.messageCount} messages, ${tokenStr} tokens`)
        }
    }

    return lines.join("\n")
}
