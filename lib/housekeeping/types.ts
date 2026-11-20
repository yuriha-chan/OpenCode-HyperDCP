import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import type { PromptStore } from "../prompts/store"
import type { SessionState, WithParts } from "../state"

export interface ToolExecutionContext {
    sessionID: string
    messageID: string
    callID?: string
}

export interface SharedOperationContext {
    state: SessionState
    logger: Logger
    config: PluginConfig
    prompts: PromptStore
    refreshSession(sessionID: string): Promise<WithParts[]>
}

export interface GuardOperationContext {
    state: SessionState
    config: PluginConfig
    refreshSession(sessionID: string): Promise<WithParts[]>
}

export function operationIdentity(messageID: string, callID: string): string {
    return `${messageID}\0${callID}`
}
