import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { getCurrentParams } from "../token-utils"
import { saveSessionState } from "../state/persistence"
import type { CommandSendMessage } from "./output"

export interface AutotoggleCommandContext {
    sendMessage: CommandSendMessage
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

function formatStatus(state: SessionState): string {
    return state.autotoggle ? "Autotoggle: ON" : "Autotoggle: OFF"
}

export async function handleAutotoggleCommand(ctx: AutotoggleCommandContext): Promise<void> {
    const { sendMessage, state, logger, sessionId, messages, args } = ctx
    const params = getCurrentParams(state, messages, logger)
    const subcommand = (args[0] || "").toLowerCase()

    if (subcommand === "on") {
        state.autotoggle = true
        await saveSessionState(state, logger)
        await sendMessage(formatStatus(state), params)
        return
    }

    if (subcommand === "off") {
        state.autotoggle = false
        await saveSessionState(state, logger)
        await sendMessage(formatStatus(state), params)
        return
    }

    if (subcommand === "") {
        await sendMessage(formatStatus(state), params)
        return
    }

    await sendMessage("Usage: /dcp autotoggle [on|off]", params)
}
