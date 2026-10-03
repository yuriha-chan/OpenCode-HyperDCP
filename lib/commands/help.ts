/**
 * DCP Help command handler.
 * Shows available DCP commands and their descriptions.
 */

import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import type { SessionState, WithParts } from "../state"
import { compressPermission } from "../compress-permission"
import { sendIgnoredMessage } from "../ui/notification"
import { getCurrentParams } from "../token-utils"

export interface HelpCommandContext {
    client: any
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

const BASE_COMMANDS: [string, string][] = [
    ["/dcp context", "Show token usage breakdown for current session"],
    ["/dcp stats", "Show DCP pruning statistics"],
    ["/dcp sweep [n]", "Prune tools since last user message, or last n tools"],
    ["/dcp manual [on|off]", "Toggle manual mode or set explicit state"],
    ["/dcp messages [from] [to]", "List message IDs with truncated previews"],
    ["/dcp protect <n>", "Protect a message from compression"],
    ["/dcp unprotect <n>", "Remove manual protection from a message"],
    ["/dcp debug [on <dir>|off]", "Dump each post-transform LLM query as JSON to <dir>"],
    ["/dcp autotoggle [on|off]", "Allow the LLM to call toggle_summary_version"],
    ["/dcp edit-file <n> <path>", "Apply summary text from a file to a compression"],
]

const TOOL_COMMANDS: Record<string, [string, string]> = {
    compress: ["/dcp compress [focus]", "Trigger manual compress tool execution"],
    decompress: ["/dcp decompress <n>", "Restore selected compression"],
    recompress: ["/dcp recompress <n>", "Re-apply a user-decompressed compression"],
    view: ["/dcp view <n>", "View compression summary and metadata"],
    edit: ["/dcp edit <n> [text]", "Edit a compression summary (/dcp edit <n> -a to append)"],
}

function getVisibleCommands(state: SessionState, config: PluginConfig): [string, string][] {
    const commands = [...BASE_COMMANDS]

    if (compressPermission(state, config) !== "deny") {
        commands.push(TOOL_COMMANDS.compress)
        commands.push(TOOL_COMMANDS.decompress)
        commands.push(TOOL_COMMANDS.recompress)
    }

    return commands
}

function formatHelpMessage(state: SessionState, config: PluginConfig): string {
    const commands = getVisibleCommands(state, config)
    const colWidth = Math.max(...commands.map(([cmd]) => cmd.length)) + 4
    const lines: string[] = []

    lines.push("╭─────────────────────────────────────────────────────────────────────────╮")
    lines.push("│                              DCP Commands                               │")
    lines.push("╰─────────────────────────────────────────────────────────────────────────╯")
    lines.push("")
    lines.push(`  ${"Manual mode:".padEnd(colWidth)}${state.manualMode ? "ON" : "OFF"}`)
    lines.push("")
    for (const [cmd, desc] of commands) {
        lines.push(`  ${cmd.padEnd(colWidth)}${desc}`)
    }
    lines.push("")

    return lines.join("\n")
}

export async function handleHelpCommand(ctx: HelpCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx

    const { config } = ctx
    const message = formatHelpMessage(state, config)

    const params = getCurrentParams(state, messages, logger)
    await sendIgnoredMessage(client, sessionId, message, params, logger)

    logger.info("Help command executed")
}
