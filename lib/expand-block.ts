import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./compress/types"
import type { SessionState } from "./state"
import { formatMessageRef, parseBoundaryId } from "./message-ids"
import { runHousekeepingMutation } from "./housekeeping/state"

function activeSummaryText(block: {
    summary: string
    summaryVersions: string[]
    activeVersionIndex: number
    pendingEditBuffer?: string
}): string {
    if (block.pendingEditBuffer !== undefined) return block.pendingEditBuffer
    const idx = block.activeVersionIndex
    if (idx === 0) return ""
    if (idx >= 2 && idx - 2 < block.summaryVersions.length) return block.summaryVersions[idx - 2]
    return block.summary
        .replace(/^\[Compressed conversation section\]\s*/, "")
        .replace(/\s*<dcp-message-id[^>]*>b\d+<\/dcp-message-id>\s*$/, "")
        .trim()
}

export function materializePendingSummary(block: {
    summaryVersions: string[]
    activeVersionIndex: number
    pendingEditBuffer?: string
    pendingExpandedMessageIds?: string[]
    effectiveMessageIds: string[]
}): void {
    if (block.pendingEditBuffer !== undefined) {
        const summary = block.pendingEditBuffer.trim()
        if (!summary) throw new Error("Summary buffer is empty after trimming.")
        block.summaryVersions.push(summary)
        block.activeVersionIndex = block.summaryVersions.length + 1
    }
    for (const messageId of block.pendingExpandedMessageIds ?? []) {
        if (!block.effectiveMessageIds.includes(messageId))
            block.effectiveMessageIds.push(messageId)
    }
    block.pendingExpandedMessageIds = undefined
    block.pendingEditBuffer = undefined
}

export function createExpandBlockTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: `Extend a compressed block's message range to include newer messages.

Use this tool when you want to widen an existing block's coverage without rewriting its summary. Later, use edit_summary or append_summary to update the text.

THE FORMAT
{
  blockId: number,
  endId: string   // message ref (e.g. "m0100") for the new end boundary
}`,
        args: {
            blockId: tool.schema.number().describe("Block ID to expand (e.g. 1)"),
            endId: tool.schema.string().describe("Message ref for new end boundary (e.g. 'm0100')"),
        },
        async execute(args, toolCtx) {
            return runHousekeepingMutation(
                ctx,
                toolCtx,
                "expand_block",
                args,
                async (operationCtx) => {
                    const input = args as { blockId: number; endId: string }
                    const block = operationCtx.state.prune.messages.blocksById.get(input.blockId)
                    if (!block) throw new Error(`Block ${input.blockId} not found.`)

                    const parsed = parseBoundaryId(input.endId)
                    if (!parsed || parsed.kind !== "message") {
                        throw new Error(
                            `Invalid boundary reference: ${input.endId}. Use message refs like m0100.`,
                        )
                    }

                    const rawId = operationCtx.state.messageIds.byRef.get(parsed.ref)
                    if (!rawId)
                        throw new Error(`Message ${parsed.ref} not found in current context.`)
                    const eligibleSourceIds = new Set(
                        operationCtx.state.housekeeping?.sourceParts.map(
                            (part) => part.messageId,
                        ) ?? [],
                    )
                    if (!eligibleSourceIds.has(rawId)) {
                        throw new Error(
                            `Message ${parsed.ref} is not eligible in this housekeeping transaction.`,
                        )
                    }

                    const previousParsed =
                        typeof block.endId === "string" ? parseBoundaryId(block.endId) : null
                    const lowerBound =
                        previousParsed && previousParsed.kind === "message"
                            ? previousParsed.index
                            : parsed.index
                    const coveredRawIds: string[] = []
                    for (let index = lowerBound; index <= parsed.index; index++) {
                        const messageId = operationCtx.state.messageIds.byRef.get(
                            formatMessageRef(index),
                        )
                        if (
                            messageId &&
                            eligibleSourceIds.has(messageId) &&
                            !coveredRawIds.includes(messageId)
                        ) {
                            coveredRawIds.push(messageId)
                        }
                    }
                    if (!coveredRawIds.includes(rawId)) {
                        coveredRawIds.push(rawId)
                    }

                    const newlyCoveredRawIds = coveredRawIds.filter(
                        (messageId) => !block.effectiveMessageIds.includes(messageId),
                    )

                    // Check overlap with other active blocks
                    for (const [id, other] of operationCtx.state.prune.messages.blocksById) {
                        if (id === input.blockId || !other.active) continue
                        for (const msgId of newlyCoveredRawIds) {
                            if (other.effectiveMessageIds.includes(msgId)) {
                                throw new Error(
                                    `Expanded range ${block.startId} → ${input.endId} overlaps with active block ${id}. ` +
                                        `Expand block ${id} instead, or decompress it first.`,
                                )
                            }
                        }
                    }

                    block.endId = parsed.ref
                    if (!block.pendingExpandedMessageIds) block.pendingExpandedMessageIds = []
                    for (const messageId of newlyCoveredRawIds) {
                        if (!block.effectiveMessageIds.includes(messageId)) {
                            block.effectiveMessageIds.push(messageId)
                        }
                        if (!block.pendingExpandedMessageIds.includes(messageId)) {
                            block.pendingExpandedMessageIds.push(messageId)
                        }
                    }

                    return `Expanded block ${input.blockId} range to ${parsed.ref}. Use edit_summary or append_summary to update its summary. Complete all intended compression and edits across every affected block before calling leave_housekeeping once for the whole maintenance pass.`
                },
            )
        },
    })
}

