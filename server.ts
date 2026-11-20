import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { ToolContext as NativeToolContext } from "@opencode/plugin/promise/tool"
import server from "./index"
import { buildPriorityMap } from "./lib/messages/priority"
import { prepareSkillLoad, recordSkillLoad, unloadSkill } from "./lib/skills"
import { compressMessages, renderCompressMessageDescription } from "./lib/compress/message"
import { compressRanges, renderCompressRangeDescription } from "./lib/compress/range"
import type {
    CompressMessageToolArgs,
    CompressRangeToolArgs,
    CompressionOperationContext,
} from "./lib/compress/types"
import { getConfig } from "./lib/config"
import { Logger } from "./lib/logger"
import {
    prepareModelContext,
    injectContextMemo,
    injectContextMessageIds,
    injectContextNudges,
    injectContextSkills,
    projectContextBlocks,
} from "./lib/model-context"
import { renderContextMemo } from "./lib/memo"
import { assignMessageRefs } from "./lib/message-ids"
import { saveSessionState } from "./lib/state/persistence"
import {
    createSessionState,
    initializeSessionState,
    type SessionState,
    type WithParts,
} from "./lib/state"
import { reconcileSessionHistory } from "./lib/housekeeping/state"
import { READ_MEMO_DESCRIPTION, readMemo } from "./lib/read-memo"
import {
    FETCH_SUMMARY_VERSIONS_DESCRIPTION,
    fetchSummaryVersions,
    type FetchSummaryVersionsInput,
} from "./lib/fetch-summary-versions"
import {
    recallCompressed,
    renderRecallCompressedDescription,
    type RecallCompressedInput,
} from "./lib/recall"
import {
    APPEND_SUMMARY_DESCRIPTION,
    EDIT_SUMMARY_DESCRIPTION,
    EXPAND_BLOCK_DESCRIPTION,
    appendSummary,
    editSummary,
    expandBlock,
    type AppendSummaryInput,
    type EditSummaryInput,
    type ExpandBlockInput,
} from "./lib/expand-block"
import {
    renderRewriteSummaryDescription,
    rewriteSummary,
    type RewriteSummaryInput,
} from "./lib/rewrite-summary"
import {
    TOGGLE_SUMMARY_VERSION_DESCRIPTION,
    toggleSummaryVersion,
    type ToggleSummaryVersionInput,
} from "./lib/toggle-summary-version"
import { EDIT_MEMO_DESCRIPTION, MEMO_ACTION_VALUES, editSessionMemo } from "./lib/set-memo"
import {
    ENTER_HOUSEKEEPING_DESCRIPTION,
    LEAVE_HOUSEKEEPING_DESCRIPTION,
    enterHousekeeping,
    leaveHousekeeping,
} from "./lib/housekeeping/tools"
import { assertToolExecutionAllowed } from "./lib/housekeeping/guard"
import type { SharedOperationContext } from "./lib/housekeeping/types"
import { PromptStore } from "./lib/prompts/store"
import { renderSystemGuidance } from "./lib/prompts/system-guidance"
import { withSessionCoordinator } from "./lib/housekeeping/coordinator"
import { wildcardMatch } from "./lib/host-permissions"
import { dispatchDcpCommand } from "./lib/commands/dispatch"
import type { CommandSendMessage } from "./lib/commands/output"
import { finalizeCompression } from "./lib/compress/pipeline"
import { notificationRpc } from "./lib/notification-rpc"
import type { NotificationDelivery } from "./lib/ui/notification"
import {
    isOwnedDisplayOnlyMessage,
    nativeSessionTodos,
    normalizeNativeHistory,
    type NativePermissionRule,
    type NativeSessionInfo,
    type NativeSessionMessage,
} from "./lib/native-session"

