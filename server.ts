import server from "./index"
import { getConfig } from "./lib/config"
import { Logger } from "./lib/logger"
import { prepareModelContext, injectContextMemo, type ModelContextRequest } from "./lib/model-context"
import { renderContextMemo } from "./lib/memo"
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
    APPEND_SUMMARY_DESCRIPTION,
    appendSummary,
    type AppendSummaryInput,
} from "./lib/expand-block"
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
import {
    nativeSessionTodos,
    normalizeNativeHistory,
    type NativePermissionRule,
    type NativeSessionApi,
    type NativeSessionInfo,
    type NativeSessionMessage,
} from "./lib/native-session"

type SessionContextRequest = ModelContextRequest & {
    sessionID: string
    agent: string
    model?: { providerID?: string; id?: string }
    system: Array<{ type: "text"; text: string; cache?: unknown; metadata?: unknown }>
}

function compressDisabledByNativeRules(
    rules: ReadonlyArray<NativePermissionRule>,
): boolean {
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

function appendSystemGuidance(
    system: SessionContextRequest["system"],
    guidance: string,
): void {
    if (system.length === 0) {
        system.push({ type: "text", text: guidance })
        return
    }
    const index = system.length - 1
    const last = system[index]!
    system[index] = { ...last, text: `${last.text}\n\n${guidance}` }
}

interface NativeToolContext {
    sessionID: string
    messageID: string
    id: string
    agent: string
}

interface NativeToolDefinition {
    name: string
    description: string
    input: unknown
    options?: { codemode: boolean }
    execute(input: unknown, context: NativeToolContext): Promise<{ content: string }>
}

interface NativeToolEditor {
    add(definition: NativeToolDefinition): void
}

interface NativeToolExecuteEvent {
    tool: string
    sessionID: string
    messageID: string
    id: string
    agent: string
    input: unknown
}

interface NativePermissionInput {
    sessionID: string
    agent?: string
    action: string
    resources: string[]
    source: { type: "tool"; messageID: string; id: string }
}

interface HostContext {
    location: { directory: string }
    session: NativeSessionApi & {
        hook(
            name: "context",
            callback: (request: SessionContextRequest) => Promise<void>,
        ): Promise<unknown>
    }
    agent: {
        get(input: {
            agentID: string
        }): Promise<{
            location?: { directory?: string }
            data: { permissions?: ReadonlyArray<NativePermissionRule> }
        }>
    }
    permission: {
        assert(input: NativePermissionInput): Promise<void>
    }
    tool: {
        transform(callback: (editor: NativeToolEditor) => void): Promise<unknown>
        hook(
            name: "execute.before",
            callback: (event: NativeToolExecuteEvent) => Promise<void>,
        ): Promise<unknown>
    }
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

const definition = {
    id: "@architectural-composition/opencode-hyperdcp",
    server,
    setup: async ({ location, session, agent, permission, tool }: HostContext) => {
        const config = getConfig(location)
        if (!config.enabled) return
        const logger = new Logger(config.debug)
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
        const loadNativeSession = async (
            sessionID: string,
            toolName?: string,
        ) => {
            const info = await session.get({ sessionID })
            validateSessionInfo(info, sessionID)
            const isSubAgent = Boolean(info?.parentID)
            if (toolName && isSubAgent && !config.experimental.allowSubAgents)
                throw new Error(`${toolName} is unavailable in subagent sessions.`)
            const nativeMessages: NativeSessionMessage[] = await session.context({ sessionID })
            const messages = normalizeNativeHistory(nativeMessages, sessionID)
            return { info, isSubAgent, messages }
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
                const { info, isSubAgent, messages } = await loadNativeSession(request.sessionID)
                await initializeSessionState(
                    async () => isSubAgent,
                    state,
                    request.sessionID,
                    logger,
                    messages,
                    config.manualMode.enabled,
                )
                const agentInfo = await agent.get({ agentID: request.agent })
                const rules = [
                    ...(agentInfo.data.permissions ?? []),
                    ...(info.permissions ?? []),
                ]
                let effectivePermission = config.compress.permission
                if (
                    effectivePermission !== "deny" &&
                    compressDisabledByNativeRules(rules)
                ) {
                    effectivePermission = "deny"
                }
                state.compressPermission = effectivePermission
                const systemText = request.system
                    .map((part) => part.text)
                    .join("\n")
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
                prepareModelContext(request, history)
                const memoAllowed = !(state.isSubAgent && !config.experimental.allowSubAgents)
                injectContextMemo(
                    request,
                    memoAllowed && state.memo ? renderContextMemo(state.memo) : "",
                )
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
        })
        if (config.compress.permission === "deny") return

        await tool.transform((editor) => {
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
                        async () => {
                            throw new Error(
                                "Native notification delivery is not supported in this increment.",
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
        })
    },
}

export default definition
