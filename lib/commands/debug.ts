import { mkdir } from "fs/promises"
import { existsSync } from "fs"
import { isAbsolute, resolve } from "path"
import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { getCurrentParams } from "../token-utils"
import type { CommandSendMessage } from "./output"

export interface DebugCommandContext {
    sendMessage: CommandSendMessage
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
    const { sendMessage, state, logger, sessionId, messages, args, workingDirectory } = ctx
    const params = getCurrentParams(state, messages, logger)
    const subcommand = (args[0] || "").toLowerCase()

    if (subcommand === "off") {
        state.debug = { enabled: false, directory: null }
        await sendMessage(formatStatus(state), params)
        return
    }

    if (subcommand === "on") {
        const dirArg = args[1]
        if (!dirArg) {
            await sendMessage("Usage: /dcp debug on <dirname>", params)
            return
        }

        const resolvedDir = isAbsolute(dirArg)
            ? dirArg
            : resolve(workingDirectory ?? process.cwd(), dirArg)

        if (!existsSync(resolvedDir)) {
            await mkdir(resolvedDir, { recursive: true })
        }

        state.debug = { enabled: true, directory: resolvedDir }
        await sendMessage(formatStatus(state), params)
        return
    }

    if (subcommand === "") {
        await sendMessage(formatStatus(state), params)
        return
    }

    await sendMessage("Usage: /dcp debug [on <dirname> | off]", params)
}
