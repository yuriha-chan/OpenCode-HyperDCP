import type { SessionState } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { renderSystemPrompt } from "./index"
import { buildProtectedToolsExtension } from "./extensions/system"
import type { PromptStore } from "./store"

const INTERNAL_AGENT_SIGNATURES = [
    "You are a title generator",
    "You are a helpful AI assistant tasked with summarizing conversations",
    "You are an anchored context summarization assistant for coding sessions",
    "Summarize what was done in this conversation",
]

export type SystemGuidancePermission = "ask" | "allow" | "deny"

export function renderSystemGuidance(
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
    systemText: string,
    effectivePermission: SystemGuidancePermission,
): string | undefined {
    if (state.isSubAgent && !config.experimental.allowSubAgents) {
        return undefined
    }

    if (INTERNAL_AGENT_SIGNATURES.some((signature) => systemText.includes(signature))) {
        logger.info("Skipping DCP system prompt injection for internal agent")
        return undefined
    }

    if (effectivePermission === "deny") {
        return undefined
    }

    prompts.reload()
    const runtimePrompts = prompts.getRuntimePrompts()
    return renderSystemPrompt(
        runtimePrompts,
        buildProtectedToolsExtension(config.compress.protectedTools),
        !!state.manualMode,
        state.isSubAgent && config.experimental.allowSubAgents,
    )
}
