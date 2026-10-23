import { readFileSync } from "node:fs"
import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { saveSessionState } from "../state/persistence"
import { parseMemo, renderMemo } from "../memo"
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
        await sendIgnoredMessage(client, sessionId, "Usage: /dcp memo-file <path>", params, logger)
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

    const memo = parseMemo(content.trim())
    state.memo = memo.length > 0 ? memo : null

    await saveSessionState(state, logger)

    const rendered = state.memo ? renderMemo(state.memo) : ""
    await sendIgnoredMessage(
        client,
        sessionId,
        state.memo
            ? `Memo updated (${rendered.length} chars).`
            : "Edited memo is empty; memo cleared.",
        params,
        logger,
    )

    logger.info("Memo-file command completed", { length: rendered.length })
}