function compressDisabledByNativeRules(rules: ReadonlyArray<NativePermissionRule>): boolean {
    let match: NativePermissionRule | undefined
    for (let index = rules.length - 1; index >= 0; index -= 1) {
        const rule = rules[index]
        if (rule && wildcardMatch("compress", rule.action)) {
            match = rule
            break
        }
    }
    return match?.resource === "*" && match.effect === "deny"
}

function appendSystemGuidance(system: SessionContext["system"], guidance: string): void {
    if (system.length === 0) {
        system.push({ type: "text", text: guidance })
        return
    }
    const index = system.length - 1
    const last = system[index]!
    system[index] = { ...last, text: `${last.text}\n\n${guidance}` }
}

function validateSessionInfo(info: NativeSessionInfo, sessionID: string): void {
    if (typeof info?.id === "string" && info.id !== sessionID)
        throw new Error(`Native session metadata identity mismatch for ${sessionID}.`)
}

function memoTopicJsonSchema(depth = 1): Record<string, unknown> {
    const properties: Record<string, unknown> = {
        topicTitle: { type: "string", description: "Topic title without slashes" },
        textItems: {
            type: "array",
            items: { type: "string" },
            description: "Text items, without bullet markers",
        },
    }
    properties.topics = {
        type: "array",
        items: depth < 6 ? memoTopicJsonSchema(depth + 1) : false,
        description: "Nested topics; omitted means empty",
    }
    return { type: "object", properties, required: ["topicTitle"], additionalProperties: false }
}

const EDIT_MEMO_INPUT_SCHEMA = {
    type: "object",
    required: ["action"],
    properties: {
        action: {
            type: "string",
            enum: [...MEMO_ACTION_VALUES],
            description: "Memo action",
        },
        parent: { type: "string", description: "Parent topic path for append" },
        after: { type: "string", description: "Sibling topic path to insert after" },
        textItems: {
            type: "array",
            items: { type: "string" },
            description: "Text items to append, without bullet markers; omitted means empty",
        },
        topics: {
            type: "array",
            items: memoTopicJsonSchema(),
            description: "Topics to append in submitted order; omitted means empty",
        },
        path: {
            type: "string",
            description: "Topic path or string-prefix selector for remove/clear",
        },
    },
    additionalProperties: false,
}

const RECALL_COMPRESSED_INPUT_SCHEMA = {
    type: "object",
    required: ["action"],
    properties: {
        action: {
            type: "string",
            enum: ["get", "search"],
            description: "The action: 'get' to retrieve original messages, 'search' to find text",
        },
        blockId: {
            type: "number",
            description: "Block ID to scope 'search' (e.g. 3)",
        },
        messageId: {
            type: "string",
            description: "Raw message ID (e.g. 'm0005') to retrieve via 'get'",
        },
        messageIdStart: {
            type: "string",
            description: "Start of message ID range (e.g. 'm0005') for 'get' or 'search'",
        },
        messageIdEnd: {
            type: "string",
            description: "End of message ID range (e.g. 'm0020') for 'get' or 'search'",
        },
        query: {
            type: "string",
            description: "Text or regex pattern to search for (required for 'search')",
        },
        blockIdStart: {
            type: "number",
            description: "Scope 'search' to messages from this block ID (inclusive)",
        },
        blockIdEnd: {
            type: "number",
            description: "Scope 'search' to messages up to this block ID (inclusive)",
        },
    },
    additionalProperties: false,
}

