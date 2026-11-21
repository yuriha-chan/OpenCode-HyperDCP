import type { SessionState } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { replaceBlockIdsWithBlocked } from "./utils"
import { summaryDocument, wrapCompressedSummary } from "../summary-text"

export function contextBlockSummary(
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    anchorMessageId: string,
) {
    const blockId = state.prune.messages.activeByAnchorMessageId.get(anchorMessageId)
    const summary = blockId !== undefined ? state.prune.messages.blocksById.get(blockId) : undefined
    if (!summary) return
    const versionIndex =
        typeof summary.activeVersionIndex === "number" ? summary.activeVersionIndex : 1
    let rawSummaryContent: string
    if (versionIndex === 0) {
        rawSummaryContent = "" // disabled
    } else if (
        versionIndex >= 2 &&
        Array.isArray(summary.summaryVersions) &&
        versionIndex - 2 < summary.summaryVersions.length
    ) {
        rawSummaryContent = summary.summaryVersions[versionIndex - 2]
    } else {
        rawSummaryContent = (summary as { summary?: string }).summary ?? ""
    }
    if (
        summary.active !== true ||
        typeof rawSummaryContent !== "string" ||
        rawSummaryContent.length === 0
    ) {
        logger.warn("Skipping malformed compress summary", {
            anchorMessageId,
            blockId: (summary as { blockId?: unknown }).blockId,
        })
        return
    }
    const document = summaryDocument(rawSummaryContent)
    const range =
        summary.mode === "message" ? summary.startId : `${summary.startId}-${summary.endId}`
    const content = wrapCompressedSummary(summary.blockId, document, range)
    return {
        block: summary,
        content: config.compress.mode === "message" ? replaceBlockIdsWithBlocked(content) : content,
    }
}
