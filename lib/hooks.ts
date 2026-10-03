import type { SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import { assignMessageRefs } from "./message-ids"
import {
    buildPriorityMap,
    buildToolIdList,
    injectCompressNudges,
    injectExtendedSubAgentResults,
    injectMessageIds,
    prune,
    stripHallucinations,
    stripHallucinationsFromString,
    stripStaleMetadata,
    syncCompressionBlocks,
    truncateToolOutputs,
} from "./messages"
import { getLastUserMessage } from "./messages/query"
import { renderSystemPrompt, type PromptStore } from "./prompts"
import { buildProtectedToolsExtension } from "./prompts/extensions/system"
import {
    applyPendingCompressionDurations,
    buildCompressionTimingKey,
    consumeCompressionStart,
    resolveCompressionDuration,
} from "./compress/timing"
import { filterMessages, filterMessagesInPlace } from "./messages/shape"
import { sendIgnoredMessage } from "./ui/notification"
import { dumpTransformedMessages } from "./debug-dump"
import {
    applyPendingManualTrigger,
    handleAutotoggleCommand,
    handleContextCommand,
    handleDebugCommand,
    handleDecompressCommand,
    handleEditCommand,
    handleEditFileCommand,
    handleHelpCommand,
    handleManualToggleCommand,
    handleManualTriggerCommand,
    handleMemoCommand,
    handleMemoFileCommand,
    handleMessagesCommand,
    handleProtectCommand,
    handleRecompressCommand,
    handleRewriteCommand,
    handleStatsCommand,
    handleSweepCommand,
    handleToggleCommand,
    handleUnprotectCommand,
    handleViewCommand,
} from "./commands"
import { autoSavePendingBuffers } from "./expand-block"
import { type HostPermissionSnapshot } from "./host-permissions"
import { compressPermission, syncCompressPermissionState } from "./compress-permission"
import { checkSession, ensureSessionInitialized, saveSessionState, syncToolCache } from "./state"
import { cacheSystemPromptTokens } from "./ui/utils"

const INTERNAL_AGENT_SIGNATURES = [
    "You are a title generator",
    "You are a helpful AI assistant tasked with summarizing conversations",
    "You are an anchored context summarization assistant for coding sessions",
    "Summarize what was done in this conversation",
]

function findLatestUserMessage(state: SessionState, messages: WithParts[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role === "user") {
            return msg.info.id
        }
    }
    return null
}

export function createSystemPromptHandler(
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
) {
    return async (
        input: { sessionID?: string; model: { limit: { context: number } } },
        output: { system: string[] },
    ) => {
        if (input.model?.limit?.context) {
            state.modelContextLimit = input.model.limit.context
            logger.debug("Cached model context limit", { limit: state.modelContextLimit })
        }

        if (state.isSubAgent && !config.experimental.allowSubAgents) {
            return
        }

        const systemText = output.system.join("\n")
        if (INTERNAL_AGENT_SIGNATURES.some((sig) => systemText.includes(sig))) {
            logger.info("Skipping DCP system prompt injection for internal agent")
            return
        }

        const effectivePermission =
            input.sessionID && state.sessionId === input.sessionID
                ? compressPermission(state, config)
                : config.compress.permission

        if (effectivePermission === "deny") {
            return
        }

        prompts.reload()
        const runtimePrompts = prompts.getRuntimePrompts()
        const newPrompt = renderSystemPrompt(
            runtimePrompts,
            buildProtectedToolsExtension(config.compress.protectedTools),
            !!state.manualMode,
            state.isSubAgent && config.experimental.allowSubAgents,
        )
        if (output.system.length > 0) {
            output.system[output.system.length - 1] += "\n\n" + newPrompt
        } else {
            output.system.push(newPrompt)
        }
    }
}

