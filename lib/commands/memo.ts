import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { parseMemo, renderMemo } from "../memo"
import { getCurrentParams } from "../token-utils"
import type { CommandSendMessage } from "./output"

export interface MemoCommandContext {
    sendMessage: CommandSendMessage
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

export async function handleMemoCommand(ctx: MemoCommandContext, args: string[]): Promise<void> {
    const { sendMessage, state, logger, sessionId, messages } = ctx
    const subcommand = args[0]?.toLowerCase() || "show"

    if (subcommand === "clear") {
        state.memo = null
        const params = getCurrentParams(state, messages, logger)
        await sendMessage("Memo cleared.", params)
        return
    }

    if (subcommand === "set") {
        const content = args.slice(1).join(" ").trim()
        const memo = parseMemo(content)
        state.memo = memo.length > 0 ? memo : null
        const params = getCurrentParams(state, messages, logger)
        const msg = state.memo
            ? `Memo set (${renderMemo(state.memo).length} chars). Use /dcp memo show to view.`
            : "Memo cleared."
        await sendMessage(msg, params)
        return
    }

    // Default: show
    const params = getCurrentParams(state, messages, logger)
    if (!state.memo) {
        await sendMessage("Memo is empty. Use /dcp memo set <text> to set it.", params)
        return
    }
    await sendMessage(`[Memo]\n${renderMemo(state.memo)}`, params)
}