const definition = {
    id: "@architectural-composition/opencode-hyperdcp",
    server,
    setup: async ({
        location,
        session,
        agent,
        model,
        skill,
        permission,
        command,
        tool,
        rpc,
    }: Plugin.Context) => {
        const config = getConfig(location)
        if (!config.enabled) return
        const logger = new Logger(config.debug)
        const toastRpc = await rpc.register(notificationRpc, {})
        const sendDisplayOnlyMessage = async (sessionID: string, text: string): Promise<void> => {
            await session.synthetic({
                sessionID,
                text,
                metadata: { hyperdcp: { displayOnly: true } },
                resume: false,
            })
        }
        const prompts = new PromptStore(
            logger,
            location.directory,
            config.experimental.customPrompts,
        )

        const states = new Map<string, SessionState>()
        const stateFor = (sessionID: string): SessionState => {
            let state = states.get(sessionID)
            if (!state) {
                state = createSessionState()
                states.set(sessionID, state)
            }
            return state
        }
        const loadNativeSession = async (sessionID: string, toolName?: string) => {
            const info = await session.get({ sessionID })
            validateSessionInfo(info, sessionID)
            const isSubAgent = Boolean(info?.parentID)
            if (toolName && isSubAgent && !config.experimental.allowSubAgents)
                throw new Error(`${toolName} is unavailable in subagent sessions.`)
            const nativeMessages: NativeSessionMessage[] = await session.context({ sessionID })
            const messages = normalizeNativeHistory(nativeMessages, sessionID)
            return { info, isSubAgent, messages, nativeMessages }
        }
        const refresh = async (
            state: SessionState,
            sessionID: string,
            toolName?: string,
        ): Promise<WithParts[]> => {
            const { isSubAgent, messages } = await loadNativeSession(sessionID, toolName)
            return reconcileSessionHistory(
                { state, logger, config },
                sessionID,
                messages,
                async () => isSubAgent,
            )
        }
        await session.hook("context", async (request) => {
            if (!request.sessionID) {
                prepareModelContext(request)
                return
            }
            const state = stateFor(request.sessionID)
            await withSessionCoordinator(state, async () => {
                const { info, isSubAgent, messages, nativeMessages } = await loadNativeSession(
                    request.sessionID,
                )
                await initializeSessionState(
                    async () => isSubAgent,
                    state,
                    request.sessionID,
                    logger,
                    messages,
                    config.manualMode.enabled,
                )
                const models = await model.list({ location })
                state.modelContextLimit = models.data.find(
                    (candidate) =>
                        candidate.id === request.model?.id &&
                        candidate.providerID === request.model?.providerID,
                )?.limit.context
                const agentInfo = await agent.get({ agentID: request.agent })
                const rules = [...(agentInfo.data.permissions ?? []), ...(info.permissions ?? [])]
                let effectivePermission = config.compress.permission
                if (effectivePermission !== "deny" && compressDisabledByNativeRules(rules)) {
                    effectivePermission = "deny"
                }
                state.compressPermission = effectivePermission
                const systemText = request.system.map((part) => part.text).join("\n")
                const guidance = renderSystemGuidance(
                    state,
                    logger,
                    config,
                    prompts,
                    systemText,
                    effectivePermission,
                )
                if (guidance !== undefined) appendSystemGuidance(request.system, guidance)
                const history = state.housekeepingHistory.filter(
                    (entry) => entry.sessionId === request.sessionID,
                )
                const ownedDisplayOnlyIds = new Set(
                    nativeMessages.filter(isOwnedDisplayOnlyMessage).map((message) => message.id),
                )
                prepareModelContext(request, history, ownedDisplayOnlyIds)
                const memoAllowed = !(state.isSubAgent && !config.experimental.allowSubAgents)
                const byId = new Map(messages.map((message) => [message.info.id, message]))
                const selected = request.messages.flatMap((message) => {
                    const source = message.id === undefined ? undefined : byId.get(message.id)
                    return source ? [source] : []
                })
                if (memoAllowed && assignMessageRefs(state, selected) > 0) {
                    await saveSessionState(state, logger)
                }
                const lastSummaryId = memoAllowed
                    ? projectContextBlocks(request, state, logger, config)
                    : undefined
                injectContextMemo(
                    request,
                    memoAllowed && state.memo ? renderContextMemo(state.memo) : "",
                    lastSummaryId,
                )
                injectContextSkills(
                    request,
                    memoAllowed ? state.protectedSkills : [],
                    lastSummaryId,
                )
                if (memoAllowed) {
                    const priorities = buildPriorityMap(config, state, selected)
                    prompts.reload()
                    injectContextNudges(
                        request,
                        state,
                        config,
                        logger,
                        selected,
                        prompts.getRuntimePrompts(),
                        priorities,
                    )
                    injectContextMessageIds(request, state, config, selected, priorities)
                }
            })
        })
        const operationContext = (sessionID: string, toolName: string): SharedOperationContext => {
            const state = stateFor(sessionID)
            return {
                state,
                logger,
                config,
                prompts,
                refreshSession: (target: string) => refresh(state, target, toolName),
            }
        }
        const fetchTodos = async (
            sessionID: string,
            _messages: WithParts[],
        ): Promise<unknown[] | undefined> => {
            const info = await session.get({ sessionID })
            validateSessionInfo(info, sessionID)
            const nativeMessages: NativeSessionMessage[] = await session.context({ sessionID })
            return nativeSessionTodos(nativeMessages, info.revert?.messageID)
        }
        const identity = (toolContext: NativeToolContext) => ({
            sessionID: toolContext.sessionID,
            messageID: toolContext.messageID,
            callID: toolContext.id,
        })
        const assertPermission = (action: string, toolContext: NativeToolContext): Promise<void> =>
            permission.assert({
                sessionID: toolContext.sessionID,
                agent: toolContext.agent,
                action,
                resources: ["*"],
                source: {
                    type: "tool",
                    messageID: toolContext.messageID,
                    id: toolContext.id,
                },
            })

        await tool.hook("execute.before", async (event) => {
            const state = stateFor(event.sessionID)
            await assertToolExecutionAllowed(
                {
                    state,
                    config,
                    refreshSession: (sessionID) => refresh(state, sessionID),
                },
                { tool: event.tool, sessionID: event.sessionID, callID: event.id },
                event.input,
            )
            if (event.tool === "skill") {
                const input = event.input as { id: string; force?: boolean }
                const inventory = await skill.list({ location })
                const entry = inventory.data.find((entry) => entry.id === input.id)
                if (entry)
                    await prepareSkillLoad(
                        { state, logger, refreshSession: (id) => refresh(state, id) },
                        event.sessionID,
                        { name: entry.name, force: input.force },
                    )
            }
        })
        await tool.hook("execute.after", async (event) => {
            if (event.tool !== "skill" || event.status !== "completed") return
            const state = stateFor(event.sessionID)
            const name = event.result.metadata?.name
            await recordSkillLoad(
                { state, logger, refreshSession: (id) => refresh(state, id) },
                event.sessionID,
                event.id,
                { name },
                { title: name, output: event.result.content, metadata: event.result.metadata },
                event.input as Record<string, unknown>,
            )
        })
        await tool.transform((editor) => {
            editor.update("skill", (definition) => {
                definition.input = {
                    type: "object",
                    properties: {
                        id: { type: "string" },
                        force: {
                            type: "boolean",
                            description: "Reload the skill when it is already loaded.",
                        },
                    },
                    required: ["id"],
                    additionalProperties: false,
                }
            })
        })
        if (config.commands.enabled) {
            await command.transform((editor) => {
                editor.add({
                    name: "dcp",
                    description: "Show available DCP commands",
                    async execute(input) {
                        const sessionID = input.sessionID
                        const state = stateFor(sessionID)
                        let result: Awaited<ReturnType<typeof dispatchDcpCommand>> | undefined
                        await withSessionCoordinator(state, async () => {
                            const {
                                info,
                                isSubAgent,
                                messages: nativeMessages,
                            } = await loadNativeSession(sessionID)
                            const messages = await reconcileSessionHistory(
                                { state, logger, config },
                                sessionID,
                                nativeMessages,
                                async () => isSubAgent,
                            )
                            let rules = [...(info.permissions ?? [])]
                            if (info.agent) {
                                const agentInfo = await agent.get({ agentID: info.agent })
                                rules = [...(agentInfo.data.permissions ?? []), ...rules]
                            }
                            let effectivePermission = config.compress.permission
                            if (
                                effectivePermission !== "deny" &&
                                compressDisabledByNativeRules(rules)
                            ) {
                                effectivePermission = "deny"
                            }
                            state.compressPermission = effectivePermission
                            if (effectivePermission === "deny") return
                            const sendMessage: CommandSendMessage = async (text) => {
                                await sendDisplayOnlyMessage(sessionID, text)
                            }
                            result = await dispatchDcpCommand(
                                {
                                    state,
                                    config,
                                    logger,
                                    sessionId: sessionID,
                                    messages,
                                    workingDirectory: location.directory,
                                    sendMessage,
                                },
                                input.prompt.text,
                            )
                        })
                        if (!result?.generation) return
                        await session.prompt({
                            sessionID,
                            text: result.generation.prompt,
                            ...(input.prompt.files === undefined
                                ? {}
                                : { files: input.prompt.files }),
                            ...(input.prompt.agents === undefined
                                ? {}
                                : { agents: input.prompt.agents }),
                            ...(input.prompt.skills === undefined
                                ? {}
                                : { skills: input.prompt.skills }),
                            ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
                        })
                    },
                })
            })
        }
        if (config.compress.permission === "deny") return

        await tool.transform((editor) => {
            editor.add({
                name: "unload_skill",
                description: "Unload a loaded skill by name.",
                input: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string",
                            description: "Name of the loaded skill to unload.",
                        },
                    },
                    required: ["name"],
                    additionalProperties: false,
                },
                options: { codemode: false },
                async execute(input, toolContext) {
                    await assertPermission("unload_skill", toolContext)
                    const content = await unloadSkill(
                        operationContext(toolContext.sessionID, "unload_skill"),
                        toolContext.sessionID,
                        (input as { name: string }).name,
                    )
                    return { content }
                },
            })
            const messageMode = config.compress.mode === "message"
            editor.add({
                name: "compress",
                description: messageMode
                    ? renderCompressMessageDescription(prompts)
                    : renderCompressRangeDescription(prompts),
                input: {
                    type: "object",
                    properties: {
                        topic: { type: "string" },
                        content: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: messageMode
                                    ? {
                                          messageId: { type: "string" },
                                          topic: { type: "string" },
                                          summary: { type: "string" },
                                      }
                                    : {
                                          startId: { type: "string" },
                                          endId: { type: "string" },
                                          summary: { type: "string" },
                                      },
                                required: messageMode
                                    ? ["messageId", "topic", "summary"]
                                    : ["startId", "endId", "summary"],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ["topic", "content"],
                    additionalProperties: false,
                },
                options: { codemode: false },
                async execute(input, toolContext) {
                    await assertPermission("compress", toolContext)
                    const context: CompressionOperationContext = {
                        ...operationContext(toolContext.sessionID, "compress"),
                        fetchMessages: async (sessionID) =>
                            normalizeNativeHistory(await session.context({ sessionID }), sessionID),
                        reportCompressionStart: (title) => toolContext.progress({ title }),
                        protectTaskOutputs: false,
                    }
                    const content = messageMode
                        ? await compressMessages(
                              context,
                              identity(toolContext),
                              input as CompressMessageToolArgs,
                          )
                        : await compressRanges(
                              context,
                              identity(toolContext),
                              input as CompressRangeToolArgs,
                          )
                    return { content }
                },
            })
            editor.add({
                name: "enter_housekeeping",
                description: ENTER_HOUSEKEEPING_DESCRIPTION,
                input: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                },
                options: { codemode: false },
                async execute(_input, toolContext) {
                    await assertPermission("enter_housekeeping", toolContext)
                    const content = await enterHousekeeping(
                        operationContext(toolContext.sessionID, "enter_housekeeping"),
                        identity(toolContext),
                        fetchTodos,
                    )
                    return { content }
                },
            })
            editor.add({
                name: "edit_memo",
                description: EDIT_MEMO_DESCRIPTION,
                input: EDIT_MEMO_INPUT_SCHEMA,
                options: { codemode: false },
                async execute(input, toolContext) {
                    await assertPermission("edit_memo", toolContext)
                    const content = await editSessionMemo(
                        operationContext(toolContext.sessionID, "edit_memo"),
                        identity(toolContext),
                        input as Record<string, unknown>,
                    )
                    return { content }
                },
            })
            editor.add({
                name: "leave_housekeeping",
                description: LEAVE_HOUSEKEEPING_DESCRIPTION,
                input: {
                    type: "object",
                    properties: {
                        force: { type: "boolean" },
                    },
                    additionalProperties: false,
                },
                options: { codemode: false },
                async execute(input, toolContext) {
                    await assertPermission("leave_housekeeping", toolContext)
                    const content = await leaveHousekeeping(
                        operationContext(toolContext.sessionID, "leave_housekeeping"),
                        identity(toolContext),
                        input as { force?: boolean },
                        async (sessionID, transaction) => {
                            const messages = normalizeNativeHistory(
                                await session.context({ sessionID }),
                                sessionID,
                            )
                            const delivery: NotificationDelivery = {
                                sendMessage: (text) => sendDisplayOnlyMessage(sessionID, text),
                                showToast: async (toast) => {
                                    await toastRpc.events.emit("toast", {
                                        ...toast,
                                        sessionID,
                                        ...(location.workspaceID === undefined
                                            ? {}
                                            : { workspaceID: location.workspaceID }),
                                    })
                                },
                            }
                            await finalizeCompression(
                                { state: stateFor(sessionID), logger, config },
                                sessionID,
                                messages,
                                transaction.notifications ?? [],
                                transaction.batchTopic,
                                delivery,
                            )
                        },
                    )
                    return { content }
                },
            })
            editor.add({
                name: "read_memo",
                description: READ_MEMO_DESCRIPTION,
                input: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                },
                options: { codemode: false },
                async execute(_input, toolContext) {
                    await assertPermission("read_memo", toolContext)
                    const content = await readMemo(
                        operationContext(toolContext.sessionID, "read_memo"),
                        toolContext.sessionID,
                    )
                    return { content }
                },
            })
            editor.add({
                name: "recall_compressed",
                description: renderRecallCompressedDescription(prompts),
                input: RECALL_COMPRESSED_INPUT_SCHEMA,
                options: { codemode: false },
                async execute(input, toolContext) {
                    await assertPermission("recall_compressed", toolContext)
                    const content = await recallCompressed(
                        operationContext(toolContext.sessionID, "recall_compressed"),
                        toolContext.sessionID,
                        input as RecallCompressedInput,
                    )
                    return { content }
                },
            })
            editor.add({
                name: "fetch_summary_versions",
                description: FETCH_SUMMARY_VERSIONS_DESCRIPTION,
                input: {
                    type: "object",
                    required: ["blockId"],
                    properties: {
                        blockId: {
                            type: "number",
                            description: "Block ID to inspect (e.g. 3)",
                        },
                        version: {
                            type: "number",
                            description:
                                "Optional: return full text of this version (1=original, 2+=rewrite)",
                        },
                    },
                    additionalProperties: false,
                },
                options: { codemode: false },
                async execute(input, toolContext) {
                    await assertPermission("fetch_summary_versions", toolContext)
                    const content = await fetchSummaryVersions(
                        operationContext(toolContext.sessionID, "fetch_summary_versions"),
                        toolContext.sessionID,
                        input as FetchSummaryVersionsInput,
                    )
                    return { content }
                },
            })
            editor.add({
                name: "expand_block",
                description: EXPAND_BLOCK_DESCRIPTION,
                input: {
                    type: "object",
                    required: ["blockId", "endId"],
                    properties: {
                        blockId: {
                            type: "number",
                            description: "Block ID to expand (e.g. 1)",
                        },
                        endId: {
                            type: "string",
                            description: "Message ref for new end boundary (e.g. 'm0100')",
                        },
                    },
                    additionalProperties: false,
                },
                options: { codemode: false },
                async execute(input, toolContext) {
                    await assertPermission("expand_block", toolContext)
                    const content = await expandBlock(
                        operationContext(toolContext.sessionID, "expand_block"),
                        identity(toolContext),
                        input as ExpandBlockInput,
                    )
                    return { content }
                },
            })
            editor.add({
                name: "append_summary",
                description: APPEND_SUMMARY_DESCRIPTION,
                input: {
                    type: "object",
                    required: ["blockId", "text"],
                    properties: {
                        blockId: {
                            type: "number",
                            description: "Block ID (e.g. 1)",
                        },
                        text: {
                            type: "string",
                            description: "Text to append",
                        },
                    },
                    additionalProperties: false,
                },
                options: { codemode: false },
                async execute(input, toolContext) {
                    await assertPermission("append_summary", toolContext)
                    const content = await appendSummary(
                        operationContext(toolContext.sessionID, "append_summary"),
                        identity(toolContext),
                        input as AppendSummaryInput,
                    )
                    return { content }
                },
            })
            editor.add({
                name: "edit_summary",
                description: EDIT_SUMMARY_DESCRIPTION,
                input: {
                    type: "object",
                    required: ["blockId", "oldString", "newString"],
                    properties: {
                        blockId: {
                            type: "number",
                            description: "Block ID to edit (e.g. 1)",
                        },
                        oldString: {
                            type: "string",
                            description: "Text to find and replace (typically 2-3 lines)",
                        },
                        newString: {
                            type: "string",
                            description: "Replacement text",
                        },
                        replaceAll: {
                            type: "boolean",
                            description: "Replace all occurrences (default false)",
                        },
                    },
                    additionalProperties: false,
                },
                options: { codemode: false },
                async execute(input, toolContext) {
                    await assertPermission("edit_summary", toolContext)
                    const content = await editSummary(
                        operationContext(toolContext.sessionID, "edit_summary"),
                        identity(toolContext),
                        input as EditSummaryInput,
                    )
                    return { content }
                },
            })
            editor.add({
                name: "rewrite_summary",
                description: renderRewriteSummaryDescription(prompts),
                input: {
                    type: "object",
                    required: ["blockId", "summary"],
                    properties: {
                        blockId: {
                            type: "number",
                            description: "Block ID to rewrite (e.g. 1)",
                        },
                        summary: {
                            type: "string",
                            description: "The complete rewritten summary to save as a new version",
                        },
                    },
                    additionalProperties: false,
                },
                options: { codemode: false },
                async execute(input, toolContext) {
                    await assertPermission("rewrite_summary", toolContext)
                    const content = await rewriteSummary(
                        operationContext(toolContext.sessionID, "rewrite_summary"),
                        identity(toolContext),
                        input as RewriteSummaryInput,
                    )
                    return { content }
                },
            })
            editor.add({
                name: "toggle_summary_version",
                description: TOGGLE_SUMMARY_VERSION_DESCRIPTION,
                input: {
                    type: "object",
                    required: ["blockId", "version"],
                    properties: {
                        blockId: {
                            type: "number",
                            description: "Block ID whose summary version to switch (e.g. 3)",
                        },
                        version: {
                            type: "number",
                            description: "Target version: 0=disabled, 1=original, 2+=rewrite",
                        },
                    },
                    additionalProperties: false,
                },
                options: { codemode: false },
                async execute(input, toolContext) {
                    await assertPermission("toggle_summary_version", toolContext)
                    const content = await toggleSummaryVersion(
                        operationContext(toolContext.sessionID, "toggle_summary_version"),
                        identity(toolContext),
                        input as ToggleSummaryVersionInput,
                    )
                    return { content }
                },
            })
        })
    },
} satisfies Plugin.Plugin & { server: typeof server }

export default definition
