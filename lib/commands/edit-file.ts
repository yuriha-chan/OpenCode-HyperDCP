import { readFileSync } from "node:fs"
import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { saveSessionState } from "../state/persistence"
import { getCurrentParams } from "../token-utils"
import { parseBlockIdArg } from "./edit"
import type { CommandSendMessage } from "./output"
import { summaryDocument } from "../summary-text"

export interface EditFileCommandContext {
    sendMessage: CommandSendMessage
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

export async function handleEditFileCommand(ctx: EditFileCommandContext): Promise<void> {
    const { sendMessage, state, logger, sessionId, messages, args } = ctx

    const params = getCurrentParams(state, messages, logger)

    const targetArg = args[0]
    const filePath = args[1]

    if (!targetArg || !filePath) {
        await sendMessage("Usage: /dcp edit-file <n> <path>", params)
        return
    }

    const targetBlockId = parseBlockIdArg(targetArg)
    if (targetBlockId === null) {
        await sendMessage(
            "Please enter a compression number. Example: /dcp edit-file 2 /tmp/summary.txt",
            params,
        )
        return
    }

    const block = state.prune.messages.blocksById.get(targetBlockId)
    if (!block) {
        await sendMessage(`Compression ${targetBlockId} does not exist.`, params)
        return
    }

    let content: string
    try {
        content = readFileSync(filePath, "utf-8")
    } catch {
        await sendMessage(`Could not read file: ${filePath}`, params)
        return
    }

    const trimmed = summaryDocument(content).trim()
    if (!trimmed) {
        await sendMessage("Edited summary is empty; nothing applied.", params)
        return
    }

    if (!Array.isArray(block.summaryVersions)) {
        block.summaryVersions = []
    }

    block.summaryVersions.push(trimmed)
    block.activeVersionIndex = block.summaryVersions.length + 1

    await saveSessionState(state, logger)

    await sendMessage(
        `Updated compression ${targetBlockId} summary (v${block.activeVersionIndex} now active).`,
        params,
    )

    logger.info("Edit-file command completed", {
        targetBlockId,
        versionIndex: block.activeVersionIndex,
    })
}
