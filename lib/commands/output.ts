import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { getCurrentParams } from "../token-utils"

export type CommandMessageParams = ReturnType<typeof getCurrentParams>

export type CommandSendMessage = (text: string, params: CommandMessageParams) => Promise<void>

export interface CommandDispatchContext {
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
    workingDirectory: string
    sendMessage: CommandSendMessage
}
