import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { syncCompressionBlocks } from "../messages"
import { parseBlockRef } from "../message-ids"
import { getCurrentParams } from "../token-utils"
import { saveSessionState } from "../state/persistence"
import { formatTokenCount } from "../ui/utils"
import { getActiveCompressionTargets, resolveCompressionTarget } from "./compression-targets"
import type { CommandSendMessage } from "./output"
import { summaryDocument } from "../summary-text"

export interface EditCommandContext {
    sendMessage: CommandSendMessage
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

export function parseBlockIdArg(arg: string): number | null {
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

function formatEditableList(targets: ReturnType<typeof getActiveCompressionTargets>): string {
    const lines: string[] = []

    lines.push("Usage: /dcp edit <n> <new summary text>")
    lines.push("       /dcp edit <n> -a <text to append>")
    lines.push("")

    if (targets.length === 0) {
        lines.push("No compressions available to edit.")
        return lines.join("\n")
    }

    lines.push("Available compressions:")
    const entries = targets.map((target) => {
        const topic = target.topic.replace(/\s+/g, " ").trim() || "(no topic)"
        const label = `${target.displayId} (${formatTokenCount(target.compressedTokens)})`
        const details = target.grouped
            ? `Compression #${target.runId} - ${target.blocks.length} blocks`
            : `Compression #${target.runId}`
        return { label, topic: `${details} - ${topic}` }
    })

    const labelWidth = Math.max(...entries.map((entry) => entry.label.length)) + 4
    for (const entry of entries) {
        lines.push(`  ${entry.label.padEnd(labelWidth)}${entry.topic}`)
    }

    return lines.join("\n")
}

export async function handleEditCommand(ctx: EditCommandContext): Promise<void> {
    const { sendMessage, state, logger, sessionId, messages, args } = ctx

    const params = getCurrentParams(state, messages, logger)
    const targetArg = args[0]

    syncCompressionBlocks(state, logger, messages)
    const messagesState = state.prune.messages

    if (!targetArg) {
        const availableTargets = getActiveCompressionTargets(messagesState)
        const message = formatEditableList(availableTargets)
        await sendMessage(message, params)
        return
    }

    const targetBlockId = parseBlockIdArg(targetArg)
    if (targetBlockId === null) {
        await sendMessage(
            "Please enter a compression number. Example: /dcp edit 2 Fixed summary here.",
            params,
        )
        return
    }

    const target = resolveCompressionTarget(messagesState, targetBlockId)
    if (!target) {
        await sendMessage(`Compression ${targetBlockId} does not exist.`, params)
        return
    }

    const textArgs = args.slice(1)
    if (textArgs.length === 0) {
        await sendMessage(
            "Please provide replacement text or use -a to append. Example: /dcp edit 2 Fixed summary here.",
            params,
        )
        return
    }

    const isAppend = textArgs[0] === "-a"
    const content = isAppend ? textArgs.slice(1) : textArgs

    if (content.length === 0) {
        await sendMessage(
            isAppend
                ? "Please provide text to append. Example: /dcp edit 2 -a Additional detail."
                : "Please provide replacement text. Example: /dcp edit 2 Fixed summary here.",
            params,
        )
        return
    }

    const newText = content.join(" ")

    for (const block of target.blocks) {
        if (isAppend) {
            block.summary = summaryDocument(block.summary) + "\n\n" + summaryDocument(newText)
        } else {
            block.summary = summaryDocument(newText)
        }
    }

    await saveSessionState(state, logger)

    const verb = isAppend ? "Appended to" : "Updated"
    await sendMessage(`${verb} compression ${target.displayId} summary.`, params)

    logger.info("Edit command completed", {
        targetBlockId: target.displayId,
        targetRunId: target.runId,
        isAppend,
        blockCount: target.blocks.length,
    })
}
