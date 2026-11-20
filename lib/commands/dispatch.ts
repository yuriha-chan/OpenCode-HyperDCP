import { runHousekeepingCommandMutation } from "../housekeeping/state"
import { handleAutotoggleCommand } from "./autotoggle"
import { handleContextCommand } from "./context"
import type { CommandDispatchContext } from "./output"
import { handleDebugCommand } from "./debug"
import { handleDecompressCommand } from "./decompress"
import { handleEditCommand } from "./edit"
import { handleEditFileCommand } from "./edit-file"
import { handleHelpCommand } from "./help"
import { handleManualToggleCommand, handleManualTriggerCommand } from "./manual"
import { handleMemoCommand } from "./memo"
import { handleMemoFileCommand } from "./memo-file"
import { handleMessagesCommand } from "./messages"
import { handleProtectCommand } from "./protect"
import { handleRecompressCommand } from "./recompress"
import { handleRewriteCommand } from "./rewrite"
import { handleStatsCommand } from "./stats"
import { handleSweepCommand } from "./sweep"
import { handleToggleCommand } from "./toggle"
import { handleUnprotectCommand } from "./unprotect"
import { handleViewCommand } from "./view"

export interface CommandGeneration {
    prompt: string
    text: string
}

export interface CommandDispatchResult {
    handled: boolean
    generation?: CommandGeneration
}

export async function dispatchDcpCommand(
    ctx: CommandDispatchContext,
    rawArguments: string,
): Promise<CommandDispatchResult> {
    const { state, config, logger, sessionId, messages, workingDirectory, sendMessage } = ctx
    const args = (rawArguments || "").trim().split(/\s+/).filter(Boolean)
    const subcommand = args[0]?.toLowerCase() || ""
    const subArgs = args.slice(1)

    const commandCtx = {
        sendMessage,
        state,
        config,
        logger,
        sessionId,
        messages,
    }
    const runContextMutation = <T>(
        label: string,
        operation: (context: typeof commandCtx) => Promise<T>,
    ): Promise<T> =>
        state.housekeeping
            ? runHousekeepingCommandMutation(
                  state,
                  logger,
                  label,
                  rawArguments,
                  messages.at(-1)?.info.id ?? "",
                  (draft) => operation({ ...commandCtx, state: draft }),
              )
            : operation(commandCtx)

    if (subcommand === "context") {
        await handleContextCommand(commandCtx)
        return { handled: true }
    }

    if (subcommand === "stats") {
        await handleStatsCommand(commandCtx)
        return { handled: true }
    }

    if (subcommand === "sweep") {
        await runContextMutation("sweep", (command) =>
            handleSweepCommand({ ...command, args: subArgs, workingDirectory }),
        )
        return { handled: true }
    }

    if (subcommand === "manual") {
        await handleManualToggleCommand(commandCtx, subArgs[0]?.toLowerCase())
        return { handled: true }
    }

    if (subcommand === "compress") {
        const userFocus = subArgs.join(" ").trim()
        const prompt = await handleManualTriggerCommand(commandCtx, "compress", userFocus)
        if (!prompt) {
            throw new Error("__DCP_MANUAL_TRIGGER_BLOCKED__")
        }

        if (state.manualMode !== "compress-pending") {
            state.preCompressManualMode = state.manualMode
        }
        state.manualMode = "compress-pending"
        const trimmed = (rawArguments || "").trim()
        return {
            handled: false,
            generation: {
                prompt,
                text: trimmed ? `/dcp ${trimmed}` : `/dcp ${subcommand}`,
            },
        }
    }

    if (subcommand === "decompress") {
        await runContextMutation("decompress", (command) =>
            handleDecompressCommand({ ...command, args: subArgs }),
        )
        return { handled: true }
    }

    if (subcommand === "recompress") {
        await runContextMutation("recompress", (command) =>
            handleRecompressCommand({ ...command, args: subArgs }),
        )
        return { handled: true }
    }

    if (subcommand === "view") {
        await handleViewCommand({
            ...commandCtx,
            args: subArgs,
        })
        return { handled: true }
    }

    if (subcommand === "edit") {
        await runContextMutation("edit", (command) =>
            handleEditCommand({ ...command, args: subArgs }),
        )
        return { handled: true }
    }

    if (subcommand === "edit-file") {
        await runContextMutation("edit-file", (command) =>
            handleEditFileCommand({ ...command, args: subArgs }),
        )
        return { handled: true }
    }

    if (subcommand === "messages") {
        await handleMessagesCommand({
            ...commandCtx,
            args: subArgs,
        })
        return { handled: true }
    }

    if (subcommand === "protect") {
        await handleProtectCommand({
            ...commandCtx,
            args: subArgs,
        })
        return { handled: true }
    }

    if (subcommand === "unprotect") {
        await handleUnprotectCommand({
            ...commandCtx,
            args: subArgs,
        })
        return { handled: true }
    }

    if (subcommand === "rewrite") {
        const prompt = await handleRewriteCommand({
            ...commandCtx,
            args: subArgs,
        })
        if (!prompt) {
            throw new Error("__DCP_REWRITE_BLOCKED__")
        }

        if (state.manualMode !== "compress-pending") {
            state.preCompressManualMode = state.manualMode
        }
        state.manualMode = "compress-pending"
        const trimmed = (rawArguments || "").trim()
        return {
            handled: false,
            generation: {
                prompt,
                text: trimmed ? `/dcp ${trimmed}` : `/dcp ${subcommand}`,
            },
        }
    }

    if (subcommand === "toggle") {
        await runContextMutation("toggle", (command) =>
            handleToggleCommand({ ...command, args: subArgs }),
        )
        return { handled: true }
    }

    if (subcommand === "memo") {
        await runContextMutation("memo", (command) => handleMemoCommand(command, subArgs))
        return { handled: true }
    }

    if (subcommand === "memo-file") {
        await runContextMutation("memo-file", (command) =>
            handleMemoFileCommand({ ...command, args: subArgs }),
        )
        return { handled: true }
    }

    if (subcommand === "debug") {
        await handleDebugCommand({
            ...commandCtx,
            args: subArgs,
            workingDirectory,
        })
        return { handled: true }
    }

    if (subcommand === "autotoggle") {
        await handleAutotoggleCommand({
            ...commandCtx,
            args: subArgs,
        })
        return { handled: true }
    }

    await handleHelpCommand(commandCtx)
    return { handled: true }
}
