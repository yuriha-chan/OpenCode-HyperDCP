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
import { type PromptStore } from "./prompts"
import { renderSystemGuidance } from "./prompts/system-guidance"
import {
    applyPendingCompressionDurations,
    buildCompressionTimingKey,
    consumeCompressionStart,
    resolveCompressionDuration,
} from "./compress/timing"
import { filterMessages, filterMessagesInPlace } from "./messages/shape"
import { sendIgnoredMessage } from "./ui/notification"
import { dumpTransformedMessages } from "./debug-dump"
import { applyPendingManualTrigger } from "./commands"
import { dispatchDcpCommand } from "./commands/dispatch"
import type { CommandSendMessage } from "./commands/output"
import { type HostPermissionSnapshot } from "./host-permissions"
import { compressPermission, syncCompressPermissionState } from "./compress-permission"
import {
    checkSession,
    ensureSessionInitialized,
    saveSessionState,
    saveSessionStateStrict,
    syncToolCache,
} from "./state"
import { findLastCompactionTimestamp, resetOnCompaction } from "./state/utils"
import { cacheSystemPromptTokens } from "./ui/utils"
import { projectHousekeepingHistory, reconcileHousekeepingHistory } from "./housekeeping/history"
import { withSessionCoordinator } from "./housekeeping/coordinator"

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

        const effectivePermission =
            input.sessionID && state.sessionId === input.sessionID
                ? compressPermission(state, config)
                : config.compress.permission

        const newPrompt = renderSystemGuidance(
            state,
            logger,
            config,
            prompts,
            output.system.join("\n"),
            effectivePermission,
        )
        if (newPrompt === undefined) {
            return
        }
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
    return async (input: {}, output: { messages: WithParts[] }) =>
        withSessionCoordinator(state, async () => {
            const receivedMessages = Array.isArray(output.messages) ? output.messages.length : 0
            const messages = filterMessagesInPlace(output.messages)
            if (messages.length !== receivedMessages) {
                logger.warn("Skipping messages with unexpected shape during chat transform", {
                    received: receivedMessages,
                    usable: messages.length,
                })
            }

            await checkSession(client, state, logger, output.messages, config.manualMode.enabled)

            const reconciledState = structuredClone(state)
            if (await reconcileHousekeepingHistory(reconciledState, output.messages)) {
                await saveSessionStateStrict(reconciledState, logger)
                Object.assign(state, reconciledState)
            }

            syncCompressionBlocks(state, logger, output.messages)

            const newMessages = projectHousekeepingHistory(
                output.messages,
                state.housekeepingHistory,
            )
            output.messages.length = 0
            output.messages.push(...newMessages)

            syncCompressPermissionState(state, config, hostPermissions, output.messages)

            if (state.isSubAgent && !config.experimental.allowSubAgents) {
                return
            }

            if (state.housekeeping) {
                const tag = /\n?<dcp-message-id\b[^>]*>(?:m\d{4}|BLOCKED)<\/dcp-message-id>/g
                for (const message of output.messages) {
                    for (const part of message.parts) {
                        if (part.type === "text") part.text = part.text.replace(tag, "")
                        else if (part.type === "tool" && part.state.status === "completed") {
                            part.state.output = part.state.output.replace(tag, "")
                        }
                    }
                }
            }

            stripHallucinations(output.messages)
            truncateToolOutputs(config, output.messages)
            cacheSystemPromptTokens(state, output.messages)
            const newRefs = state.housekeeping ? 0 : assignMessageRefs(state, output.messages)
            if (newRefs > 0) {
                await saveSessionState(state, logger)
            }
            syncToolCache(state, config, logger, output.messages)
            buildToolIdList(state, output.messages)
            const latestUser = findLatestUserMessage(state, output.messages)
            const isNewUserMessage =
                latestUser !== null && latestUser !== state.prune.messages.lastSeenUserMessageId
            if (latestUser !== null) {
                state.prune.messages.lastSeenUserMessageId = latestUser
            }
            if (
                isNewUserMessage &&
                state.manualMode === "compress-pending" &&
                !state.pendingManualTrigger
            ) {
                state.manualMode = state.preCompressManualMode
            }
            state.prune.messages.activeMessageIds = output.messages.map(
                (message) => message.info.id,
            )
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
            if (!state.housekeeping)
                injectCompressNudges(
                    state,
                    config,
                    logger,
                    output.messages,
                    prompts.getRuntimePrompts(),
                    compressionPriorities,
                    prePruneMessages,
                )
            if (!state.housekeeping)
                injectMessageIds(state, config, output.messages, compressionPriorities)
            applyPendingManualTrigger(state, output.messages, logger)
            stripStaleMetadata(output.messages)

            await dumpTransformedMessages(state.debug, output.messages)

            if (state.sessionId) {
                await logger.saveContext(state.sessionId, output.messages)
            }
        })
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
    ) =>
        withSessionCoordinator(state, async () => {
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

                const candidateState = structuredClone(state)
                const compaction = findLastCompactionTimestamp(messages)
                let stateChanged = false
                if (compaction > candidateState.lastCompaction) {
                    candidateState.lastCompaction = compaction
                    resetOnCompaction(candidateState)
                    stateChanged = true
                }
                if (await reconcileHousekeepingHistory(candidateState, messages))
                    stateChanged = true
                if (stateChanged) {
                    await saveSessionStateStrict(candidateState, logger)
                    Object.assign(state, candidateState)
                }

                syncCompressPermissionState(state, config, hostPermissions, messages)

                const effectivePermission = compressPermission(state, config)
                if (effectivePermission === "deny") {
                    return
                }

                const sendMessage: CommandSendMessage = (message, params) =>
                    sendIgnoredMessage(client, input.sessionID, message, params, logger)
                const result = await dispatchDcpCommand(
                    {
                        state,
                        config,
                        logger,
                        sessionId: input.sessionID,
                        messages,
                        workingDirectory,
                        sendMessage,
                    },
                    input.arguments,
                )
                if (result.generation) {
                    state.pendingManualTrigger = {
                        sessionId: input.sessionID,
                        prompt: result.generation.prompt,
                    }
                    output.parts.length = 0
                    output.parts.push({
                        type: "text",
                        text: result.generation.text,
                    })
                    return
                }
                if (result.handled) {
                    output.handled = true
                }
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
        })
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
    return async (input: { event: any }) =>
        withSessionCoordinator(state, async () => {
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
        })
}
