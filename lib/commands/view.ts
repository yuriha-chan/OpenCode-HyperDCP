import type { Logger } from "../logger"
import type { CompressionBlock, SessionState, WithParts } from "../state"
import { syncCompressionBlocks } from "../messages"
import { parseBlockRef } from "../message-ids"
import { getCurrentParams } from "../token-utils"
import { sendIgnoredMessage } from "../ui/notification"
import { formatTokenCount } from "../ui/utils"
import {
    getActiveCompressionTargets,
    resolveCompressionTarget,
    type CompressionTarget,
} from "./compression-targets"

export interface ViewCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

function parseBlockIdArg(arg: string): number | null {
    const normalized = arg.trim().toLowerCase()
    const blockRef = parseBlockRef(normalized)
    if (blockRef !== null) {
        return blockRef
    }

    if (!/^[1-9]\d*$/.test(normalized)) {
        return null
    }

    const parsed = Number.parseInt(normalized, 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function statusLabel(block: CompressionBlock): string {
    if (block.active) return "active"
    if (block.deactivatedByUser) return "decompressed by user"
    return "inactive"
}

function formatBlockDetail(block: CompressionBlock, index?: number): string {
    const lines: string[] = []
    const header = index !== undefined ? `Block #${block.blockId} (${index + 1})` : `Block #${block.blockId}`

    lines.push(header)
    lines.push(`  Mode:      ${block.mode}`)
    lines.push(`  Status:    ${statusLabel(block)}`)
    lines.push(`  Topic:     ${block.topic}`)
    if (block.batchTopic) {
        lines.push(`  Batch:     ${block.batchTopic}`)
    }
    lines.push(`  Tokens:    ${formatTokenCount(block.compressedTokens)} compressed, ${formatTokenCount(block.summaryTokens)} summary`)
    lines.push(`  Duration:  ${block.durationMs}ms`)
    if (block.parentBlockIds.length > 0) {
        const parentLabels = block.parentBlockIds.map((id) => String(id)).join(", ")
        lines.push(`  Parents:   ${parentLabels}`)
    }
    if (block.includedBlockIds.length > 0) {
        const includedLabels = block.includedBlockIds.map((id) => String(id)).join(", ")
        lines.push(`  Includes:  ${includedLabels}`)
    }
    lines.push(`  Summary:`)
    lines.push(block.summary)
    return lines.join("\n")
}

function formatSingleTargetView(target: CompressionTarget): string {
    const lines: string[] = []

    lines.push(`Compression #${target.runId}`)
    lines.push("")

    if (target.grouped && target.blocks.length > 1) {
        lines.push(`${target.blocks.length} blocks in this compression group.`)
        lines.push("")
        target.blocks.forEach((block, index) => {
            lines.push(formatBlockDetail(block, index))
            if (index < target.blocks.length - 1) {
                lines.push("")
            }
        })
    } else {
        const block = target.blocks[0]
        if (block) {
            lines.push(formatBlockDetail(block))
        }
    }

    return lines.join("\n")
}

function formatListView(targets: CompressionTarget[]): string {
    const lines: string[] = []

    lines.push("Usage: /dcp view <n>")
    lines.push("")

    if (targets.length === 0) {
        lines.push("No active compressions to view.")
        return lines.join("\n")
    }

    lines.push("Available compressions:")
    lines.push("")

    for (const target of targets) {
        const block = target.blocks[0]
        if (!block) continue

        const status = statusLabel(block)
        const tokenLabel = formatTokenCount(target.compressedTokens)
        lines.push(`  ${target.displayId} (${tokenLabel})  ${block.mode}  ${status}  ${target.topic}`)
        lines.push(block.summary)
        lines.push("")
    }

    return lines.join("\n")
}

export async function handleViewCommand(ctx: ViewCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages, args } = ctx

    const params = getCurrentParams(state, messages, logger)
    const targetArg = args[0]

    if (args.length > 1) {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Invalid arguments. Usage: /dcp view <n>",
            params,
            logger,
        )
        return
    }

    syncCompressionBlocks(state, logger, messages)
    const messagesState = state.prune.messages

    if (!targetArg) {
        const availableTargets = getActiveCompressionTargets(messagesState)
        const message = formatListView(availableTargets)
        await sendIgnoredMessage(client, sessionId, message, params, logger)
        return
    }

    const targetBlockId = parseBlockIdArg(targetArg)
    if (targetBlockId === null) {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Please enter a compression number. Example: /dcp view 2",
            params,
            logger,
        )
        return
    }

    const target = resolveCompressionTarget(messagesState, targetBlockId)
    if (!target) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Compression ${targetBlockId} does not exist.`,
            params,
            logger,
        )
        return
    }

    const message = formatSingleTargetView(target)
    await sendIgnoredMessage(client, sessionId, message, params, logger)
}
