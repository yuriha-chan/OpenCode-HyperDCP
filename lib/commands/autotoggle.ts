import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { sendIgnoredMessage } from "../ui/notification"
import { getCurrentParams } from "../token-utils"
import { saveSessionState } from "../state/persistence"

export interface AutotoggleCommandContext {
    client: any
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
    const { client, state, logger, sessionId, messages, args } = ctx
    const params = getCurrentParams(state, messages, logger)
    const subcommand = (args[0] || "").toLowerCase()

    if (subcommand === "on") {
        state.autotoggle = true
        await saveSessionState(state, logger)
        await sendIgnoredMessage(client, sessionId, formatStatus(state), params, logger)
        return
    }

    if (subcommand === "off") {
        state.autotoggle = false
        await saveSessionState(state, logger)
        await sendIgnoredMessage(client, sessionId, formatStatus(state), params, logger)
        return
    }

    if (subcommand === "") {
        await sendIgnoredMessage(client, sessionId, formatStatus(state), params, logger)
        return
    }

    await sendIgnoredMessage(
        client,
        sessionId,
        "Usage: /dcp autotoggle [on|off]",
        params,
        logger,
    )
}
