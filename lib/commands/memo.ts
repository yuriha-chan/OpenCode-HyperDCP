import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { sendIgnoredMessage } from "../ui/notification"
import { getCurrentParams } from "../token-utils"

export interface MemoCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

export async function handleMemoCommand(ctx: MemoCommandContext, args: string[]): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx
    const subcommand = args[0]?.toLowerCase() || "show"

    if (subcommand === "clear") {
        state.memo = null
        const params = getCurrentParams(state, messages, logger)
        await sendIgnoredMessage(client, sessionId, "Memo cleared.", params, logger)
        return
    }

    if (subcommand === "set") {
        const content = args.slice(1).join(" ").trim()
        state.memo = content.length > 0 ? content : null
        const params = getCurrentParams(state, messages, logger)
        const msg = state.memo
            ? `Memo set (${state.memo.length} chars). Use /dcp memo show to view.`
            : "Memo cleared."
        await sendIgnoredMessage(client, sessionId, msg, params, logger)
        return
    }

    // Default: show
    const params = getCurrentParams(state, messages, logger)
    if (!state.memo) {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Memo is empty. Use /dcp memo set <text> to set it.",
            params,
            logger,
        )
        return
    }
    await sendIgnoredMessage(client, sessionId, `[Memo]\n${state.memo}`, params, logger)
}
