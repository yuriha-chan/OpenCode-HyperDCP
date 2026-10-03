import { readFileSync } from "node:fs"
import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { saveSessionState } from "../state/persistence"
import { sendIgnoredMessage } from "../ui/notification"
import { getCurrentParams } from "../token-utils"
import { parseBlockIdArg } from "./edit"

export interface EditFileCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

export async function handleEditFileCommand(ctx: EditFileCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages, args } = ctx

    const params = getCurrentParams(state, messages, logger)

    const targetArg = args[0]
    const filePath = args[1]

    if (!targetArg || !filePath) {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Usage: /dcp edit-file <n> <path>",
            params,
            logger,
        )
        return
    }

    const targetBlockId = parseBlockIdArg(targetArg)
    if (targetBlockId === null) {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Please enter a compression number. Example: /dcp edit-file 2 /tmp/summary.txt",
            params,
            logger,
        )
        return
    }

    const block = state.prune.messages.blocksById.get(targetBlockId)
    if (!block) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Compression ${targetBlockId} does not exist.`,
            params,
            logger,
        )
        return
    }

    let content: string
    try {
        content = readFileSync(filePath, "utf-8")
    } catch {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Could not read file: ${filePath}`,
            params,
            logger,
        )
        return
    }

    const trimmed = content.trim()
    if (!trimmed) {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Edited summary is empty; nothing applied.",
            params,
            logger,
        )
        return
    }

    if (!Array.isArray(block.summaryVersions)) {
        block.summaryVersions = []
    }

    block.summaryVersions.push(trimmed)
    block.activeVersionIndex = block.summaryVersions.length + 1

    await saveSessionState(state, logger)

    await sendIgnoredMessage(
        client,
        sessionId,
        `Updated compression ${targetBlockId} summary (v${block.activeVersionIndex} now active).`,
        params,
        logger,
    )

    logger.info("Edit-file command completed", {
        targetBlockId,
        versionIndex: block.activeVersionIndex,
    })
}
