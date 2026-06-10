import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { syncCompressionBlocks } from "../messages"
import { parseBlockRef } from "../message-ids"
import { getCurrentParams } from "../token-utils"
import { saveSessionState } from "../state/persistence"
import { sendIgnoredMessage } from "../ui/notification"
import { formatTokenCount } from "../ui/utils"
import {
    getActiveCompressionTargets,
    resolveCompressionTarget,
} from "./compression-targets"

export interface EditCommandContext {
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
    const { client, state, logger, sessionId, messages, args } = ctx

    const params = getCurrentParams(state, messages, logger)
    const targetArg = args[0]

    syncCompressionBlocks(state, logger, messages)
    const messagesState = state.prune.messages

    if (!targetArg) {
        const availableTargets = getActiveCompressionTargets(messagesState)
        const message = formatEditableList(availableTargets)
        await sendIgnoredMessage(client, sessionId, message, params, logger)
        return
    }

    const targetBlockId = parseBlockIdArg(targetArg)
    if (targetBlockId === null) {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Please enter a compression number. Example: /dcp edit 2 Fixed summary here.",
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

    const textArgs = args.slice(1)
    if (textArgs.length === 0) {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Please provide replacement text or use -a to append. Example: /dcp edit 2 Fixed summary here.",
            params,
            logger,
        )
        return
    }

    const isAppend = textArgs[0] === "-a"
    const content = isAppend ? textArgs.slice(1) : textArgs

    if (content.length === 0) {
        await sendIgnoredMessage(
            client,
            sessionId,
            isAppend
                ? "Please provide text to append. Example: /dcp edit 2 -a Additional detail."
                : "Please provide replacement text. Example: /dcp edit 2 Fixed summary here.",
            params,
            logger,
        )
        return
    }

    const newText = content.join(" ")

    for (const block of target.blocks) {
        if (isAppend) {
            block.summary = block.summary + "\n\n" + newText
        } else {
            block.summary = newText
        }
    }

    await saveSessionState(state, logger)

    const verb = isAppend ? "Appended to" : "Updated"
    await sendIgnoredMessage(
        client,
        sessionId,
        `${verb} compression ${target.displayId} summary.`,
        params,
        logger,
    )

    logger.info("Edit command completed", {
        targetBlockId: target.displayId,
        targetRunId: target.runId,
        isAppend,
        blockCount: target.blocks.length,
    })
}