export function createChatMessageTransformHandler(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
    hostPermissions: HostPermissionSnapshot,
) {
    return async (input: {}, output: { messages: WithParts[] }) => {
        const receivedMessages = Array.isArray(output.messages) ? output.messages.length : 0
        const messages = filterMessagesInPlace(output.messages)
        if (messages.length !== receivedMessages) {
            logger.warn("Skipping messages with unexpected shape during chat transform", {
                received: receivedMessages,
                usable: messages.length,
            })
        }

        await checkSession(client, state, logger, output.messages, config.manualMode.enabled)

        syncCompressPermissionState(state, config, hostPermissions, output.messages)

        if (state.isSubAgent && !config.experimental.allowSubAgents) {
            return
        }

        stripHallucinations(output.messages)
        truncateToolOutputs(config, output.messages)
        cacheSystemPromptTokens(state, output.messages)
        const newRefs = assignMessageRefs(state, output.messages)
        if (newRefs > 0) {
            await saveSessionState(state, logger)
        }
        syncCompressionBlocks(state, logger, output.messages)
        syncToolCache(state, config, logger, output.messages)
        buildToolIdList(state, output.messages)
        const latestUser = findLatestUserMessage(state, output.messages)
        const isNewUserMessage = latestUser !== null && latestUser !== state.prune.messages.lastSeenUserMessageId
        if (isNewUserMessage) {
            autoSavePendingBuffers(state, logger)
        }
        if (latestUser !== null) {
            state.prune.messages.lastSeenUserMessageId = latestUser
        }
        if (isNewUserMessage && state.manualMode === "compress-pending" && !state.pendingManualTrigger) {
            state.manualMode = state.preCompressManualMode
        }
        state.prune.messages.activeMessageIds = output.messages.map((message) => message.info.id)
        const prePruneMessages = [...output.messages]
        prune(state, logger, config, output.messages)
        await injectExtendedSubAgentResults(
            client,
            state,
            logger,
            output.messages,
            config.experimental.allowSubAgents,
        )
        const compressionPriorities = buildPriorityMap(config, state, output.messages)
        prompts.reload()
        injectCompressNudges(
            state,
            config,
            logger,
            output.messages,
            prompts.getRuntimePrompts(),
            compressionPriorities,
            prePruneMessages,
        )
        injectMessageIds(state, config, output.messages, compressionPriorities)
        applyPendingManualTrigger(state, output.messages, logger)
        stripStaleMetadata(output.messages)

        await dumpTransformedMessages(state.debug, output.messages)

        if (state.sessionId) {
            await logger.saveContext(state.sessionId, output.messages)
        }
    }
}

export function createCommandExecuteHandler(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    workingDirectory: string,
    hostPermissions: HostPermissionSnapshot,
) {
    return async (
        input: { command: string; sessionID: string; arguments: string },
        output: { parts: any[]; handled?: boolean },
    ) => {
        if (!config.commands.enabled) {
            return
        }

        if (input.command === "dcp") {
            const messagesResponse = await client.session.messages({
                path: { id: input.sessionID },
            })
            const messages = filterMessages(messagesResponse.data || messagesResponse)

            const detectedSessionId =
                getLastUserMessage(messages)?.info.sessionID || input.sessionID

            await ensureSessionInitialized(
                client,
                state,
                detectedSessionId,
                logger,
                messages,
                config.manualMode.enabled,
            )

            syncCompressPermissionState(state, config, hostPermissions, messages)

            const effectivePermission = compressPermission(state, config)
            if (effectivePermission === "deny") {
                return
            }

            const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean)
            const subcommand = args[0]?.toLowerCase() || ""
            const subArgs = args.slice(1)

            const commandCtx = {
                client,
                state,
                config,
                logger,
                sessionId: input.sessionID,
                messages,
            }

            if (subcommand === "context") {
                await handleContextCommand(commandCtx)
                output.handled = true
                return
            }

            if (subcommand === "stats") {
                await handleStatsCommand(commandCtx)
                output.handled = true
                return
            }

            if (subcommand === "sweep") {
                await handleSweepCommand({
                    ...commandCtx,
                    args: subArgs,
                    workingDirectory,
                })
                output.handled = true
                return
            }

            if (subcommand === "manual") {
                await handleManualToggleCommand(commandCtx, subArgs[0]?.toLowerCase())
                output.handled = true
                return
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
                state.pendingManualTrigger = {
                    sessionId: input.sessionID,
                    prompt,
                }
                const rawArgs = (input.arguments || "").trim()
                output.parts.length = 0
                output.parts.push({
                    type: "text",
                    text: rawArgs ? `/dcp ${rawArgs}` : `/dcp ${subcommand}`,
                })
                return
            }

            if (subcommand === "decompress") {
                await handleDecompressCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                output.handled = true
                return
            }

            if (subcommand === "recompress") {
                await handleRecompressCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                output.handled = true
                return
            }

            if (subcommand === "view") {
                await handleViewCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                output.handled = true
                return
            }

            if (subcommand === "edit") {
                await handleEditCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                output.handled = true
                return
            }

            if (subcommand === "edit-file") {
                await handleEditFileCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                output.handled = true
                return
            }

            if (subcommand === "messages") {
                await handleMessagesCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                output.handled = true
                return
            }

            if (subcommand === "protect") {
                await handleProtectCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                output.handled = true
                return
            }

            if (subcommand === "unprotect") {
                await handleUnprotectCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                output.handled = true
                return
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
                state.pendingManualTrigger = {
                    sessionId: input.sessionID,
                    prompt,
                }
                const rawArgs = (input.arguments || "").trim()
                output.parts.length = 0
                output.parts.push({
                    type: "text",
                    text: rawArgs ? `/dcp ${rawArgs}` : `/dcp ${subcommand}`,
                })
                return
            }

            if (subcommand === "toggle") {
                await handleToggleCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                output.handled = true
                return
            }

            if (subcommand === "memo") {
                await handleMemoCommand(
                    {
                        ...commandCtx,
                    },
                    subArgs,
                )
                output.handled = true
                return
            }

            if (subcommand === "memo-file") {
                await handleMemoFileCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                output.handled = true
                return
            }

            if (subcommand === "debug") {
                await handleDebugCommand({
                    ...commandCtx,
                    args: subArgs,
                    workingDirectory,
                })
                output.handled = true
                return
            }

            if (subcommand === "autotoggle") {
                await handleAutotoggleCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                output.handled = true
                return
            }

            await handleHelpCommand(commandCtx)
            output.handled = true
            return
        }

        if (input.command === "dcp-tui") {
            const args = (input.arguments || "").trim()
            const text = args
                ? `Use the command palette (Ctrl+P) and type /dcp-tui ${args}`
                : "Use the command palette (Ctrl+P) and type /dcp-tui blocks|messages|memo"
            await sendIgnoredMessage(client, input.sessionID, text, {}, logger)
            output.handled = true
            return
        }
    }
}

