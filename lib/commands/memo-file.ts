import { readFileSync } from "node:fs"
import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { saveSessionState } from "../state/persistence"
import { parseMemo, renderMemo } from "../memo"
import { getCurrentParams } from "../token-utils"
import type { CommandSendMessage } from "./output"

export interface MemoFileCommandContext {
    sendMessage: CommandSendMessage
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

export async function handleMemoFileCommand(ctx: MemoFileCommandContext): Promise<void> {
    const { sendMessage, state, logger, sessionId, messages, args } = ctx

    const params = getCurrentParams(state, messages, logger)

    const filePath = args[0]

    if (!filePath) {
        await sendMessage("Usage: /dcp memo-file <path>", params)
        return
    }

    let content: string
    try {
        content = readFileSync(filePath, "utf-8")
    } catch {
        await sendMessage(`Could not read file: ${filePath}`, params)
        return
    }

    const memo = parseMemo(content.trim())
    state.memo = memo.length > 0 ? memo : null

    await saveSessionState(state, logger)

    const rendered = state.memo ? renderMemo(state.memo) : ""
    await sendMessage(
        state.memo
            ? `Memo updated (${rendered.length} chars).`
            : "Edited memo is empty; memo cleared.",
        params,
    )

    logger.info("Memo-file command completed", { length: rendered.length })
}
