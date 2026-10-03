import { readFileSync } from "node:fs"
import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { saveSessionState } from "../state/persistence"
import { sendIgnoredMessage } from "../ui/notification"
import { getCurrentParams } from "../token-utils"

export interface MemoFileCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

export async function handleMemoFileCommand(ctx: MemoFileCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages, args } = ctx

    const params = getCurrentParams(state, messages, logger)

    const filePath = args[0]

    if (!filePath) {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Usage: /dcp memo-file <path>",
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
            "Edited memo is empty; nothing applied.",
            params,
            logger,
        )
        return
    }

    state.memo = trimmed

    await saveSessionState(state, logger)

    await sendIgnoredMessage(
        client,
        sessionId,
        `Memo updated (${state.memo.length} chars).`,
        params,
        logger,
    )

    logger.info("Memo-file command completed", { length: state.memo.length })
}