export function createTextCompleteHandler() {
    return async (
        _input: { sessionID: string; messageID: string; partID: string },
        output: { text: string },
    ) => {
        output.text = stripHallucinationsFromString(output.text)
    }
}

export function createEventHandler(state: SessionState, logger: Logger) {
    return async (input: { event: any }) => {
        const eventTime =
            typeof input.event?.time === "number" && Number.isFinite(input.event.time)
                ? input.event.time
                : typeof input.event?.properties?.time === "number" &&
                    Number.isFinite(input.event.properties.time)
                  ? input.event.properties.time
                  : undefined

        if (input.event.type !== "message.part.updated") {
            return
        }

        const part = input.event.properties?.part
        if (part?.type !== "tool" || part.tool !== "compress") {
            return
        }

        if (part.state.status === "pending") {
            if (typeof part.callID !== "string" || typeof part.messageID !== "string") {
                return
            }

            const startedAt = eventTime ?? Date.now()
            const key = buildCompressionTimingKey(part.messageID, part.callID)
            if (state.compressionTiming.startsByCallId.has(key)) {
                return
            }
            state.compressionTiming.startsByCallId.set(key, startedAt)
            logger.debug("Recorded compression start", {
                messageID: part.messageID,
                callID: part.callID,
                startedAt,
            })
            return
        }

        if (part.state.status === "completed") {
            if (typeof part.callID !== "string" || typeof part.messageID !== "string") {
                return
            }

            const key = buildCompressionTimingKey(part.messageID, part.callID)
            const start = consumeCompressionStart(state, part.messageID, part.callID)
            const durationMs = resolveCompressionDuration(start, eventTime, part.state.time)
            if (typeof durationMs !== "number") {
                return
            }

            state.compressionTiming.pendingByCallId.set(key, {
                messageId: part.messageID,
                callId: part.callID,
                durationMs,
            })

            const updates = applyPendingCompressionDurations(state)
            if (updates === 0) {
                return
            }

            await saveSessionState(state, logger)

            logger.info("Attached compression time to blocks", {
                messageID: part.messageID,
                callID: part.callID,
                blocks: updates,
                durationMs,
            })
            return
        }

        if (part.state.status === "running") {
            return
        }

        if (typeof part.callID === "string" && typeof part.messageID === "string") {
            state.compressionTiming.startsByCallId.delete(
                buildCompressionTimingKey(part.messageID, part.callID),
            )
        }
    }
}