export function createEditSummaryTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: `Replace text in a block's summary editing buffer.

If no buffer is active, the current summary version is loaded as the starting buffer. Keep editing this and other affected blocks until the whole maintenance pass is complete; only then call leave_housekeeping to publish all accumulated changes together.
Keep oldString short (typically 2-3 lines). Match only the surgical fragment to replace.

THE FORMAT
{
  blockId: number,
  oldString: string,        // Text to find and replace
  newString: string,        // Replacement text (must differ from old)
  replaceAll?: boolean      // Replace all occurrences (default: first only)
}`,
        args: {
            blockId: tool.schema.number().describe("Block ID to edit (e.g. 1)"),
            oldString: tool.schema
                .string()
                .describe("Text to find and replace (typically 2-3 lines)"),
            newString: tool.schema.string().describe("Replacement text"),
            replaceAll: tool.schema.boolean().describe("Replace all occurrences (default false)"),
        },
        async execute(args, toolCtx) {
            return runHousekeepingMutation(
                ctx,
                toolCtx,
                "edit_summary",
                args,
                async (operationCtx) => {
                    const input = args as {
                        blockId: number
                        oldString: string
                        newString: string
                        replaceAll?: boolean
                    }
                    const block = operationCtx.state.prune.messages.blocksById.get(input.blockId)
                    if (!block) throw new Error(`Block ${input.blockId} not found.`)

                    const current = activeSummaryText(block)
                    if (input.oldString === input.newString) {
                        throw new Error("oldString and newString must differ")
                    }

                    let replaced: string
                    if (input.replaceAll) {
                        if (!current.includes(input.oldString)) {
                            throw new Error(`Old string not found in buffer.`)
                        }
                        replaced = current.split(input.oldString).join(input.newString)
                    } else {
                        const idx = current.indexOf(input.oldString)
                        if (idx === -1) throw new Error(`Old string not found in buffer.`)
                        replaced =
                            current.slice(0, idx) +
                            input.newString +
                            current.slice(idx + input.oldString.length)
                    }

                    block.pendingEditBuffer = replaced

                    return `Edited summary for block ${input.blockId}. Buffer updated and staged. Complete all remaining compression and summary edits across affected blocks before calling leave_housekeeping once for the whole maintenance pass.`
                },
            )
        },
    })
}

export function createAppendSummaryTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: `Append text to a block's summary editing buffer.

THE FORMAT
{
  blockId: number,
  text: string   // Text to append to the current buffer
}`,
        args: {
            blockId: tool.schema.number().describe("Block ID (e.g. 1)"),
            text: tool.schema.string().describe("Text to append"),
        },
        async execute(args, toolCtx) {
            return runHousekeepingMutation(
                ctx,
                toolCtx,
                "append_summary",
                args,
                async (operationCtx) => {
                    const input = args as { blockId: number; text: string }
                    const block = operationCtx.state.prune.messages.blocksById.get(input.blockId)
                    if (!block) throw new Error(`Block ${input.blockId} not found.`)

                    const current = activeSummaryText(block)
                    block.pendingEditBuffer = current + input.text

                    return `Appended to summary for block ${input.blockId}; changes are staged. Complete all remaining compression and summary edits across affected blocks before calling leave_housekeeping once for the whole maintenance pass.`
                },
            )
        },
    })
}

export function finalizePendingBuffers(state: Pick<SessionState, "prune">): void {
    for (const block of state.prune.messages.blocksById.values()) materializePendingSummary(block)
}
