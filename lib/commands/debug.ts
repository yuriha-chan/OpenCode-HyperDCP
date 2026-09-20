import { mkdir } from "fs/promises"
import { existsSync } from "fs"
import { isAbsolute, resolve } from "path"
import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { sendIgnoredMessage } from "../ui/notification"
import { getCurrentParams } from "../token-utils"

export interface DebugCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
    workingDirectory?: string
}

function formatStatus(state: SessionState): string {
    if (state.debug.enabled && state.debug.directory) {
        return `Debug dump: ON\nDirectory: ${state.debug.directory}`
    }
    return "Debug dump: OFF"
}

export async function handleDebugCommand(ctx: DebugCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages, args, workingDirectory } = ctx
    const params = getCurrentParams(state, messages, logger)
    const subcommand = (args[0] || "").toLowerCase()

    if (subcommand === "off") {
        state.debug = { enabled: false, directory: null }
        await sendIgnoredMessage(client, sessionId, formatStatus(state), params, logger)
        return
    }

    if (subcommand === "on") {
        const dirArg = args[1]
        if (!dirArg) {
            await sendIgnoredMessage(
                client,
                sessionId,
                "Usage: /dcp debug on <dirname>",
                params,
                logger,
            )
            return
        }

        const resolvedDir = isAbsolute(dirArg)
            ? dirArg
            : resolve(workingDirectory ?? process.cwd(), dirArg)

        if (!existsSync(resolvedDir)) {
            await mkdir(resolvedDir, { recursive: true })
        }

        state.debug = { enabled: true, directory: resolvedDir }
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
        "Usage: /dcp debug [on <dirname> | off]",
        params,
        logger,
    )
}
