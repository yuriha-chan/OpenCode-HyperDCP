import "./helpers/storage-env"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import server from "../index"
import nativeServerDefinition from "../server"
import { getSessionFilePath } from "../lib/paths"
import { readHousekeepingDraft } from "../lib/state/housekeeping-draft-store"
import type { SkillContext, WithParts } from "../lib/state"
import { RECALL_COMPRESSED, RECALL_FORMAT_EXTENSION } from "../lib/prompts/recall"
import { createSkillExecuteAfterHandler } from "../lib/skills"
import { HOUSEKEEPING_ENTRY_WITHOUT_COMPRESSION } from "../lib/housekeeping/history"
import { wrapCompressedSummary } from "../lib/summary-text"
import {
    commitBlock,
    createHousekeepingHarness,
    ordinaryMessage,
    stageBlock,
} from "./helpers/housekeeping"
import {
    compressDisabledByOpencode,
    hasExplicitToolPermission,
    resolveEffectiveCompressPermission,
} from "../lib/host-permissions"

async function createServerHooks(t: TestContext, permission = "allow") {
    const h = await createHousekeepingHarness(t)
    await mkdir(join(h.root, ".opencode"))
    await writeFile(
        join(h.root, ".opencode", "dcp.json"),
        JSON.stringify({
            enabled: true,
            autoUpdate: false,
            debug: false,
            compress: { permission },
            experimental: { customPrompts: false },
        }),
    )
    const hooks = await server({ client: h.client, directory: h.root } as any)
    return { h, hooks }
}

type NativeMessage = Record<string, any>

type NativePermissionRule = {
    action: string
    resource: string
    effect: "allow" | "ask" | "deny"
}

interface NativeHarnessOptions {
    root: string
    sessionID: string
    contextMessages?: NativeMessage[]
    sessionInfo?: Record<string, unknown>
    enabled?: boolean
    compressPermission?: "allow" | "ask" | "deny"
    compressMode?: "message" | "range"
    nudgeForce?: "strong" | "soft"
    maxContextLimit?: number | `${number}%`
    models?: Array<{ id: string; providerID: string; limit: { context: number } }>
    skills?: Array<{ id: string; name: string }>
    skillListError?: Error
    allowSubAgents?: boolean
    manualModeEnabled?: boolean
    customPrompts?: boolean
    commandsEnabled?: boolean
    commandSurface?: boolean
    pruneNotification?: "off" | "minimal" | "detailed"
    pruneNotificationType?: "chat" | "toast"
    showCompression?: boolean
    allowedTools?: string[]
    agentID?: string
    agentRules?: NativePermissionRule[]
    contextError?: Error
    getError?: Error
    agentError?: Error
    assertError?: Error
}

function nativeToolCallMessage(
    _sessionID: string,
    messageID: string,
    callID: string,
    name: string,
    input: Record<string, unknown>,
    options: {
        status?: "running" | "completed" | "error"
        text?: string
        metadata?: Record<string, unknown>
        created?: number
    } = {},
): NativeMessage {
    const created = options.created ?? 1
    const status = options.status ?? "completed"
    const state =
        status === "completed"
            ? {
                  status,
                  input,
                  content: [{ type: "text", text: options.text ?? "" }],
                  metadata: options.metadata ?? {},
              }
            : status === "error"
              ? {
                    status,
                    input,
                    error: { type: "unknown", message: options.text ?? "" },
                    metadata: options.metadata ?? {},
                }
              : { status, input, metadata: options.metadata ?? {} }
    return {
        id: messageID,
        type: "assistant",
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        content: [
            {
                type: "tool",
                id: callID,
                name,
                state,
                time: { created, ...(status === "running" ? {} : { completed: created + 1 }) },
            },
        ],
        time: { created },
    }
}

let nativeFixtureCounter = 0

function nextNativeFixtureSuffix(): string {
    nativeFixtureCounter += 1
    return String(nativeFixtureCounter)
}

function nativeFixtureMessages(sessionID: string): WithParts[] {
    return [
        ordinaryMessage(sessionID, "msg_source_1", "user", "Investigate the parser boundary."),
        ordinaryMessage(
            sessionID,
            "msg_source_2",
            "assistant",
            "The parser accepts an empty record.",
        ),
        ordinaryMessage(sessionID, "msg_source_3", "user", "Keep the newline constraint."),
        ordinaryMessage(sessionID, "msg_source_4", "assistant", "Use the documented parser API."),
    ]
}

function nativeToolPart(part: any): NativeMessage {
    const state = part.state ?? {}
    const time: Record<string, number> = { created: state.time?.start ?? 1 }
    if (state.time?.end !== undefined) time.completed = state.time.end
    if (state.status === "completed")
        return {
            type: "tool",
            id: part.callID,
            name: part.tool,
            state: {
                status: "completed",
                input: state.input ?? {},
                content: [{ type: "text", text: typeof state.output === "string" ? state.output : "" }],
            },
            time,
        }
    if (state.status === "error")
        return {
            type: "tool",
            id: part.callID,
            name: part.tool,
            state: {
                status: "error",
                input: state.input ?? {},
                error: { type: "unknown", message: String(state.error) },
            },
            time,
        }
    return {
        type: "tool",
        id: part.callID,
        name: part.tool,
        state: { status: "running", input: state.input ?? {}, metadata: {} },
        time,
    }
}

function toNativeHistory(messages: WithParts[]): NativeMessage[] {
    return messages.map((message) => {
        const created = message.info.time?.created ?? 1
        if (message.info.role === "user")
            return {
                id: message.info.id,
                type: "user",
                text: message.parts
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n"),
                time: { created },
            }
        const info = message.info as any
        return {
            id: message.info.id,
            type: "assistant",
            agent: info.agent ?? "assistant",
            model: {
                providerID: info.model?.providerID ?? "test",
                id: info.model?.modelID ?? "test",
            },
            content: message.parts.flatMap((part) => {
                if (part.type === "text") return [{ type: "text", text: part.text }]
                if (part.type === "reasoning") return [{ type: "reasoning", text: part.text }]
                if (part.type === "tool") return [nativeToolPart(part)]
                return []
            }),
            time: { created },
        }
    })
}

function nativeCompaction(
    status: "running" | "completed" | "failed",
    created: number,
): NativeMessage {
    const base = {
        id: `msg_compaction_${status}_${created}`,
        type: "compaction",
        status,
        reason: "auto",
        time: { created },
    }
    if (status === "failed")
        return { ...base, error: { type: "unknown", message: "compaction failed" } }
    return { ...base, summary: `${status} compaction summary` }
}

async function writeNativeConfig(
    root: string,
    options: Pick<
        NativeHarnessOptions,
        | "enabled"
        | "compressPermission"
        | "compressMode"
        | "nudgeForce"
        | "maxContextLimit"
        | "allowSubAgents"
        | "manualModeEnabled"
        | "customPrompts"
        | "commandsEnabled"
        | "pruneNotification"
        | "pruneNotificationType"
        | "showCompression"
        | "allowedTools"
    >,
): Promise<void> {
    await mkdir(join(root, ".opencode"), { recursive: true })
    await writeFile(
        join(root, ".opencode", "dcp.json"),
        JSON.stringify({
            enabled: options.enabled ?? true,
            autoUpdate: false,
            debug: false,
            ...(options.pruneNotification === undefined
                ? {}
                : { pruneNotification: options.pruneNotification }),
            ...(options.pruneNotificationType === undefined
                ? {}
                : { pruneNotificationType: options.pruneNotificationType }),
            commands: { enabled: options.commandsEnabled ?? true },
            compress: {
                permission: options.compressPermission ?? "allow",
                showCompression: options.showCompression ?? false,
                ...(options.compressMode ? { mode: options.compressMode, minCompressTokens: 0 } : {}),
                ...(options.nudgeForce ? { nudgeForce: options.nudgeForce, minContextLimit: 0 } : {}),
                ...(options.maxContextLimit !== undefined ? { maxContextLimit: options.maxContextLimit } : {}),
            },
            manualMode: { enabled: options.manualModeEnabled ?? false },
            housekeeping: { allowedTools: options.allowedTools ?? [] },
            experimental: {
                allowSubAgents: options.allowSubAgents ?? false,
                customPrompts: options.customPrompts ?? false,
            },
        }),
    )
}

async function createNativeHarness(t: TestContext, options: NativeHarnessOptions) {
    await writeNativeConfig(options.root, options)
    const definitions: any[] = []
    const hostSkillExecute = t.mock.fn(async () => ({ content: "Host skill output" }))
    if (options.skills) definitions.push({
        name: "skill", description: "Host skill loader", input: { hostSchema: true },
        execute: hostSkillExecute,
    })
    const listSkills = t.mock.fn(async (_input: { location: { directory: string } }) => {
        if (options.skillListError) throw options.skillListError
        return { location: { directory: options.root }, data: structuredClone(options.skills ?? []) }
    })
    const histories = new Map<string, NativeMessage[]>([
        [options.sessionID, structuredClone(options.contextMessages ?? [])],
    ])
    const sessionInfos = new Map<string, Record<string, unknown>>([
        [
            options.sessionID,
            structuredClone(options.sessionInfo ?? { id: options.sessionID, parentID: undefined }),
        ],
    ])
    let contextError = options.contextError
    let getError = options.getError
    let agentError = options.agentError
    let assertError = options.assertError
    let agentRules = structuredClone(
        options.agentRules ?? [
            { action: "*", resource: "*", effect: "allow" as const },
        ],
    )
    const context = t.mock.fn(async (input: { sessionID: string }) => {
        if (contextError) throw contextError
        return structuredClone(histories.get(input.sessionID) ?? [])
    })
    const get = t.mock.fn(async (input: { sessionID: string }) => {
        if (getError) throw getError
        return structuredClone(sessionInfos.get(input.sessionID) ?? { id: input.sessionID })
    })
    const getAgent = t.mock.fn(async (input: { agentID: string }) => {
        if (agentError) throw agentError
        return {
            location: { directory: options.root },
            data: {
                id: input.agentID,
                name: input.agentID,
                request: { settings: {}, headers: {}, body: {} },
                mode: "primary",
                hidden: false,
                permissions: structuredClone(agentRules),
            },
        }
    })
    const assertPermission = t.mock.fn(async (_input: unknown) => {
        if (assertError) throw assertError
    })
    const sessionHooks = new Map<string, (input: unknown) => unknown>()
    const hook = t.mock.fn(
        async (name: string, callback: (input: unknown) => unknown) => {
            sessionHooks.set(name, callback)
            return { dispose: async () => {} }
        },
    )
    const toolHooks = new Map<string, (input: any) => unknown>()
    const toolHook = t.mock.fn(
        async (name: string, callback: (input: unknown) => unknown) => {
            toolHooks.set(name, callback)
            return { dispose: async () => {} }
        },
    )
    const add = t.mock.fn((definition: any) => {
        definitions.push(definition)
    })
    const editor = {
        add,
        list: () => definitions,
        get: (id: string) => definitions.find((definition) => definition.name === id),
        remove: (id: string) => {
            const index = definitions.findIndex((definition) => definition.name === id)
            if (index >= 0) definitions.splice(index, 1)
        },
        update: (id: string, update: (definition: any) => void) => {
            const definition = definitions.find((entry) => entry.name === id)
            if (definition) update(definition)
        },
        namespace: () => {},
    }
    const transform = t.mock.fn(async (callback: (input: typeof editor) => void) => {
        callback(editor)
        return { dispose: async () => {} }
    })
    const commandDefinitions: any[] = []
    const commandAdd = t.mock.fn((definition: any) => {
        commandDefinitions.push(definition)
    })
    const commandTransform = t.mock.fn(
        async (callback: (input: { add: (definition: any) => void }) => void) => {
            callback({ add: commandAdd })
            return { dispose: async () => {} }
        },
    )
    const prompt = t.mock.fn(async (input: Record<string, unknown>) => ({
        id: String(input.id ?? "msg_native_prompt"),
        sessionID: String(input.sessionID),
        time: { created: 1 },
        type: "user",
        payload: {},
        delivery: input.delivery ?? "steer",
    }))
    const synthetic = t.mock.fn(async (input: Record<string, unknown>) => ({
        id: String(input.id ?? "msg_native_synthetic"),
        sessionID: String(input.sessionID),
        time: { created: 1 },
        type: "synthetic",
        payload: {},
        delivery: input.delivery ?? "steer",
    }))
    const rpcRegistrations: Array<{ definition: any; handlers: any }> = []
    const toastEvents: any[] = []
    const rpcRegister = t.mock.fn(async (definition: any, handlers: any) => {
        rpcRegistrations.push({ definition, handlers })
        return {
            dispose: async () => {},
            events: {
                emit: async (...args: any[]) => {
                    if (args[0] === "toast") toastEvents.push(args[1])
                },
            },
        }
    })
    const host = {
        location: { directory: options.root },
        session: {
            hook,
            context,
            get,
            ...(options.commandSurface ? { prompt, synthetic } : {}),
        },
        agent: { get: getAgent },
        model: { list: t.mock.fn(async (_input: { location: { directory: string } }) => ({
            location: { directory: options.root }, data: options.models ?? [],
        })) },
        permission: { assert: assertPermission },
        tool: { transform, hook: toolHook },
        command: { transform: commandTransform },
        skill: { list: listSkills },
        rpc: { register: rpcRegister },
    }
    await nativeServerDefinition.setup(host as any)
    const tool = (name: string) => definitions.find((definition) => definition.name === name)
    const requiredTool = (name: string) => {
        const definition = tool(name)
        assert.ok(definition, `${name} must be registered`)
        return definition
    }
    const command = (name = "dcp") =>
        commandDefinitions.find((definition) => definition.name === name)
    const requiredCommand = (name = "dcp") => {
        const definition = command(name)
        assert.ok(definition, `${name} command must be registered`)
        return definition
    }
    const runCommand = async (
        text: string,
        invocation: {
            sessionID?: string
            delivery?: "steer" | "queue"
            files?: unknown[]
            agents?: unknown[]
            skills?: unknown[]
        } = {},
    ) => {
        const definition = requiredCommand("dcp")
        const input = {
            sessionID: invocation.sessionID ?? options.sessionID,
            prompt: {
                text,
                ...(invocation.files === undefined ? {} : { files: invocation.files }),
                ...(invocation.agents === undefined ? {} : { agents: invocation.agents }),
                ...(invocation.skills === undefined ? {} : { skills: invocation.skills }),
            },
            delivery: invocation.delivery ?? "steer",
        }
        await definition.execute(input)
        return input
    }
    let callCounter = 0
    const progress = t.mock.fn(async (_update: Record<string, unknown>) => {})
    const execute = async (
        name: string,
        input: Record<string, unknown> = {},
        identity: {
            sessionID?: string
            messageID?: string
            callID?: string
            agent?: string
        } = {},
    ) => {
        const definition = requiredTool(name)
        callCounter += 1
        const toolContext = {
            sessionID: identity.sessionID ?? options.sessionID,
            messageID: identity.messageID ?? `msg_${name}_${callCounter}`,
            id: identity.callID ?? `call_${name}_${callCounter}`,
            agent: identity.agent ?? "assistant",
            signal: new AbortController().signal,
            progress,
        }
        const result = await definition.execute(input, toolContext)
        assert.equal(typeof result, "object", `${name} must return a native Tool.Result`)
        assert.equal(typeof result?.content, "string", `${name} must return textual content`)
        return name === "read_memo" ? result : result.content
    }
    const readMemo = async (
        input: Record<string, unknown> = {},
        identity: { sessionID?: string; messageID?: string; callID?: string } = {},
    ) =>
        execute("read_memo", input, {
            ...identity,
            messageID: identity.messageID ?? "msg_read_memo",
            callID: identity.callID ?? "call_read_memo",
        })
    const requireGuard = () => {
        const callback = toolHooks.get("execute.before")
        assert.ok(callback, "native execute.before guard must be registered")
        return callback
    }
    const guard = async (event: {
        tool: string
        input?: unknown
        sessionID?: string
        messageID?: string
        id?: string
        agent?: string
    }) => {
        const callback = requireGuard()
        callCounter += 1
        return callback({
            tool: event.tool,
            sessionID: event.sessionID ?? options.sessionID,
            messageID: event.messageID ?? `msg_guard_${callCounter}`,
            id: event.id ?? `call_guard_${callCounter}`,
            agent: event.agent ?? "assistant",
            input: event.input ?? {},
        })
    }
    const projectContext = async (request: {
        sessionID?: string
        agent?: string
        model?: { providerID: string; id: string }
        system?: Array<{ type: "text"; text: string; cache?: unknown; metadata?: unknown }>
        messages: Array<{ id?: string; content: readonly unknown[] }>
        options: { stop?: readonly string[] }
    }) => {
        const callback = sessionHooks.get("context")
        assert.ok(callback, "native session context hook must be registered")
        request.sessionID ??= options.sessionID
        request.agent ??= options.agentID ?? "assistant"
        request.model ??= { providerID: "test", id: "test" }
        request.system ??= []
        await callback(request)
        return request
    }
    return {
        host,
        definitions,
        hostSkillExecute,
        listSkills,
        tool,
        requiredTool,
        command,
        requiredCommand,
        runCommand,
        commandDefinitions,
        commandTransform,
        prompt,
        synthetic,
        rpcRegister,
        rpcRegistrations,
        toastEvents,
        execute,
        readMemo,
        guard,
        requireGuard,
        async afterTool(event: Record<string, unknown>) {
            const callback = toolHooks.get("execute.after")
            assert.ok(callback, "native skill execute.after must be registered")
            return callback({
                sessionID: options.sessionID,
                messageID: "msg_skill_load",
                id: "call_skill_load",
                agent: "assistant",
                ...event,
            })
        },
        projectContext,
        context,
        get,
        getAgent,
        assertPermission,
        progress,
        hook,
        toolHook,
        transform,
        setContext(messages: NativeMessage[]) {
            histories.set(options.sessionID, structuredClone(messages))
        },
        setContextFor(sessionID: string, messages: NativeMessage[]) {
            histories.set(sessionID, structuredClone(messages))
        },
        getContext(sessionID = options.sessionID) {
            return structuredClone(histories.get(sessionID) ?? [])
        },
        appendToolCall(
            messageID: string,
            callID: string,
            name: string,
            input: Record<string, unknown> = {},
            callOptions: {
                sessionID?: string
                status?: "running" | "completed" | "error"
                text?: string
                metadata?: Record<string, unknown>
                created?: number
            } = {},
        ) {
            const sessionID = callOptions.sessionID ?? options.sessionID
            const messages = histories.get(sessionID) ?? []
            messages.push(
                nativeToolCallMessage(sessionID, messageID, callID, name, input, callOptions),
            )
            histories.set(sessionID, messages)
        },
        setSessionInfo(info: Record<string, unknown>) {
            sessionInfos.set(options.sessionID, structuredClone(info))
        },
        setSessionInfoFor(sessionID: string, info: Record<string, unknown>) {
            sessionInfos.set(sessionID, structuredClone(info))
        },
        setContextError(error: Error | undefined) {
            contextError = error
        },
        setGetError(error: Error | undefined) {
            getError = error
        },
        setAgentRules(rules: NativePermissionRule[]) {
            agentRules = structuredClone(rules)
        },
        setAgentError(error: Error | undefined) {
            agentError = error
        },
        setAssertError(error: Error | undefined) {
            assertError = error
        },
    }
}

test("v2 subagent context observes running executions, persists steering and injects after skills", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.render()
    const file = getSessionFilePath(h.sessionID)
    const persisted = JSON.parse(await readFile(file, "utf8"))
    persisted.protectedSkills = [{ name: "Report", callId: "skill-original", input: { id: "report" }, title: "Report", output: "Skill instructions", metadata: {} }]
    await writeFile(file, JSON.stringify(persisted))
    const history = toNativeHistory(h.history)
    for (const [id, call] of [["msg_child_start", "call_start"], ["msg_child_steer", "call_steer"]]) {
        history.push({ id, sessionID: h.sessionID, type: "assistant", time: { created: 1 }, agent: "build", model: { id: "test", providerID: "test" }, content: [{ type: "tool", id: call, name: "subagent", time: { created: 1 }, state: { status: "completed", input: { description: "Investigate parser", prompt: "Check records", sessionID: "child-running" }, content: [{ type: "text", text: "Running" }], metadata: { sessionID: "child-running", status: "running" } } }] } as any)
    }
    const native = await createNativeHarness(t, { root: h.root, sessionID: h.sessionID, contextMessages: history })
    const request = { sessionID: h.sessionID, messages: [{ id: h.history[0]!.info.id, role: "user", content: [{ type: "text", text: "Continue" }] }], options: {} }
    await native.projectContext(request)
    const skillIndex = request.messages.findIndex(message => message.role === "tool")
    assert.ok(skillIndex >= 0)
    assert.match(JSON.stringify(request.messages[skillIndex + 1]), /session: child-running/)
    assert.match(JSON.stringify(request.messages[skillIndex + 1]), /status: running/)
    const entries = JSON.parse(await readFile(file, "utf8")).subagentExecutions
    assert.equal(entries.length, 1)
    assert.equal(entries[0].callingMessageId, "msg_child_start")
    assert.deepEqual(entries[0].steeringMessages, [{ messageId: "msg_child_steer", callId: "call_steer" }])
    await native.projectContext(request)
    assert.equal(request.messages.filter(message => JSON.stringify(message).includes("session: child-running")).length, 1)
})

test("v1 subagent context persists delivered foreground reports without child refresh", async (t) => {
    const h = await createHousekeepingHarness(t)
    h.config.experimental.allowSubAgents = true
    const history = structuredClone(h.history)
    history.push({ info: { ...history.find(message => message.info.role === "assistant")!.info, id: "msg_task_result" }, parts: [{ id: "part_task", messageID: "msg_task_result", sessionID: h.sessionID, type: "tool", callID: "call_task", tool: "task", state: { status: "completed", input: { description: "Investigate parser", prompt: "Check records" }, title: "Investigate parser", metadata: { sessionId: "child-completed" }, output: '<task id="child-completed" state="completed">\n<task_result>DELIVERED_FIRST</task_result>\n</task>', time: { start: 1, end: 2 } } }] } as any)
    h.setHistory(history)
    await h.render()
    const persisted = JSON.parse(await readFile(getSessionFilePath(h.sessionID), "utf8"))
    assert.equal(persisted.subagentExecutions.length, 1)
    assert.equal(persisted.subagentExecutions[0].report, "DELIVERED_FIRST")
    assert.equal(persisted.subagentExecutions[0].terminationMessageId, "msg_task_result")
    for (const call of h.client.session.messages.mock.calls) assert.deepEqual(call.arguments[0], { path: { id: h.sessionID } })
})

test("v2 protected skill context inserts paired records after memo without changing native arguments", async (t) => {
    const h = await createHousekeepingHarness(t)
    await seedCommittedMemo(h, { action: "append", textItems: ["Retain the constraint."] })
    const file = getSessionFilePath(h.sessionID)
    const persisted = JSON.parse(await readFile(file, "utf8"))
    const record = { name: "Report", callId: "call_original", input: { id: "report", force: true }, title: "Report", output: "Use concrete evidence.", metadata: { name: "Report" } }
    persisted.protectedSkills = [record]
    await writeFile(file, JSON.stringify(persisted))
    const native = await createNativeHarness(t, { root: h.root, sessionID: h.sessionID, contextMessages: toNativeHistory(h.history) })
    const source = [{ id: h.history[0]!.info.id, role: "user", content: [{ type: "text", text: "Continue" }] }]
    const original = structuredClone(source)
    const request = { sessionID: h.sessionID, messages: source, options: {} }
    await native.projectContext(request)
    assert.equal(request.messages[0]!.id, "msg_dcp_memo")
    const callMessage = request.messages[1] as any
    const resultMessage = request.messages[2] as any
    assert.equal(callMessage.role, "assistant")
    assert.equal(callMessage.content[0].type, "tool-call")
    assert.equal(callMessage.content[0].name, "skill")
    assert.deepEqual(callMessage.content[0].input, record.input)
    assert.equal(resultMessage.role, "tool")
    assert.equal(resultMessage.content[0].id, callMessage.content[0].id)
    assert.deepEqual(resultMessage.content[0].result, { type: "text", value: record.output })
    assert.deepEqual(source, original)
    const pair = structuredClone(request.messages.slice(1, 3))
    await native.projectContext(request)
    assert.deepEqual(request.messages.slice(1, 3), pair)
    assert.equal(request.messages.filter((message) => message.role === "tool").length, 1)
})

test("v2 protected skill context excludes loaded-only records and requires a user", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.render()
    const file = getSessionFilePath(h.sessionID)
    const persisted = JSON.parse(await readFile(file, "utf8"))
    const record = { name: "Report", callId: "call_original", input: { id: "report" }, title: "Report", output: "Use concrete evidence.", metadata: {} }
    persisted.loadedSkills = [record]
    await writeFile(file, JSON.stringify(persisted))
    const native = await createNativeHarness(t, { root: h.root, sessionID: h.sessionID, contextMessages: toNativeHistory(h.history) })
    const request = { sessionID: h.sessionID, messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }], options: {} }
    await native.projectContext(request)
    assert.doesNotMatch(JSON.stringify(request.messages), /Use concrete evidence/)
    persisted.protectedSkills = [record]
    await writeFile(file, JSON.stringify(persisted))
    const restored = await createNativeHarness(t, { root: h.root, sessionID: h.sessionID, contextMessages: toNativeHistory(h.history) })
    const noUser = { sessionID: h.sessionID, messages: [{ role: "assistant", content: [{ type: "text", text: "Thinking" }] }], options: {} }
    await restored.projectContext(noUser)
    assert.doesNotMatch(JSON.stringify(noUser.messages), /Use concrete evidence/)
})

test("v2 skill reload connects duplicate and force policy without replacing the host executor", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.render()
    const native = await createNativeHarness(t, {
        root: h.root, sessionID: h.sessionID, contextMessages: toNativeHistory(h.history),
        skills: [{ id: "report", name: "Report" }],
    })
    const definition = native.requiredTool("skill")
    assert.deepEqual(definition.input.required, ["id"])
    assert.equal(definition.input.properties.id.type, "string")
    assert.equal(definition.input.properties.force.type, "boolean")
    assert.equal(definition.execute, native.hostSkillExecute)
    const input = { id: "report" }
    await native.guard({ tool: "skill", input })
    await native.afterTool({ tool: "skill", input, status: "completed", result: {
        content: "Report body", metadata: { name: "Report", directory: "/skills/report" },
    } })
    await assert.rejects(native.guard({ tool: "skill", input }), /Skill "Report" is already loaded.*force=true/)
    assert.equal(JSON.parse(await readFile(getSessionFilePath(h.sessionID), "utf8")).loadedSkills.length, 1)
    await native.guard({ tool: "skill", input: { id: "report", force: true } })
    assert.deepEqual(JSON.parse(await readFile(getSessionFilePath(h.sessionID), "utf8")).loadedSkills, [])
    await native.afterTool({ tool: "skill", input: { id: "report", force: true }, status: "error", error: new Error("Reload failed") })
    assert.deepEqual(JSON.parse(await readFile(getSessionFilePath(h.sessionID), "utf8")).loadedSkills, [])
    assert.deepEqual(native.listSkills.mock.calls[0]!.arguments, [{ location: { directory: h.root } }])
    assert.deepEqual(input, { id: "report" })
})

test("v2 skill reload leaves unknown ids to the host and propagates inventory failures", async (t) => {
    const h = await createHousekeepingHarness(t)
    const native = await createNativeHarness(t, { root: h.root, sessionID: h.sessionID, skills: [] })
    await native.guard({ tool: "skill", input: { id: "missing" } })
    assert.equal(native.listSkills.mock.callCount(), 1)
    const broken = await createNativeHarness(t, {
        root: h.root, sessionID: h.sessionID, skills: [], skillListError: new Error("Skill inventory unavailable"),
    })
    await assert.rejects(broken.guard({ tool: "skill", input: { id: "report" } }), /Skill inventory unavailable/)
})

test("v2 skill load records native results and retains native arguments for unload", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.render()
    const native = await createNativeHarness(t, {
        root: h.root, sessionID: h.sessionID, contextMessages: toNativeHistory(h.history),
    })
    const input = { id: "report" }
    const result = {
        content: "Write the final report with concrete evidence.",
        output: { directory: "/skills/report", content: "Write the final report with concrete evidence." },
        metadata: { name: "Report", directory: "/skills/report" },
    }
    const original = structuredClone({ input, result })
    await native.afterTool({ tool: "skill", input, status: "completed", result })
    const persisted = JSON.parse(await readFile(getSessionFilePath(h.sessionID), "utf8"))
    assert.deepEqual(persisted.loadedSkills, [{
        name: "Report", callId: "call_skill_load", input: { id: "report" },
        title: "Report", output: result.content, metadata: result.metadata,
    }])
    assert.deepEqual({ input, result }, original)
    assert.equal(await native.execute("unload_skill", { name: "Report" }), 'Unloaded skill "Report".')
    assert.deepEqual(JSON.parse(await readFile(getSessionFilePath(h.sessionID), "utf8")).loadedSkills, [])
})

test("v2 skill load ignores failed and unrelated events and rejects malformed successful results", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.render()
    const native = await createNativeHarness(t, {
        root: h.root, sessionID: h.sessionID, contextMessages: toNativeHistory(h.history),
    })
    await native.afterTool({ tool: "skill", input: { id: "report" }, status: "error", error: new Error("Load failed") })
    await native.afterTool({ tool: "read", input: {}, status: "completed", result: { content: "Other output" } })
    assert.equal(native.get.mock.callCount(), 0)
    assert.equal(native.context.mock.callCount(), 0)
    await assert.rejects(native.afterTool({
        tool: "skill", input: { id: "report" }, status: "completed",
        result: { content: "Body without a skill name", metadata: {} },
    }), /skill name.*non-empty string/)
    assert.deepEqual(JSON.parse(await readFile(getSessionFilePath(h.sessionID), "utf8")).loadedSkills, [])
})

test("v2 unload_skill connects shared loaded-skill persistence", async (t) => {
    const sessionID = `ses_unload_wiring_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    await h.render()
    await createSkillExecuteAfterHandler(h.ctx)(
        { tool: "skill", sessionID: h.sessionID, callID: "call_load_parser", args: { name: "parser" } },
        { title: "Parser skill", output: "Check empty records.", metadata: {} },
    )
    const before = JSON.parse(await readFile(getSessionFilePath(h.sessionID), "utf8"))
    assert.equal(before.loadedSkills[0].name, "parser")
    const native = await createNativeHarness(t, {
        root: h.root, sessionID: h.sessionID, contextMessages: toNativeHistory(h.history),
    })
    const definition = native.requiredTool("unload_skill")
    assert.equal(definition.options.codemode, false)
    assert.deepEqual(definition.input.required, ["name"])
    assert.equal(definition.input.properties.name.type, "string")
    assert.equal(definition.input.additionalProperties, false)
    await assert.rejects(native.execute("unload_skill", { name: "" }), /non-empty string/)
    assert.equal(await native.execute("unload_skill", { name: "parser" }), 'Unloaded skill "parser".')
    const after = JSON.parse(await readFile(getSessionFilePath(h.sessionID), "utf8"))
    assert.deepEqual(after.loadedSkills, [])
    assert.deepEqual(after.protectedSkills, before.protectedSkills)
    await assert.rejects(native.execute("unload_skill", { name: "parser" }), /not loaded/)
    assert.deepEqual(JSON.parse(await readFile(getSessionFilePath(h.sessionID), "utf8")).loadedSkills, [])
})

test("v2 unload_skill checks native permission before session reads", async (t) => {
    const h = await createHousekeepingHarness(t)
    const native = await createNativeHarness(t, { root: h.root, sessionID: h.sessionID })
    native.requiredTool("unload_skill")
    native.setAssertError(new Error("Unload permission rejected"))
    await assert.rejects(native.execute("unload_skill", { name: "parser" }, {
        messageID: "msg_unload_denied", callID: "call_unload_denied",
    }), /Unload permission rejected/)
    assert.equal(native.get.mock.callCount(), 0)
    assert.equal(native.context.mock.callCount(), 0)
    assert.equal(native.assertPermission.mock.calls[0]!.arguments[0].action, "unload_skill")
    assert.deepEqual(native.assertPermission.mock.calls[0]!.arguments[0].source, {
        type: "tool", messageID: "msg_unload_denied", id: "call_unload_denied",
    })
})

for (const mode of ["message", "range"] as const) {
    test(`v2 compress wires ${mode} mode to staged DCP blocks`, async (t) => {
        const sessionID = `ses_compress_wiring_${randomUUID()}`
        const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
        const native = await createNativeHarness(t, {
            root: h.root,
            sessionID: h.sessionID,
            contextMessages: toNativeHistory(h.history),
            compressMode: mode,
        })
        const definition = native.requiredTool("compress")
        assert.equal(native.definitions.filter((entry) => entry.name === "compress").length, 1)
        assert.equal(definition.options.codemode, false)
        assert.deepEqual([...definition.input.required].sort(), ["content", "topic"])
        const item = definition.input.properties.content.items
        assert.deepEqual([...item.required].sort(), mode === "message"
            ? ["messageId", "summary", "topic"] : ["endId", "startId", "summary"])
        native.appendToolCall("msg_wiring_enter", "call_wiring_enter", "enter_housekeeping", {}, { status: "running" })
        await native.execute("enter_housekeeping", {}, { messageID: "msg_wiring_enter", callID: "call_wiring_enter" })
        const input = {
            topic: "Parser investigation",
            content: mode === "message"
                ? [{ messageId: "m0002", topic: "Parser finding", summary: "The parser accepts empty records." }]
                : [{ startId: "m0001", endId: "m0002", summary: "The parser accepts empty records." }],
        }
        native.appendToolCall("msg_wiring_compress", "call_wiring_compress", "compress", input, { status: "running" })
        const result = await native.execute("compress", input, { messageID: "msg_wiring_compress", callID: "call_wiring_compress" })
        assert.match(result, /Staged/)
        const persisted = JSON.parse(await readFile(getSessionFilePath(h.sessionID), "utf8"))
        const draft = await readHousekeepingDraft(h.sessionID, persisted.housekeeping.draftRef)
        const blocks = [...draft.prune.messages.blocksById.values()]
        assert.equal(blocks.length, 1)
        assert.deepEqual(blocks[0]!.effectiveMessageIds, mode === "message"
            ? ["msg_source_2"] : ["msg_source_1", "msg_source_2"])
        assert.match(JSON.stringify(blocks[0]), /The parser accepts empty records\./)
        assert.equal(blocks[0]!.compressMessageId, "msg_wiring_compress")
        assert.equal(blocks[0]!.compressCallId, "call_wiring_compress")
        assert.equal(persisted.housekeeping.operationRecords.at(-1).callId, "call_wiring_compress")
        assert.ok(native.progress.mock.calls.some((call) => typeof call.arguments[0]?.title === "string"))
        assert.equal(Object.keys(persisted.prune.messages.blocksById).length, 0)
    })
}

test("v2 compress checks native permission before session reads", async (t) => {
    const h = await createHousekeepingHarness(t)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        compressMode: "range",
        assertError: new Error("compression denied"),
    })
    native.requiredTool("compress")
    await assert.rejects(native.execute("compress", {}, {
        messageID: "msg_compress_denied", callID: "call_compress_denied",
    }), /compression denied/)
    assert.equal(native.context.mock.callCount(), 0)
    assert.equal(native.get.mock.callCount(), 0)
    assert.deepEqual(native.assertPermission.mock.calls[0]?.arguments, [{
        sessionID: h.sessionID, agent: "assistant", action: "compress", resources: ["*"],
        source: { type: "tool", messageID: "msg_compress_denied", id: "call_compress_denied" },
    }])
})

async function seedCommittedMemo(
    h: Awaited<ReturnType<typeof createHousekeepingHarness>>,
    edit: Record<string, unknown>,
): Promise<void> {
    const suffix = nextNativeFixtureSuffix()
    await h.run(
        "enter_housekeeping",
        {},
        { messageID: `msg_enter_${suffix}`, callID: `call_enter_${suffix}` },
    )
    await h.run("edit_memo", edit, {
        messageID: `msg_edit_${suffix}`,
        callID: `call_edit_${suffix}`,
    })
    await h.run(
        "leave_housekeeping",
        { force: true },
        { messageID: `msg_leave_${suffix}`, callID: `call_leave_${suffix}` },
    )
}

async function seedCompressedMemoFixture(
    h: Awaited<ReturnType<typeof createHousekeepingHarness>>,
): Promise<NativeMessage[]> {
    const committed = nextNativeFixtureSuffix()
    await h.run(
        "enter_housekeeping",
        {},
        { messageID: `msg_enter_${committed}`, callID: `call_enter_${committed}` },
    )
    await h.run(
        "compress",
        {
            topic: "Parser",
            content: [{ startId: "m0001", endId: "m0002", summary: "Parser findings." }],
        },
        { messageID: `msg_compress_${committed}`, callID: `call_compress_${committed}` },
    )
    await h.run(
        "edit_memo",
        { action: "append", textItems: ["Committed memo."] },
        { messageID: `msg_edit_${committed}`, callID: `call_edit_${committed}` },
    )
    await h.run(
        "leave_housekeeping",
        {},
        { messageID: `msg_leave_${committed}`, callID: `call_leave_${committed}` },
    )
    const staged = nextNativeFixtureSuffix()
    await h.run(
        "enter_housekeeping",
        {},
        { messageID: `msg_enter_${staged}`, callID: `call_enter_${staged}` },
    )
    await h.run(
        "edit_memo",
        { action: "append", textItems: ["Staged memo."] },
        { messageID: `msg_edit_${staged}`, callID: `call_edit_${staged}` },
    )
    return toNativeHistory(h.history)
}

async function seedVersionedSummaryFixture(
    h: Awaited<ReturnType<typeof createHousekeepingHarness>>,
    options: {
        original?: string
        committedRewrites?: string[]
        stagedRewrite?: string
        stagedAppend?: string
    } = {},
): Promise<NativeMessage[]> {
    const suffix = nextNativeFixtureSuffix()
    await h.run(
        "enter_housekeeping",
        {},
        { messageID: `msg_versions_enter_${suffix}`, callID: `call_versions_enter_${suffix}` },
    )
    await h.run(
        "compress",
        {
            topic: "Parser",
            content: [
                {
                    startId: "m0001",
                    endId: "m0002",
                    summary: options.original ?? "Original parser findings.",
                },
            ],
        },
        {
            messageID: `msg_versions_compress_${suffix}`,
            callID: `call_versions_compress_${suffix}`,
        },
    )
    for (const [index, rewrite] of (options.committedRewrites ?? []).entries()) {
        await h.run(
            "rewrite_summary",
            { blockId: 1, summary: rewrite },
            {
                messageID: `msg_versions_rewrite_${suffix}_${index}`,
                callID: `call_versions_rewrite_${suffix}_${index}`,
            },
        )
    }
    await h.run(
        "leave_housekeeping",
        { force: true },
        {
            messageID: `msg_versions_leave_${suffix}`,
            callID: `call_versions_leave_${suffix}`,
        },
    )
    if (options.stagedRewrite !== undefined || options.stagedAppend !== undefined) {
        await h.run(
            "enter_housekeeping",
            {},
            {
                messageID: `msg_versions_stage_enter_${suffix}`,
                callID: `call_versions_stage_enter_${suffix}`,
            },
        )
        if (options.stagedRewrite !== undefined) {
            await h.run(
                "rewrite_summary",
                { blockId: 1, summary: options.stagedRewrite },
                {
                    messageID: `msg_versions_stage_rewrite_${suffix}`,
                    callID: `call_versions_stage_rewrite_${suffix}`,
                },
            )
        }
        if (options.stagedAppend !== undefined) {
            await h.run(
                "append_summary",
                { blockId: 1, text: options.stagedAppend },
                {
                    messageID: `msg_versions_stage_append_${suffix}`,
                    callID: `call_versions_stage_append_${suffix}`,
                },
            )
        }
    }
    return toNativeHistory(h.history)
}

test("v2 message references allocate only selected sources and annotate split tool results", async (t) => {
    const sessionID = `ses_refs_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(`ses_fixture_${randomUUID()}`) })
    const native = await createNativeHarness(t, {
        root: h.root, sessionID,
        contextMessages: toNativeHistory(nativeFixtureMessages(sessionID)),
    })
    const source = [
        { id: "msg_source_3", role: "user", content: [{ type: "text", text: "Selected user" }] },
        { id: "msg_source_4", role: "assistant", content: [{ type: "tool-call", id: "call_refs", name: "read", input: { path: "file" } }] },
        { role: "tool", content: [{ type: "tool-result", id: "call_refs", result: { type: "text", value: "Read output" } }] },
    ]
    const before = structuredClone(source)
    const request = { sessionID, messages: source, options: {} }
    await native.projectContext(request)
    assert.match(JSON.stringify(request.messages[0]), /m0001/)
    assert.match(JSON.stringify(request.messages[2]), /m0002/)
    assert.deepEqual(request.messages[1], source[1])
    assert.deepEqual(source, before)
    const persisted = JSON.parse(await readFile(getSessionFilePath(sessionID), "utf-8"))
    assert.doesNotMatch(JSON.stringify(persisted.messageIds), /msg_source_1|msg_source_2/)
    assert.match(JSON.stringify(persisted.messageIds), /msg_source_3/)
    const replay = { sessionID, messages: structuredClone(source), options: {} }
    await native.projectContext(replay)
    assert.deepEqual(replay.messages, request.messages)
})

for (const compressMode of ["message", "range"] as const) {
    test(`v2 message priorities connect shared policy in ${compressMode} mode`, async (t) => {
        const sessionID = `ses_priorities_${randomUUID()}`
        const h = await createHousekeepingHarness(t, {
            messages: nativeFixtureMessages(`ses_fixture_${randomUUID()}`),
        })
        const native = await createNativeHarness(t, {
            root: h.root,
            sessionID,
            compressMode,
            contextMessages: toNativeHistory(nativeFixtureMessages(sessionID)),
        })
        const source = [
            { id: "msg_source_3", role: "user", content: [{ type: "text", text: "Selected user" }] },
            { id: "msg_source_4", role: "assistant", content: [{ type: "tool-call", id: "call_priority", name: "read", input: {} }] },
            { role: "tool", content: [{ type: "tool-result", id: "call_priority", result: { type: "text", value: "Read output" } }] },
        ]
        const before = structuredClone(source)
        const request = { sessionID, messages: source, options: {} }
        await native.projectContext(request)
        for (const index of [0, 2]) {
            if (compressMode === "message") assert.match(JSON.stringify(request.messages[index]), /priority=\\"low\\"/)
            else assert.doesNotMatch(JSON.stringify(request.messages[index]), /priority=/)
        }
        assert.deepEqual(source, before)
    })
}

for (const limit of [1000, 2000, undefined]) {
    test(`v2 model context limit connects percentage nudge policy for ${limit ?? "missing model"}`, async (t) => {
        const sessionID = `ses_model_limit_${randomUUID()}`
        const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(`ses_fixture_${randomUUID()}`) })
        const directory = join(h.root, ".opencode", "dcp-prompts", "overrides")
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, "context-limit-nudge.md"), "Close the parser work before continuing.")
        const history = toNativeHistory(nativeFixtureMessages(sessionID))
        history.find((message) => message.id === "msg_source_2")!.tokens = {
            input: 500, output: 100, reasoning: 0, cache: { read: 0, write: 0 },
        }
        const native = await createNativeHarness(t, {
            root: h.root, sessionID, contextMessages: history, customPrompts: true,
            nudgeForce: "strong", maxContextLimit: "50%",
            models: [
                { id: "test", providerID: "other", limit: { context: 100 } },
                ...(limit === undefined ? [] : [{ id: "test", providerID: "test", limit: { context: limit } }]),
            ],
        })
        const request = { sessionID, messages: [
            { id: "msg_source_1", role: "user", content: [{ type: "text", text: "First user" }] },
            { id: "msg_source_2", role: "assistant", content: [{ type: "text", text: "Assistant reply" }] },
            { id: "msg_source_3", role: "user", content: [{ type: "text", text: "Next user" }] },
        ], options: {} }
        await native.projectContext(request)
        if (limit === 1000) assert.match(JSON.stringify(request.messages), /Close the parser work before continuing/)
        else assert.doesNotMatch(JSON.stringify(request.messages), /Close the parser work before continuing/)
        assert.deepEqual(native.host.model.list.mock.calls[0]?.arguments, [{ location: { directory: h.root } }])
    })
}

for (const variant of ["strong", "soft", "manual", "denied"] as const) {
    test(`v2 nudges connect shared turn policy in ${variant} mode`, async (t) => {
        const sessionID = `ses_nudges_${randomUUID()}`
        const h = await createHousekeepingHarness(t, {
            messages: nativeFixtureMessages(`ses_fixture_${randomUUID()}`),
        })
        const overrideDirectory = join(h.root, ".opencode", "dcp-prompts", "overrides")
        await mkdir(overrideDirectory, { recursive: true })
        await writeFile(join(overrideDirectory, "turn-nudge.md"), "Remember the closed parser work.")
        const native = await createNativeHarness(t, {
            root: h.root, sessionID, customPrompts: true,
            nudgeForce: variant === "soft" ? "soft" : "strong",
            manualModeEnabled: variant === "manual",
            compressPermission: variant === "denied" ? "deny" : "allow",
            contextMessages: toNativeHistory(nativeFixtureMessages(sessionID)),
        })
        const source = [
            { id: "msg_source_1", role: "user", content: [{ type: "text", text: "First user" }] },
            { id: "msg_source_2", role: "assistant", content: [{ type: "tool-call", id: "call_nudge", name: "read", input: {} }] },
            { role: "tool", content: [{ type: "tool-result", id: "call_nudge", result: { type: "text", value: "Read output" } }] },
            { id: "msg_source_3", role: "user", content: [{ type: "text", text: "Next user" }] },
        ]
        const before = structuredClone(source)
        const request = { sessionID, messages: source, options: {} }
        await native.projectContext(request)
        const target = variant === "soft" ? 1 : 3
        if (variant === "strong" || variant === "soft") {
            assert.match(JSON.stringify(request.messages[target]), /Remember the closed parser work\./)
            assert.equal(JSON.stringify(request.messages).match(/Remember the closed parser work\./g)?.length, 1)
        } else assert.doesNotMatch(JSON.stringify(request.messages), /Remember the closed parser work/)
        const assistant = request.messages[1]
        assert.deepEqual(assistant.content.find((part) => part.type === "tool-call"), before[1].content[0])
        assert.deepEqual(source, before)
        const replay = { sessionID, messages: structuredClone(request.messages), options: {} }
        await native.projectContext(replay)
        assert.equal(
            JSON.stringify(replay.messages).match(/Remember the closed parser work\./g)?.length ?? 0,
            variant === "strong" || variant === "soft" ? 1 : 0,
        )
    })
}

test("v2 message references suppress annotation for denied compression and active housekeeping", async (t) => {
    const sessionID = `ses_refs_suppressed_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const source = [{ id: "msg_source_1", role: "user", content: [{ type: "text", text: "Keep user" }] }]
    const denied = await createNativeHarness(t, {
        root: h.root, sessionID, compressPermission: "deny", contextMessages: toNativeHistory(h.history),
    })
    const request = { sessionID, messages: structuredClone(source), options: {} }
    await denied.projectContext(request)
    assert.deepEqual(request.messages, source)
    await h.enter()
    const active = await createNativeHarness(t, { root: h.root, sessionID, contextMessages: toNativeHistory(h.history) })
    const activeRequest = { sessionID, messages: structuredClone(source), options: {} }
    await active.projectContext(activeRequest)
    assert.deepEqual(activeRequest.messages, source)
})

test("v2 block projection replaces committed coverage and keeps split tool results paired", async (t) => {
    const sessionID = `ses_projection_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    await seedCommittedMemo(h, { action: "append", textItems: ["Keep the final constraint."] })
    const contextMessages = await seedVersionedSummaryFixture(h, {
        original: "Original findings.",
        committedRewrites: ["Selected committed findings."],
    })
    const native = await createNativeHarness(t, { root: h.root, sessionID, contextMessages })
    const source = [
        { id: "msg_source_1", role: "user", content: [{ type: "text", text: "Original user text" }] },
        { id: "msg_source_2", role: "assistant", content: [
            { type: "text", text: "Original assistant text" },
            { type: "tool-call", id: "call_covered", name: "read", input: {} },
        ] },
        { role: "tool", content: [{ type: "tool-result", id: "call_covered", result: { type: "text", value: "Covered output" } }] },
        { id: "msg_source_3", role: "user", content: [{ type: "text", text: "Keep this user" }] },
        { id: "msg_source_4", role: "assistant", content: [{ type: "tool-call", id: "call_kept", name: "read", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", id: "call_kept", result: { type: "text", value: "Keep output" } }] },
    ]
    const before = structuredClone(source)
    const request = { sessionID, messages: source, options: {} }
    await native.projectContext(request)
    assert.equal(request.messages.length, 5)
    assert.equal(request.messages[0].role, "user")
    assert.deepEqual(request.messages[0].content, [{ type: "text", text: wrapCompressedSummary(1, "Selected committed findings.", "m0001-m0002") }])
    assert.equal(request.messages[1].id, "msg_dcp_memo")
    assert.match(JSON.stringify(request.messages[1]), /Keep the final constraint/)
    assert.match(JSON.stringify(request.messages[2]), /Keep this user/)
    assert.match(JSON.stringify(request.messages[2]), /m0003/)
    assert.equal(request.messages[3], source[4])
    assert.match(JSON.stringify(request.messages[4]), /Keep output/)
    assert.match(JSON.stringify(request.messages[4]), /m0004/)
    assert.deepEqual(source, before)
})

test("v2 block projection keeps draft rewrites private and requires a selected anchor", async (t) => {
    const sessionID = `ses_projection_draft_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h, {
        original: "Committed summary.", stagedRewrite: "Private draft summary.",
    })
    const native = await createNativeHarness(t, { root: h.root, sessionID, contextMessages })
    const source = [
        { id: "msg_source_1", role: "user", content: [{ type: "text", text: "First" }] },
        { id: "msg_source_2", role: "assistant", content: [{ type: "text", text: "Second" }] },
        { id: "msg_source_3", role: "user", content: [{ type: "text", text: "Keep" }] },
    ]
    const committed = await persistedBlock(sessionID)
    const request = { sessionID, messages: source, options: {} }
    await native.projectContext(request)
    assert.deepEqual(request.messages[0].content, [{ type: "text", text: committed.summary }])
    assert.doesNotMatch(JSON.stringify(request), /Private draft summary/)
    const noAnchor = { sessionID, messages: [source[2]], options: {} }
    await native.projectContext(noAnchor)
    assert.deepEqual(noAnchor.messages, [source[2]])
})

async function persistedBlock(sessionID: string): Promise<any> {
    const fixture = JSON.parse(await readFile(getSessionFilePath(sessionID), "utf-8")) as any
    return Object.values(fixture?.prune?.messages?.blocksById ?? {})[0]
}

async function persistedBlockVersion(sessionID: string): Promise<number | undefined> {
    const fixture = JSON.parse(await readFile(getSessionFilePath(sessionID), "utf-8")) as any
    return Object.values(fixture?.prune?.messages?.blocksById ?? {})[0]?.activeVersionIndex
}

function toolExecutionContext(h: { root: string; sessionID: string }, callID: string) {
    return {
        sessionID: h.sessionID,
        messageID: `message-${callID}`,
        callID,
        agent: "assistant",
        directory: h.root,
        worktree: h.root,
        abort: new AbortController().signal,
        ask: async () => {},
        metadata(_value: unknown) {},
    }
}

async function readPersistedSkillState(h: {
    sessionID: string
}): Promise<{ loadedSkills: SkillContext[]; protectedSkills: SkillContext[] }> {
    try {
        const payload = JSON.parse(await readFile(getSessionFilePath(h.sessionID), "utf-8")) as {
            loadedSkills?: SkillContext[]
            protectedSkills?: SkillContext[]
        }
        return {
            loadedSkills: payload.loadedSkills ?? [],
            protectedSkills: payload.protectedSkills ?? [],
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return { loadedSkills: [], protectedSkills: [] }
        throw error
    }
}

test("server registers housekeeping boundaries and the host execution guard, and abolishes save_summary", async (t) => {
    const { hooks } = await createServerHooks(t)
    assert.equal(typeof hooks.tool?.enter_housekeeping?.execute, "function")
    assert.equal(typeof hooks.tool?.leave_housekeeping?.execute, "function")
    assert.equal(typeof hooks["tool.execute.before"], "function")
    assert.equal(hooks.tool?.save_summary, undefined)
    for (const name of [
        "compress",
        "edit_memo",
        "read_memo",
        "rewrite_summary",
        "expand_block",
        "edit_summary",
        "append_summary",
        "toggle_summary_version",
        "fetch_summary_versions",
        "recall_compressed",
    ]) {
        assert.equal(typeof hooks.tool?.[name]?.execute, "function", name)
    }
})

test("server publishes boundary tools as primary tools and uses leave instead of save_summary", async (t) => {
    const { hooks } = await createServerHooks(t)
    const config: any = { experimental: { primary_tools: ["read"] } }
    await hooks.config!(config)
    assert.ok(config.experimental.primary_tools.includes("read"))
    assert.ok(config.experimental.primary_tools.includes("enter_housekeeping"))
    assert.ok(config.experimental.primary_tools.includes("leave_housekeeping"))
    assert.ok(!config.experimental.primary_tools.includes("save_summary"))
    assert.equal(config.permission.save_summary, undefined)
    assert.equal(config.permission.enter_housekeeping, "allow")
    assert.equal(config.permission.leave_housekeeping, "allow")
})

for (const permission of ["ask", "deny"]) {
    test(`server preserves explicit ${permission} permission for both housekeeping boundaries`, async (t) => {
        const { hooks } = await createServerHooks(t)
        const config: any = {
            permission: { enter_housekeeping: permission, leave_housekeeping: permission },
        }
        await hooks.config!(config)
        assert.equal(config.permission.enter_housekeeping, permission)
        assert.equal(config.permission.leave_housekeeping, permission)
        assert.equal(config.permission.save_summary, undefined)
    })
}

test("initially denied compression does not publish an entry tool that enables mutations", async (t) => {
    const { hooks } = await createServerHooks(t, "deny")
    assert.equal(hooks.tool?.compress, undefined)
    assert.equal(hooks.tool?.enter_housekeeping, undefined)
    const config: any = {}
    await hooks.config!(config)
    assert.ok(!(config.experimental?.primary_tools ?? []).includes("enter_housekeeping"))
    assert.equal(hooks.tool?.save_summary, undefined)
})

test("server definition hook adds force to the native skill schema without altering native inputs", async (t) => {
    const { hooks } = await createServerHooks(t)
    const define = hooks["tool.definition"] as any
    assert.equal(typeof define, "function")

    const parameters = { native: { marker: "skill-parameters" } }
    const output: any = {
        description: "Load a native skill",
        parameters,
        jsonSchema: {
            type: "object",
            properties: { name: { type: "string", description: "Native skill name" } },
            required: ["name"],
            additionalProperties: false,
        },
    }

    await define({ toolID: "skill" }, output)

    assert.equal(output.description, "Load a native skill")
    assert.equal(output.parameters, parameters)
    assert.equal(output.jsonSchema.properties.name.type, "string")
    assert.equal(output.jsonSchema.properties.force.type, "boolean")
    assert.equal(output.jsonSchema.required.includes("name"), true)
    assert.equal(output.jsonSchema.required.includes("force"), false)

    const unrelated: any = {
        description: "Read a file",
        parameters: { read: true },
        jsonSchema: { type: "object", properties: { path: { type: "string" } } },
    }
    const snapshot = structuredClone(unrelated)
    await define({ toolID: "read" }, unrelated)
    assert.deepEqual(unrelated, snapshot)
})

test("server skill lifecycle persists a load and rejects a duplicate before the native runner", async (t) => {
    const { h, hooks } = await createServerHooks(t)
    const before = hooks["tool.execute.before"]!
    const after = hooks["tool.execute.after"]
    assert.equal(typeof after, "function")
    assert.equal(typeof hooks.tool?.unload_skill?.execute, "function")

    const args = { name: "demo" }
    let nativeCalls = 0
    await before({ tool: "skill", sessionID: h.sessionID, callID: "load-demo" }, { args })
    assert.deepEqual((await readPersistedSkillState(h)).loadedSkills, [])

    const nativeResult = await (async () => {
        nativeCalls += 1
        return {
            title: "Load demo",
            output: "Native skill body",
            metadata: { name: "demo", dir: "/skills/demo" },
        }
    })()
    await after!(
        { tool: "skill", sessionID: h.sessionID, callID: "load-demo", args },
        {
            title: nativeResult.title,
            output: nativeResult.output,
            metadata: nativeResult.metadata,
        },
    )

    assert.equal(nativeCalls, 1)
    const persisted = await readPersistedSkillState(h)
    assert.deepEqual(
        persisted.loadedSkills.map((record) => record.name),
        ["demo"],
    )
    assert.equal(persisted.loadedSkills[0]!.callId, "load-demo")
    assert.equal(persisted.loadedSkills[0]!.output, "Native skill body")
    assert.deepEqual(persisted.protectedSkills, [])

    await assert.rejects(
        before(
            { tool: "skill", sessionID: h.sessionID, callID: "duplicate" },
            { args: { name: "demo" } },
        ),
        /already|loaded|force/i,
    )
    assert.equal(nativeCalls, 1)

    const status = await hooks.tool!.unload_skill!.execute(
        { name: "demo" } as any,
        toolExecutionContext(h, "unload-demo") as any,
    )
    assert.equal(typeof status, "string")
    assert.ok(status.length > 0)
    const afterUnload = await readPersistedSkillState(h)
    assert.deepEqual(afterUnload.loadedSkills, [])
    assert.deepEqual(afterUnload.protectedSkills, [])
})

test("server composes the housekeeping guard before the native skill lifecycle", async (t) => {
    const { h, hooks } = await createServerHooks(t)
    const before = hooks["tool.execute.before"]!
    const after = hooks["tool.execute.after"]
    assert.equal(typeof after, "function")

    const args = { name: "demo" }
    await before({ tool: "skill", sessionID: h.sessionID, callID: "load-demo" }, { args })
    await after!(
        { tool: "skill", sessionID: h.sessionID, callID: "load-demo", args },
        {
            title: "Load demo",
            output: "Native skill body",
            metadata: { name: "demo", dir: "/skills/demo" },
        },
    )

    const enter = hooks.tool?.enter_housekeeping
    assert.equal(typeof enter?.execute, "function")
    const entryMessage = structuredClone(h.history[h.history.length - 1]!)
    entryMessage.info.id = "message-enter"
    entryMessage.parts = [
        {
            type: "tool",
            id: "part-enter",
            messageID: "message-enter",
            sessionID: h.sessionID,
            tool: "enter_housekeeping",
            callID: "enter",
            state: { status: "running", input: {}, time: { start: 1 } },
        },
    ]
    h.setHistory([...h.history, entryMessage])
    await enter!.execute({} as any, toolExecutionContext(h, "enter") as any)

    try {
        await assert.rejects(
            before(
                { tool: "bash", sessionID: h.sessionID, callID: "blocked" },
                { args: { command: "pwd" } },
            ),
            /housekeeping/i,
        )
        await assert.rejects(
            before(
                { tool: "skill", sessionID: h.sessionID, callID: "duplicate" },
                { args: { name: "demo" } },
            ),
            /already|loaded|force/i,
        )
    } finally {
        const leave = hooks.tool?.leave_housekeeping
        assert.equal(typeof leave?.execute, "function")
        await leave!.execute({ force: true } as any, toolExecutionContext(h, "leave") as any)
    }
})

test("server registers unload_skill and uses the existing default allow conventions", async (t) => {
    const { hooks } = await createServerHooks(t)
    assert.equal(typeof hooks.tool?.unload_skill?.execute, "function")

    const config: any = { experimental: { primary_tools: ["read"] } }
    await hooks.config!(config)
    assert.ok(config.experimental.primary_tools.includes("read"))
    assert.ok(config.experimental.primary_tools.includes("unload_skill"))
    assert.equal(config.permission.unload_skill, "allow")
    assert.equal(config.permission.skill, undefined)
})

for (const permission of ["ask", "deny"]) {
    test(`server preserves explicit ${permission} permission for unload_skill and native skill`, async (t) => {
        const { hooks } = await createServerHooks(t)
        assert.equal(typeof hooks.tool?.unload_skill?.execute, "function")

        const config: any = { permission: { unload_skill: permission, skill: permission } }
        await hooks.config!(config)
        assert.equal(config.permission.unload_skill, permission)
        assert.equal(config.permission.skill, permission)
    })
}

test("denied compression omits unload_skill while keeping native lifecycle hooks and host skill permission", async (t) => {
    const { hooks } = await createServerHooks(t, "deny")
    assert.equal(hooks.tool?.unload_skill, undefined)
    assert.equal(typeof hooks["tool.definition"], "function")
    assert.equal(typeof hooks["tool.execute.after"], "function")

    const config: any = { permission: { skill: "ask" } }
    await hooks.config!(config)
    assert.equal(config.permission.skill, "ask")
    assert.equal(config.permission.unload_skill, undefined)
    assert.ok(!(config.experimental?.primary_tools ?? []).includes("unload_skill"))
})

test("wildcard deny disables compress", () => {
    assert.equal(compressDisabledByOpencode({ "*": "deny" }), true)
})

test("later explicit compress allow overrides wildcard deny", () => {
    assert.equal(
        compressDisabledByOpencode({
            "*": "deny",
            compress: "allow",
        }),
        false,
    )
})

test("agent wildcard deny disables compress even when global config allows it", () => {
    assert.equal(
        resolveEffectiveCompressPermission(
            "allow",
            {
                global: { question: "allow" },
                agents: {
                    fast: { "*": "deny", question: "allow" },
                },
            },
            "fast",
        ),
        "deny",
    )
})

test("agent explicit allow overrides global wildcard deny", () => {
    assert.equal(
        resolveEffectiveCompressPermission(
            "allow",
            {
                global: { "*": "deny" },
                agents: {
                    build: { compress: "allow" },
                },
            },
            "build",
        ),
        "allow",
    )
})

test("permission wildcards follow opencode-style matching", () => {
    assert.equal(compressDisabledByOpencode({ "c?mpress": "deny" }), true)
})

test("pattern-specific denies do not disable the whole tool", () => {
    assert.equal(
        compressDisabledByOpencode({
            compress: {
                "/tmp/*": "deny",
            },
        }),
        false,
    )
})

test("compress permission resolution works without Array.findLast", () => {
    const originalFindLast = Array.prototype.findLast

    try {
        delete (Array.prototype as Array<unknown> & { findLast?: unknown }).findLast

        assert.equal(
            compressDisabledByOpencode({
                "*": "deny",
                compress: "allow",
            }),
            false,
        )
    } finally {
        Array.prototype.findLast = originalFindLast
    }
})

test("explicit compress permissions are detected", () => {
    assert.equal(hasExplicitToolPermission({ compress: "ask" }, "compress"), true)
    assert.equal(hasExplicitToolPermission({ "*": "deny" }, "compress"), false)
})

test("explicit permission detection works without Object.hasOwn", () => {
    const originalHasOwn = Object.hasOwn

    try {
        delete (Object as typeof Object & { hasOwn?: unknown }).hasOwn

        assert.equal(hasExplicitToolPermission({ compress: "ask" }, "compress"), true)
        assert.equal(hasExplicitToolPermission({ "*": "deny" }, "compress"), false)
    } finally {
        Object.hasOwn = originalHasOwn
    }
})

test("enabled native setup registers a directly usable read_memo with native identity and permission", async (t) => {
    const sessionID = `ses_native_read_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    await seedCommittedMemo(h, {
        action: "append",
        topics: [
            {
                topicTitle: "Plan",
                textItems: ["Keep parser boundary."],
                topics: [{ topicTitle: "Nested", textItems: ["Use documented API."] }],
            },
        ],
    })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        sessionInfo: {
            id: h.sessionID,
            agent: "assistant",
            model: { providerID: "test", id: "test" },
        },
    })

    const definition = native.tool("read_memo")
    assert.ok(definition, "read_memo must be registered")
    assert.equal(definition.input?.type, "object")
    assert.equal(definition.options?.codemode, false)

    const result = await native.readMemo(
        {},
        { messageID: "msg_read_1", callID: "call_read_1" },
    )
    assert.equal(typeof result.content, "string")
    assert.equal(result.content, "# Plan\nKeep parser boundary.\n## Nested\nUse documented API.")

    assert.ok(native.context.mock.callCount() > 0)
    for (const call of native.context.mock.calls)
        assert.deepEqual(call.arguments[0], { sessionID: h.sessionID })
    assert.ok(native.get.mock.callCount() > 0)
    for (const call of native.get.mock.calls)
        assert.deepEqual(call.arguments[0], { sessionID: h.sessionID })
    assert.deepEqual(native.assertPermission.mock.calls.at(-1)?.arguments[0], {
        sessionID: h.sessionID,
        agent: "assistant",
        action: "read_memo",
        resources: ["*"],
        source: { type: "tool", messageID: "msg_read_1", id: "call_read_1" },
    })
    assert.equal("prompt" in native.host.session, false)
    assert.equal("generate" in native.host.session, false)
})

test("empty native memo stays empty across sessions, simultaneous reads and separate setups", async (t) => {
    const emptySessionID = `ses_native_empty_${randomUUID()}`
    const empty = await createHousekeepingHarness(t, {
        messages: nativeFixtureMessages(emptySessionID),
    })
    const otherSessionID = `ses_native_other_${randomUUID()}`
    const other = await createHousekeepingHarness(t, {
        messages: nativeFixtureMessages(otherSessionID),
    })
    await seedCommittedMemo(other, { action: "append", textItems: ["Second session memo."] })

    const firstSetup = await createNativeHarness(t, {
        root: empty.root,
        sessionID: empty.sessionID,
        contextMessages: toNativeHistory(empty.history),
    })
    const secondSetup = await createNativeHarness(t, {
        root: empty.root,
        sessionID: empty.sessionID,
        contextMessages: toNativeHistory(empty.history),
    })
    firstSetup.context.mock.mockImplementation(async ({ sessionID }) =>
        toNativeHistory(sessionID === other.sessionID ? other.history : empty.history),
    )
    firstSetup.get.mock.mockImplementation(async ({ sessionID }) => ({ id: sessionID }))

    assert.equal((await firstSetup.readMemo()).content, "(memo is empty)")
    assert.equal((await secondSetup.readMemo()).content, "(memo is empty)")
    const [simultaneousEmpty, simultaneousOther] = await Promise.all([
        firstSetup.readMemo(),
        firstSetup.readMemo({}, { sessionID: other.sessionID }),
    ])
    assert.equal(simultaneousEmpty.content, "(memo is empty)")
    assert.equal(simultaneousOther.content, "Second session memo.")
    assert.equal((await firstSetup.readMemo()).content, "(memo is empty)")
})

test("native read returns the staged memo from an active checkpoint and repeats unchanged", async (t) => {
    const sessionID = `ses_native_staged_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    await seedCommittedMemo(h, { action: "append", textItems: ["Committed memo."] })
    const suffix = nextNativeFixtureSuffix()
    await h.run(
        "enter_housekeeping",
        {},
        { messageID: `msg_enter_${suffix}`, callID: `call_enter_${suffix}` },
    )
    await h.run(
        "edit_memo",
        { action: "append", textItems: ["Staged memo."] },
        { messageID: `msg_edit_${suffix}`, callID: `call_edit_${suffix}` },
    )
    const transaction = h.ctx.state.housekeeping
    assert.ok(transaction)
    const contextMessages = toNativeHistory(h.history)
    const entryCall = contextMessages
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .find(
            (part: any) =>
                part.type === "tool" &&
                part.name === "enter_housekeeping" &&
                part.id === transaction.entryCallId,
        )
    assert.ok(entryCall, "native history must include the active entry call")

    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    assert.ok(native.tool("read_memo"))
    const first = await native.readMemo()
    assert.equal(first.content, "Committed memo.\nStaged memo.")
    assert.notEqual(first.content, "Committed memo.")
    const secondRead = await native.readMemo()
    assert.equal(secondRead.content, first.content)
})

for (const status of ["completed", "running", "failed"] as const) {
    test(`native ${status} compaction keeps the staged memo while only completion resets summaries`, async (t) => {
        const sessionID = `ses_native_compaction_${status}_${randomUUID()}`
        const h = await createHousekeepingHarness(t, {
            messages: nativeFixtureMessages(sessionID),
        })
        const baseHistory = await seedCompressedMemoFixture(h)
        const native = await createNativeHarness(t, {
            root: h.root,
            sessionID: h.sessionID,
            contextMessages: baseHistory,
        })
        assert.ok(native.tool("read_memo"))
        assert.equal((await native.readMemo()).content, "Committed memo.\nStaged memo.")

        const compaction = nativeCompaction(status, 100)
        native.setContext(status === "completed" ? [compaction] : [...baseHistory, compaction])
        const result = await native.readMemo()
        assert.equal(result.content, "Committed memo.\nStaged memo.")
        assert.equal(
            await persistedBlockVersion(h.sessionID),
            status === "completed" ? 0 : 1,
        )
    })
}

test("native history read failure rejects instead of returning a stale memo", async (t) => {
    const sessionID = `ses_native_history_failure_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    await seedCommittedMemo(h, { action: "append", textItems: ["Persisted memo."] })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        contextError: new Error("native history read failed"),
    })
    assert.ok(native.tool("read_memo"))
    await assert.rejects(native.readMemo(), /history/i)
})

test("native session metadata read failure rejects instead of returning a stale memo", async (t) => {
    const sessionID = `ses_native_metadata_failure_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    await seedCommittedMemo(h, { action: "append", textItems: ["Persisted memo."] })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        getError: new Error("native session metadata read failed"),
    })
    assert.ok(native.tool("read_memo"))
    await assert.rejects(native.readMemo(), /metadata/i)
})

test("native permission rejection prevents history reads and memo results", async (t) => {
    const sessionID = `ses_native_permission_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    await seedCommittedMemo(h, { action: "append", textItems: ["Persisted memo."] })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        assertError: new Error("permission denied"),
    })
    assert.ok(native.tool("read_memo"))
    let returned: unknown
    await assert.rejects(async () => {
        returned = await native.readMemo()
    }, /permission|denied/i)
    assert.equal(returned, undefined)
    assert.ok(native.assertPermission.mock.callCount() > 0)
    assert.equal(native.context.mock.callCount(), 0)
    assert.equal(native.get.mock.callCount(), 0)
})

test("DCP compression deny omits the native read_memo tool", async (t) => {
    const sessionID = `ses_native_denied_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        compressPermission: "deny",
    })
    assert.equal(native.tool("read_memo"), undefined)
})

test("native read rejects a disallowed subagent and permits it when subagents are allowed", async (t) => {
    const sessionID = `ses_native_subagent_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const sessionInfo = { id: h.sessionID, parentID: "msg_parent_session" }
    const disallowed = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        sessionInfo,
        allowSubAgents: false,
    })
    assert.ok(disallowed.tool("read_memo"))
    await assert.rejects(disallowed.readMemo(), /subagent|sub-agent|parent/i)

    const allowed = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        sessionInfo,
        allowSubAgents: true,
    })
    assert.ok(allowed.tool("read_memo"))
    assert.equal((await allowed.readMemo()).content, "(memo is empty)")
})

test("disabled native plugin registers no tools or hooks", async (t) => {
    const sessionID = `ses_native_disabled_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        enabled: false,
    })
    assert.deepEqual(native.definitions, [])
    assert.equal(native.hook.mock.callCount(), 0)
    assert.equal(native.toolHook.mock.callCount(), 0)
    assert.equal(native.transform.mock.callCount(), 0)
})

test("native setup registers housekeeping definitions with native schemas and codemode disabled", async (t) => {
    const sessionID = `ses_native_definitions_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
    })

    for (const name of [
        "enter_housekeeping",
        "edit_memo",
        "read_memo",
        "leave_housekeeping",
    ]) {
        const definition = native.requiredTool(name)
        assert.equal(definition.input?.type, "object", `${name} input must be a JSON object schema`)
        assert.equal(definition.options?.codemode, false, `${name} must be directly executable`)
        assert.equal(typeof definition.description, "string")
        assert.ok(definition.description.length > 0)
    }

    const enter = native.requiredTool("enter_housekeeping")
    assert.deepEqual(Object.keys(enter.input.properties ?? {}), [])
    assert.match(enter.description, /Enter housekeeping mode/i)

    const edit = native.requiredTool("edit_memo")
    assert.ok(edit.input.required.includes("action"))
    const editProperties = edit.input.properties
    for (const field of ["action", "parent", "after", "textItems", "topics", "path"])
        assert.ok(field in editProperties, `edit_memo schema must expose ${field}`)
    for (const action of ["append", "remove", "clear"])
        assert.ok(editProperties.action.enum.includes(action))
    let topicSchema = editProperties.topics.items
    let topicDepth = 0
    while (topicSchema?.properties?.topicTitle) {
        assert.ok(topicSchema.required.includes("topicTitle"))
        topicDepth += 1
        if (topicDepth === 6) {
            assert.equal(topicSchema.properties.topics.type, "array")
            assert.equal(topicSchema.properties.topics.items, false)
        }
        topicSchema = topicSchema.properties.topics?.items
    }
    assert.equal(topicDepth, 6, "memo topics must remain available to six levels")

    const leave = native.requiredTool("leave_housekeeping")
    assert.equal(leave.input.properties.force.type, "boolean")
    assert.match(leave.description, /Commit the accumulated housekeeping draft/i)

    const read = native.requiredTool("read_memo")
    assert.match(read.description, /persistent memo block/i)
})

test("native entry seeds todos, returns guidance, repeats the same call and rejects recursive entry", async (t) => {
    const sessionID = `ses_native_entry_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const entryMessageID = "msg_native_entry"
    const entryCallID = "call_native_entry"
    const contextMessages = toNativeHistory(h.history)
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            "msg_native_todo",
            "call_native_todo",
            "todowrite",
            { todos: [{ content: "Entry todo", status: "in_progress" }] },
            {
                created: 10,
                metadata: { todos: [{ content: "Metadata todo", status: "completed" }] },
                text: '[{"content":"Output todo","status":"completed"}]',
            },
        ),
    )
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            entryMessageID,
            entryCallID,
            "enter_housekeeping",
            {},
            { status: "running", created: 20 },
        ),
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })

    const guidance = await native.execute(
        "enter_housekeeping",
        {},
        { messageID: entryMessageID, callID: entryCallID },
    )
    assert.match(guidance, /HOUSEKEEPING ENTRY/)
    assert.match(guidance, /m0001[\s\S]*m0005/)
    assert.match(guidance, /Eligible messages: 5/)
    assert.match(guidance, /leave_housekeeping/)
    assert.match(guidance, /edit_memo/)
    assert.equal(
        await native.execute(
            "enter_housekeeping",
            {},
            { messageID: entryMessageID, callID: entryCallID },
        ),
        guidance,
    )
    await assert.rejects(
        native.execute(
            "enter_housekeeping",
            {},
            { messageID: "msg_native_entry_distinct", callID: "call_native_entry_distinct" },
        ),
        /already|recursive|active/i,
    )

    const memo = await native.readMemo()
    assert.equal(
        memo.content,
        '# Todo status\n[{"content":"Entry todo","status":"in_progress"}]',
    )
    assert.deepEqual(native.assertPermission.mock.calls.at(-1)?.arguments[0], {
        sessionID: h.sessionID,
        agent: "assistant",
        action: "read_memo",
        resources: ["*"],
        source: { type: "tool", messageID: "msg_read_memo", id: "call_read_memo" },
    })
    assert.equal("messages" in native.host.session, false)
    assert.equal("todo" in native.host.session, false)
})

test("native todos use the latest completed todowrite input and ignore later running or error calls", async (t) => {
    const sessionID = `ses_native_todos_latest_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const entryMessageID = "msg_native_todo_entry"
    const entryCallID = "call_native_todo_entry"
    const contextMessages = toNativeHistory(h.history)
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            "msg_native_todo_old",
            "call_native_todo_old",
            "todowrite",
            { todos: [{ content: "Old todo", status: "pending" }] },
            { created: 10 },
        ),
    )
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            "msg_native_todo_current",
            "call_native_todo_current",
            "todowrite",
            {
                todos: [
                    { content: "Current todo", status: "in_progress", priority: "high" },
                    { content: "", status: "completed" },
                    { content: 7, status: "completed" },
                    { content: "Malformed status", status: "blocked" },
                ],
            },
            {
                created: 20,
                metadata: { todos: [{ content: "Metadata todo", status: "completed" }] },
                text: '[{"content":"Output todo","status":"completed"}]',
            },
        ),
    )
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            "msg_native_todo_running",
            "call_native_todo_running",
            "todowrite",
            { todos: [{ content: "Running todo", status: "completed" }] },
            { status: "running", created: 30 },
        ),
    )
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            "msg_native_todo_error",
            "call_native_todo_error",
            "todowrite",
            { todos: [{ content: "Error todo", status: "completed" }] },
            { status: "error", text: "todowrite failed", created: 40 },
        ),
    )
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            entryMessageID,
            entryCallID,
            "enter_housekeeping",
            {},
            { status: "running", created: 50 },
        ),
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })

    await native.execute(
        "enter_housekeeping",
        {},
        { messageID: entryMessageID, callID: entryCallID },
    )
    const memo = await native.readMemo()
    assert.equal(
        memo.content,
        '# Todo status\n[{"content":"Current todo","status":"in_progress"},{"content":"Malformed status","status":"pending"}]',
    )
})

test("native todos stay empty without a completed todowrite call", async (t) => {
    const sessionID = `ses_native_todos_empty_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const entryMessageID = "msg_native_todo_empty_entry"
    const entryCallID = "call_native_todo_empty_entry"
    const contextMessages = toNativeHistory(h.history)
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            "msg_native_todo_empty_running",
            "call_native_todo_empty_running",
            "todowrite",
            { todos: [{ content: "Running todo", status: "pending" }] },
            { status: "running", created: 10 },
        ),
    )
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            "msg_native_todo_empty_error",
            "call_native_todo_empty_error",
            "todowrite",
            { todos: [{ content: "Error todo", status: "pending" }] },
            { status: "error", text: "todowrite failed", created: 20 },
        ),
    )
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            entryMessageID,
            entryCallID,
            "enter_housekeeping",
            {},
            { status: "running", created: 30 },
        ),
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })

    await native.execute(
        "enter_housekeeping",
        {},
        { messageID: entryMessageID, callID: entryCallID },
    )
    assert.equal((await native.readMemo()).content, "# Todo status")
})

test("native todos ignore messages at and after the session revert boundary", async (t) => {
    const sessionID = `ses_native_todos_revert_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const entryMessageID = "msg_native_revert_entry"
    const entryCallID = "call_native_revert_entry"
    const contextMessages = toNativeHistory(h.history)
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            "msg_native_revert_old",
            "call_native_revert_old",
            "todowrite",
            { todos: [{ content: "Before revert", status: "pending" }] },
            { created: 10 },
        ),
    )
    contextMessages.push({
        id: "msg_native_revert_boundary",
        type: "user",
        text: "Revert boundary.",
        time: { created: 15 },
    })
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            "msg_native_revert_new",
            "call_native_revert_new",
            "todowrite",
            { todos: [{ content: "After revert", status: "completed" }] },
            { created: 20 },
        ),
    )
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            entryMessageID,
            entryCallID,
            "enter_housekeeping",
            {},
            { status: "running", created: 30 },
        ),
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        sessionInfo: {
            id: h.sessionID,
            revert: { messageID: "msg_native_revert_boundary" },
        },
    })

    await native.execute(
        "enter_housekeeping",
        {},
        { messageID: entryMessageID, callID: entryCallID },
    )
    assert.equal(
        (await native.readMemo()).content,
        '# Todo status\n[{"content":"Before revert","status":"pending"}]',
    )
})

test("native memo edit and leave require an active entry without changing the memo", async (t) => {
    const sessionID = `ses_native_no_entry_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
    })
    native.requiredTool("edit_memo")
    native.requiredTool("leave_housekeeping")

    await assert.rejects(
        native.execute(
            "edit_memo",
            { action: "append", textItems: ["No entry."] },
            { messageID: "msg_native_no_entry_edit", callID: "call_native_no_entry_edit" },
        ),
        /enter_housekeeping|before making/i,
    )
    await assert.rejects(
        native.execute(
            "leave_housekeeping",
            { force: true },
            { messageID: "msg_native_no_entry_leave", callID: "call_native_no_entry_leave" },
        ),
        /enter_housekeeping|not.*housekeeping|no.*active/i,
    )
    assert.equal((await native.readMemo()).content, "(memo is empty)")
})

test("native entry, edit, read, forced leave and retries preserve one published memo", async (t) => {
    const sessionID = `ses_native_flow_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const entry = { messageID: "msg_native_flow_entry", callID: "call_native_flow_entry" }
    const edit = { messageID: "msg_native_flow_edit", callID: "call_native_flow_edit" }
    const leave = { messageID: "msg_native_flow_leave", callID: "call_native_flow_leave" }
    const contextMessages = toNativeHistory(h.history)
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            entry.messageID,
            entry.callID,
            "enter_housekeeping",
            {},
            { status: "running", created: 10 },
        ),
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })

    const guidance = await native.execute("enter_housekeeping", {}, entry)
    assert.match(guidance, /HOUSEKEEPING ENTRY/)
    assert.equal((await native.readMemo()).content, "# Todo status")

    const editResult = await native.execute(
        "edit_memo",
        { action: "append", textItems: ["Staged memo."] },
        edit,
    )
    assert.match(editResult, /Memo edited/)
    native.appendToolCall(edit.messageID, edit.callID, "edit_memo", {
        action: "append",
        textItems: ["Staged memo."],
    }, { text: editResult, created: 20 })
    assert.equal((await native.readMemo()).content, "Staged memo.\n# Todo status")

    assert.equal(
        await native.execute(
            "edit_memo",
            { action: "append", textItems: ["Staged memo."] },
            edit,
        ),
        editResult,
    )
    assert.equal((await native.readMemo()).content, "Staged memo.\n# Todo status")
    await assert.rejects(
        native.execute("leave_housekeeping", {}, {
            messageID: "msg_native_flow_leave_unforced",
            callID: "call_native_flow_leave_unforced",
        }),
        /finish the compression plan/i,
    )

    const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
    assert.match(receipt, /Housekeeping complete/)
    assert.match(receipt, /memo updated/)
    native.appendToolCall(leave.messageID, leave.callID, "leave_housekeeping", { force: true }, {
        text: receipt,
        created: 30,
    })
    assert.equal(
        await native.execute("leave_housekeeping", {}, leave),
        receipt,
    )
    assert.equal((await native.readMemo()).content, "Staged memo.\n# Todo status")

    const permissionActions = native.assertPermission.mock.calls.map(
        (call) => (call.arguments[0] as { action: string }).action,
    )
    for (const action of [
        "enter_housekeeping",
        "edit_memo",
        "read_memo",
        "leave_housekeeping",
    ])
        assert.ok(permissionActions.includes(action), `missing permission assertion for ${action}`)
})

test("native invalid memo edits fail without publication", async (t) => {
    const sessionID = `ses_native_invalid_edit_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const entry = { messageID: "msg_native_invalid_entry", callID: "call_native_invalid_entry" }
    const contextMessages = toNativeHistory(h.history)
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            entry.messageID,
            entry.callID,
            "enter_housekeeping",
            {},
            { status: "running", created: 10 },
        ),
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    await native.execute("enter_housekeeping", {}, entry)

    await assert.rejects(
        native.execute(
            "edit_memo",
            { action: "append", textItems: [] },
            { messageID: "msg_native_invalid_append", callID: "call_native_invalid_append" },
        ),
        /append|text item|topic/i,
    )
    await assert.rejects(
        native.execute(
            "edit_memo",
            { action: "remove", path: "" },
            { messageID: "msg_native_invalid_remove", callID: "call_native_invalid_remove" },
        ),
        /path|non-empty/i,
    )
    assert.equal((await native.readMemo()).content, "# Todo status")

    const receipt = await native.execute(
        "leave_housekeeping",
        { force: true },
        { messageID: "msg_native_invalid_leave", callID: "call_native_invalid_leave" },
    )
    native.appendToolCall("msg_native_invalid_leave", "call_native_invalid_leave", "leave_housekeeping", { force: true }, {
        text: receipt,
        created: 20,
    })
    assert.equal((await native.readMemo()).content, "# Todo status")
})

test("native entry history failure rejects before state changes and retries cleanly", async (t) => {
    const sessionID = `ses_native_entry_history_failure_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const entry = { messageID: "msg_native_failed_entry", callID: "call_native_failed_entry" }
    const contextMessages = toNativeHistory(h.history)
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            entry.messageID,
            entry.callID,
            "enter_housekeeping",
            {},
            { status: "running", created: 10 },
        ),
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        contextError: new Error("native history read failed"),
    })
    native.requiredTool("enter_housekeeping")

    await assert.rejects(
        native.execute("enter_housekeeping", {}, entry),
        /native history read failed/i,
    )
    native.setContextError(undefined)
    assert.match(await native.execute("enter_housekeeping", {}, entry), /HOUSEKEEPING ENTRY/)
})

test("native edit history failure keeps the memo unchanged and retries without a stale success", async (t) => {
    const sessionID = `ses_native_edit_history_failure_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const entry = { messageID: "msg_native_edit_failure_entry", callID: "call_native_edit_failure_entry" }
    const edit = { messageID: "msg_native_edit_failure_edit", callID: "call_native_edit_failure_edit" }
    const contextMessages = toNativeHistory(h.history)
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            entry.messageID,
            entry.callID,
            "enter_housekeeping",
            {},
            { status: "running", created: 10 },
        ),
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    await native.execute("enter_housekeeping", {}, entry)

    native.setContextError(new Error("native history read failed"))
    await assert.rejects(
        native.execute("edit_memo", { action: "append", textItems: ["Should not publish."] }, edit),
        /native history read failed/i,
    )
    native.setContextError(undefined)
    assert.equal((await native.readMemo()).content, "# Todo status")
    assert.match(
        await native.execute("edit_memo", { action: "append", textItems: ["Published once."] }, edit),
        /Memo edited/,
    )
    native.appendToolCall(edit.messageID, edit.callID, "edit_memo", {
        action: "append",
        textItems: ["Published once."],
    }, { text: "Memo edited.", created: 20 })
    assert.equal((await native.readMemo()).content, "Published once.\n# Todo status")
})

test("native leave metadata failure keeps the draft staged and retries without a stale success", async (t) => {
    const sessionID = `ses_native_leave_metadata_failure_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const entry = { messageID: "msg_native_leave_failure_entry", callID: "call_native_leave_failure_entry" }
    const edit = { messageID: "msg_native_leave_failure_edit", callID: "call_native_leave_failure_edit" }
    const leave = { messageID: "msg_native_leave_failure_leave", callID: "call_native_leave_failure_leave" }
    const contextMessages = toNativeHistory(h.history)
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            entry.messageID,
            entry.callID,
            "enter_housekeeping",
            {},
            { status: "running", created: 10 },
        ),
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    await native.execute("enter_housekeeping", {}, entry)
    await native.execute("edit_memo", { action: "append", textItems: ["Staged memo."] }, edit)
    native.appendToolCall(edit.messageID, edit.callID, "edit_memo", {
        action: "append",
        textItems: ["Staged memo."],
    }, { text: "Memo edited.", created: 20 })

    native.setGetError(new Error("native session metadata read failed"))
    await assert.rejects(
        native.execute("leave_housekeeping", { force: true }, leave),
        /native session metadata read failed/i,
    )
    native.setGetError(undefined)
    assert.equal((await native.readMemo()).content, "Staged memo.\n# Todo status")
    const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
    assert.match(receipt, /Housekeeping complete/)
    assert.equal((await native.readMemo()).content, "Staged memo.\n# Todo status")
})

test("native restart restores the staged draft, keeps the guard active and commits after leave", async (t) => {
    const sessionID = `ses_native_restart_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const entry = { messageID: "msg_native_restart_entry", callID: "call_native_restart_entry" }
    const edit = { messageID: "msg_native_restart_edit", callID: "call_native_restart_edit" }
    const leave = { messageID: "msg_native_restart_leave", callID: "call_native_restart_leave" }
    const contextMessages = toNativeHistory(h.history)
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            entry.messageID,
            entry.callID,
            "enter_housekeeping",
            {},
            { status: "running", created: 10 },
        ),
    )
    const first = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    await first.execute("enter_housekeeping", {}, entry)
    await first.execute("edit_memo", { action: "append", textItems: ["Restart memo."] }, edit)
    first.appendToolCall(edit.messageID, edit.callID, "edit_memo", {
        action: "append",
        textItems: ["Restart memo."],
    }, { text: "Memo edited.", created: 20 })
    assert.equal((await first.readMemo()).content, "Restart memo.\n# Todo status")

    const second = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: first.getContext(),
    })
    assert.equal((await second.readMemo()).content, "Restart memo.\n# Todo status")
    await assert.rejects(second.guard({ tool: "read" }), /housekeeping/i)

    const receipt = await second.execute("leave_housekeeping", { force: true }, leave)
    assert.match(receipt, /Housekeeping complete/)
    second.appendToolCall(leave.messageID, leave.callID, "leave_housekeeping", { force: true }, {
        text: receipt,
        created: 30,
    })

    const third = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: second.getContext(),
    })
    assert.equal((await third.readMemo()).content, "Restart memo.\n# Todo status")
    await third.guard({ tool: "read" })
})

test("native concurrent sessions keep their transactions and memos isolated", async (t) => {
    const firstSessionID = `ses_native_isolated_first_${randomUUID()}`
    const secondSessionID = `ses_native_isolated_second_${randomUUID()}`
    const firstHarness = await createHousekeepingHarness(t, {
        messages: nativeFixtureMessages(firstSessionID),
    })
    const secondHarness = await createHousekeepingHarness(t, {
        messages: nativeFixtureMessages(secondSessionID),
    })
    const firstEntry = { messageID: "msg_native_isolated_first_entry", callID: "call_native_isolated_first_entry" }
    const secondEntry = { messageID: "msg_native_isolated_second_entry", callID: "call_native_isolated_second_entry" }
    const firstEdit = { messageID: "msg_native_isolated_first_edit", callID: "call_native_isolated_first_edit" }
    const secondEdit = { messageID: "msg_native_isolated_second_edit", callID: "call_native_isolated_second_edit" }
    const firstLeave = { messageID: "msg_native_isolated_first_leave", callID: "call_native_isolated_first_leave" }
    const secondLeave = { messageID: "msg_native_isolated_second_leave", callID: "call_native_isolated_second_leave" }
    const firstContext = toNativeHistory(firstHarness.history)
    firstContext.push(
        nativeToolCallMessage(
            firstSessionID,
            firstEntry.messageID,
            firstEntry.callID,
            "enter_housekeeping",
            {},
            { status: "running", created: 10 },
        ),
    )
    const secondContext = toNativeHistory(secondHarness.history)
    secondContext.push(
        nativeToolCallMessage(
            secondSessionID,
            secondEntry.messageID,
            secondEntry.callID,
            "enter_housekeeping",
            {},
            { status: "running", created: 10 },
        ),
    )
    const native = await createNativeHarness(t, {
        root: firstHarness.root,
        sessionID: firstHarness.sessionID,
        contextMessages: firstContext,
    })
    native.setContextFor(secondHarness.sessionID, secondContext)
    native.setSessionInfoFor(firstHarness.sessionID, { id: firstHarness.sessionID })
    native.setSessionInfoFor(secondHarness.sessionID, { id: secondHarness.sessionID })

    await native.execute("enter_housekeeping", {}, { ...firstEntry, sessionID: firstHarness.sessionID })
    await native.execute("enter_housekeeping", {}, { ...secondEntry, sessionID: secondHarness.sessionID })
    await native.execute(
        "edit_memo",
        { action: "append", textItems: ["First session memo."] },
        { ...firstEdit, sessionID: firstHarness.sessionID },
    )
    await native.execute(
        "edit_memo",
        { action: "append", textItems: ["Second session memo."] },
        { ...secondEdit, sessionID: secondHarness.sessionID },
    )
    native.appendToolCall(firstEdit.messageID, firstEdit.callID, "edit_memo", {
        action: "append",
        textItems: ["First session memo."],
    }, { text: "Memo edited.", sessionID: firstHarness.sessionID, created: 20 })
    native.appendToolCall(secondEdit.messageID, secondEdit.callID, "edit_memo", {
        action: "append",
        textItems: ["Second session memo."],
    }, { text: "Memo edited.", sessionID: secondHarness.sessionID, created: 20 })

    assert.equal(
        (await native.readMemo({}, { sessionID: firstHarness.sessionID })).content,
        "First session memo.\n# Todo status",
    )
    assert.equal(
        (await native.readMemo({}, { sessionID: secondHarness.sessionID })).content,
        "Second session memo.\n# Todo status",
    )
    await assert.rejects(
        native.guard({ tool: "read", sessionID: firstHarness.sessionID }),
        /housekeeping/i,
    )
    await assert.rejects(
        native.guard({ tool: "read", sessionID: secondHarness.sessionID }),
        /housekeeping/i,
    )

    await native.execute(
        "leave_housekeeping",
        { force: true },
        { ...firstLeave, sessionID: firstHarness.sessionID },
    )
    await native.execute(
        "leave_housekeeping",
        { force: true },
        { ...secondLeave, sessionID: secondHarness.sessionID },
    )
    native.appendToolCall(firstLeave.messageID, firstLeave.callID, "leave_housekeeping", { force: true }, {
        text: "First receipt.",
        sessionID: firstHarness.sessionID,
        created: 30,
    })
    native.appendToolCall(secondLeave.messageID, secondLeave.callID, "leave_housekeeping", { force: true }, {
        text: "Second receipt.",
        sessionID: secondHarness.sessionID,
        created: 30,
    })

    assert.equal(
        (await native.readMemo({}, { sessionID: firstHarness.sessionID })).content,
        "First session memo.\n# Todo status",
    )
    assert.equal(
        (await native.readMemo({}, { sessionID: secondHarness.sessionID })).content,
        "Second session memo.\n# Todo status",
    )
    await native.guard({ tool: "read", sessionID: firstHarness.sessionID })
    await native.guard({ tool: "read", sessionID: secondHarness.sessionID })
})

for (const [name, input] of [
    ["enter_housekeeping", {}],
    ["edit_memo", { action: "append", textItems: ["Denied."] }],
    ["read_memo", {}],
    ["leave_housekeeping", { force: true }],
] as const) {
    test(`native ${name} asserts its exact permission before history and metadata IO`, async (t) => {
        const sessionID = `ses_native_permission_${name}_${randomUUID()}`
        const h = await createHousekeepingHarness(t, {
            messages: nativeFixtureMessages(sessionID),
        })
        if (name === "edit_memo" || name === "leave_housekeeping")
            await h.run(
                "enter_housekeeping",
                {},
                {
                    messageID: `msg_native_permission_seed_${name}`,
                    callID: `call_native_permission_seed_${name}`,
                },
            )
        const native = await createNativeHarness(t, {
            root: h.root,
            sessionID: h.sessionID,
            contextMessages: toNativeHistory(h.history),
            assertError: new Error("permission denied"),
        })
        const messageID = `msg_native_permission_${name}`
        const callID = `call_native_permission_${name}`
        native.requiredTool(name)

        await assert.rejects(
            native.execute(name, input, { messageID, callID }),
            /permission|denied/i,
        )
        assert.equal(native.context.mock.callCount(), 0)
        assert.equal(native.get.mock.callCount(), 0)
        assert.deepEqual(native.assertPermission.mock.calls.at(-1)?.arguments[0], {
            sessionID: h.sessionID,
            agent: "assistant",
            action: name,
            resources: ["*"],
            source: { type: "tool", messageID, id: callID },
        })
    })
}

test("native DCP compression deny omits every housekeeping tool while keeping the guard", async (t) => {
    const sessionID = `ses_native_denied_housekeeping_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        compressPermission: "deny",
    })

    for (const name of [
        "enter_housekeeping",
        "edit_memo",
        "read_memo",
        "leave_housekeeping",
    ])
        assert.equal(native.tool(name), undefined, `${name} must be omitted`)
    assert.ok(native.toolHook.mock.callCount() > 0, "the guard must remain registered")
    await native.guard({ tool: "read", input: { filePath: "example.ts" } })
})

for (const [name, input] of [
    ["enter_housekeeping", {}],
    ["edit_memo", { action: "append", textItems: ["Subagent memo."] }],
    ["leave_housekeeping", { force: true }],
] as const) {
    test(`native ${name} rejects a disallowed subagent executor`, async (t) => {
        const sessionID = `ses_native_subagent_executor_${name}_${randomUUID()}`
        const h = await createHousekeepingHarness(t, {
            messages: nativeFixtureMessages(sessionID),
        })
        if (name === "edit_memo" || name === "leave_housekeeping")
            await h.run(
                "enter_housekeeping",
                {},
                {
                    messageID: `msg_native_subagent_seed_${name}`,
                    callID: `call_native_subagent_seed_${name}`,
                },
            )
        const native = await createNativeHarness(t, {
            root: h.root,
            sessionID: h.sessionID,
            contextMessages: toNativeHistory(h.history),
            sessionInfo: { id: h.sessionID, parentID: "msg_parent_session" },
            allowSubAgents: false,
        })
        native.requiredTool(name)
        await assert.rejects(
            native.execute(name, input, {
                messageID: `msg_native_subagent_${name}`,
                callID: `call_native_subagent_${name}`,
            }),
            /subagent|sub-agent|parent/i,
        )
    })
}

test("native housekeeping flows work in a subagent session when subagents are allowed", async (t) => {
    const sessionID = `ses_native_allowed_subagent_${randomUUID()}`
    const h = await createHousekeepingHarness(t, {
        messages: nativeFixtureMessages(sessionID),
        parentID: "msg_parent_session",
    })
    const entry = { messageID: "msg_native_allowed_entry", callID: "call_native_allowed_entry" }
    const contextMessages = toNativeHistory(h.history)
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            entry.messageID,
            entry.callID,
            "enter_housekeeping",
            {},
            { status: "running", created: 10 },
        ),
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        sessionInfo: { id: h.sessionID, parentID: "msg_parent_session" },
        allowSubAgents: true,
    })

    await native.execute("enter_housekeeping", {}, entry)
    await native.execute(
        "edit_memo",
        { action: "append", textItems: ["Subagent memo."] },
        { messageID: "msg_native_allowed_edit", callID: "call_native_allowed_edit" },
    )
    native.appendToolCall(
        "msg_native_allowed_edit",
        "call_native_allowed_edit",
        "edit_memo",
        { action: "append", textItems: ["Subagent memo."] },
        { text: "Memo edited.", created: 20 },
    )
    assert.equal((await native.readMemo()).content, "Subagent memo.\n# Todo status")
    await native.execute(
        "leave_housekeeping",
        { force: true },
        { messageID: "msg_native_allowed_leave", callID: "call_native_allowed_leave" },
    )
    assert.equal((await native.readMemo()).content, "Subagent memo.\n# Todo status")
})

test("native guard permits ordinary host and MCP tools outside housekeeping and blocks them during", async (t) => {
    const sessionID = `ses_native_guard_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const entry = { messageID: "msg_native_guard_entry", callID: "call_native_guard_entry" }
    const leave = { messageID: "msg_native_guard_leave", callID: "call_native_guard_leave" }
    const contextMessages = toNativeHistory(h.history)
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            entry.messageID,
            entry.callID,
            "enter_housekeeping",
            {},
            { status: "running", created: 10 },
        ),
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })

    await native.guard({ tool: "read", input: { filePath: "example.ts" } })
    await native.guard({ tool: "mcp__server__inspect", input: { query: "x" } })
    await native.execute("enter_housekeeping", {}, entry)
    await assert.rejects(
        native.guard({ tool: "read", input: { filePath: "example.ts" } }),
        /housekeeping/i,
    )
    await assert.rejects(
        native.guard({ tool: "mcp__server__inspect", input: { query: "x" } }),
        /housekeeping/i,
    )
    await assert.rejects(
        native.guard({ tool: "functions.read", input: { filePath: "example.ts" } }),
        /housekeeping/i,
    )
    const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
    native.appendToolCall(leave.messageID, leave.callID, "leave_housekeeping", { force: true }, {
        text: receipt,
        created: 20,
    })
    await native.guard({ tool: "read", input: { filePath: "example.ts" } })

    const subagentSessionID = `ses_native_guard_subagent_${randomUUID()}`
    const subagentHarness = await createHousekeepingHarness(t, {
        messages: nativeFixtureMessages(subagentSessionID),
        parentID: "msg_parent_session",
    })
    const subagentNative = await createNativeHarness(t, {
        root: subagentHarness.root,
        sessionID: subagentHarness.sessionID,
        contextMessages: toNativeHistory(subagentHarness.history),
        sessionInfo: { id: subagentHarness.sessionID, parentID: "msg_parent_session" },
        allowSubAgents: false,
    })
    await subagentNative.guard({ tool: "read", input: { filePath: "example.ts" } })
})

test("native guard honors exact allowed tool names and the functions prefix policy", async (t) => {
    const sessionID = `ses_native_guard_allowlist_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const entry = { messageID: "msg_native_guard_allow_entry", callID: "call_native_guard_allow_entry" }
    const contextMessages = toNativeHistory(h.history)
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            entry.messageID,
            entry.callID,
            "enter_housekeeping",
            {},
            { status: "running", created: 10 },
        ),
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        allowedTools: ["read", "custom_inspect"],
    })
    await native.execute("enter_housekeeping", {}, entry)

    await native.guard({ tool: "read", input: { filePath: "example.ts" } })
    await native.guard({ tool: "custom_inspect" })
    await assert.rejects(native.guard({ tool: "read_other" }), /housekeeping/i)
    await assert.rejects(native.guard({ tool: "unknown_tool" }), /housekeeping/i)
    await native.guard({ tool: "functions.read_memo" })
    await assert.rejects(native.guard({ tool: "functions.read" }), /housekeeping/i)
    await assert.rejects(native.guard({ tool: "vendor.compress" }), /housekeeping/i)
    await native.execute(
        "leave_housekeeping",
        { force: true },
        { messageID: "msg_native_guard_allow_leave", callID: "call_native_guard_allow_leave" },
    )
})

test("native guard rejects parallel entry and leave next to siblings outside and nested inside housekeeping", async (t) => {
    const sessionID = `ses_native_guard_parallel_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const entry = { messageID: "msg_native_guard_parallel_entry", callID: "call_native_guard_parallel_entry" }
    const contextMessages = toNativeHistory(h.history)
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            entry.messageID,
            entry.callID,
            "enter_housekeeping",
            {},
            { status: "running", created: 10 },
        ),
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    native.requiredTool("enter_housekeeping")
    native.requiredTool("leave_housekeeping")
    native.requireGuard()

    await assert.rejects(
        native.guard({
            tool: "multi_tool_use.parallel",
            input: {
                tool_uses: [
                    { recipient_name: "enter_housekeeping", parameters: {} },
                    { recipient_name: "read", parameters: { filePath: "example.ts" } },
                ],
            },
        }),
        /parallel|separately/i,
    )
    await native.execute("enter_housekeeping", {}, entry)
    await assert.rejects(
        native.guard({
            tool: "multi_tool_use.parallel",
            input: {
                tool_uses: [
                    { recipient_name: "leave_housekeeping", parameters: { force: true } },
                    { recipient_name: "read", parameters: { filePath: "example.ts" } },
                ],
            },
        }),
        /parallel|separately/i,
    )
    await assert.rejects(
        native.guard({
            tool: "multi_tool_use.parallel",
            input: {
                tool_uses: [
                    {
                        recipient_name: "multi_tool_use.parallel",
                        parameters: {
                            tool_uses: [
                                { recipient_name: "leave_housekeeping", parameters: { force: true } },
                                { recipient_name: "read", parameters: { filePath: "example.ts" } },
                            ],
                        },
                    },
                ],
            },
        }),
        /parallel|separately/i,
    )
    await native.execute(
        "leave_housekeeping",
        { force: true },
        { messageID: "msg_native_guard_parallel_leave", callID: "call_native_guard_parallel_leave" },
    )
})

test("native completed transcript projection keeps ordinary work and receipts without interior memo text", async (t) => {
    const sessionID = `ses_native_projection_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const entry = { messageID: "msg_native_projection_entry", callID: "call_native_projection_entry" }
    const edit = { messageID: "msg_native_projection_edit", callID: "call_native_projection_edit" }
    const leave = { messageID: "msg_native_projection_leave", callID: "call_native_projection_leave" }
    const contextMessages = toNativeHistory(h.history)
    contextMessages.push(
        nativeToolCallMessage(
            h.sessionID,
            entry.messageID,
            entry.callID,
            "enter_housekeeping",
            {},
            { status: "running", created: 10 },
        ),
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    await native.execute("enter_housekeeping", {}, entry)
    await native.execute(
        "edit_memo",
        { action: "append", textItems: ["Interior staged memo text."] },
        edit,
    )
    native.appendToolCall(edit.messageID, edit.callID, "edit_memo", {
        action: "append",
        textItems: ["Interior staged memo text."],
    }, { text: "Memo edited.", created: 20 })
    const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
    native.appendToolCall(leave.messageID, leave.callID, "leave_housekeeping", { force: true }, {
        text: receipt,
        created: 30,
    })

    const before = {
        id: "msg_native_projection_before",
        role: "assistant",
        content: [{ type: "text", text: "ordinary work before" }],
    }
    const entryCall = {
        id: entry.messageID,
        role: "assistant",
        content: [
            { type: "text", text: "entry thinking" },
            { type: "tool-call", id: entry.callID, name: "enter_housekeeping", input: {} },
        ],
    }
    const entryResult = {
        role: "tool",
        content: [
            {
                type: "tool-result",
                id: entry.callID,
                result: { type: "text", value: "entry guidance" },
            },
        ],
    }
    const editCall = {
        id: edit.messageID,
        role: "assistant",
        content: [
            { type: "text", text: "interior memo text Interior staged memo text." },
            {
                type: "tool-call",
                id: edit.callID,
                name: "edit_memo",
                input: { action: "append", textItems: ["Interior staged memo text."] },
            },
        ],
    }
    const editResult = {
        role: "tool",
        content: [
            {
                type: "tool-result",
                id: edit.callID,
                result: { type: "text", value: "Memo edited: Interior staged memo text." },
            },
        ],
    }
    const leaveCall = {
        id: leave.messageID,
        role: "assistant",
        content: [
            { type: "text", text: "leave thinking" },
            { type: "tool-call", id: leave.callID, name: "leave_housekeeping", input: { force: true } },
        ],
    }
    const leaveResult = {
        role: "tool",
        content: [
            {
                type: "tool-result",
                id: leave.callID,
                result: { type: "text", value: "raw leave result" },
            },
        ],
    }
    const after = {
        id: "msg_native_projection_after",
        role: "assistant",
        content: [{ type: "text", text: "ordinary work after" }],
    }
    const request = {
        sessionID: h.sessionID,
        options: {},
        messages: [
            before,
            entryCall,
            entryResult,
            editCall,
            editResult,
            leaveCall,
            leaveResult,
            after,
        ],
    }
    await native.projectContext(request)

    assert.deepEqual(request.messages[0], before)
    const projectedEntryResult = request.messages.find(
        (message: any) =>
            message.content?.some(
                (part: any) => part.type === "tool-result" && part.id === entry.callID,
            ),
    ) as any
    assert.equal(
        projectedEntryResult.content[0].result.value,
        `1 memo edit. ${HOUSEKEEPING_ENTRY_WITHOUT_COMPRESSION}`,
    )
    assert.equal(
        request.messages.some((message: any) => message.id === edit.messageID),
        false,
    )
    assert.equal(
        request.messages.some((message: any) =>
            message.content?.some(
                (part: any) => part.type === "tool-result" && part.id === edit.callID,
            ),
        ),
        false,
    )
    const projectedLeaveCall = request.messages.find(
        (message: any) => message.id === leave.messageID,
    ) as any
    assert.deepEqual(projectedLeaveCall.content, [leaveCall.content[1]])
    const projectedLeaveResult = request.messages.find(
        (message: any) =>
            message.content?.some(
                (part: any) => part.type === "tool-result" && part.id === leave.callID,
            ),
    ) as any
    assert.equal(projectedLeaveResult.content[0].result.value, receipt)
    assert.deepEqual(request.messages.at(-1), after)
    assert.equal(JSON.stringify(request).includes("Interior staged memo text."), false)
})

test("native system context appends guidance to the last part and preserves its cache and metadata", async (t) => {
    const sessionID = `ses_native_system_append_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
    })
    const first = {
        type: "text" as const,
        text: "First system source",
        cache: { read: true },
        metadata: { source: "instructions" },
    }
    const last = {
        type: "text" as const,
        text: "Last system source",
        cache: { write: ["base"] },
        metadata: { source: "agent", detail: { level: 2 } },
    }
    const firstSource = structuredClone(first)
    const lastSource = structuredClone(last)
    const request = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [first, last],
        messages: [],
        options: {},
    }

    await native.projectContext(request)

    assert.equal(request.system.length, 2)
    assert.deepEqual(request.system[0], firstSource)
    assert.deepEqual(last, lastSource)
    assert.notEqual(request.system[1], last)
    assert.equal(request.system[1].type, "text")
    assert.deepEqual(request.system[1].cache, lastSource.cache)
    assert.deepEqual(request.system[1].metadata, lastSource.metadata)
    assert.ok(request.system[1].text.startsWith(lastSource.text))
    assert.match(request.system[1].text, /context-constrained environment/)
    assert.ok(native.context.mock.callCount() > 0)
    for (const call of native.context.mock.calls)
        assert.deepEqual(call.arguments[0], { sessionID: h.sessionID })
    assert.ok(native.get.mock.callCount() > 0)
    for (const call of native.get.mock.calls)
        assert.deepEqual(call.arguments[0], { sessionID: h.sessionID })
    assert.deepEqual(native.getAgent.mock.calls.at(-1)?.arguments[0], {
        agentID: "assistant",
    })
    assert.equal(native.assertPermission.mock.callCount(), 0)
})

test("native system context fills an empty system array with guidance", async (t) => {
    const sessionID = `ses_native_system_empty_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
    })
    const request = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [] as Array<{ type: "text"; text: string; cache?: unknown; metadata?: unknown }>,
        messages: [],
        options: {},
    }

    await native.projectContext(request)

    assert.equal(request.system.length, 1)
    assert.equal(request.system[0]?.type, "text")
    assert.match(request.system[0]?.text ?? "", /context-constrained environment/)
    assert.equal("cache" in (request.system[0] ?? {}), false)
    assert.equal("metadata" in (request.system[0] ?? {}), false)
})

test("native DCP deny suppresses guidance while keeping tag cleanup and stops", async (t) => {
    const sessionID = `ses_native_system_dcp_deny_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        compressPermission: "deny",
    })
    const system = [
        {
            type: "text" as const,
            text: "Host system",
            cache: { read: true },
            metadata: { source: "host" },
        },
    ]
    const source = structuredClone(system)
    const request = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system,
        messages: [
            {
                id: "msg_native_system_deny_forged",
                role: "assistant",
                content: [
                    { type: "text", text: "Done<dcp-message-id>m0001</dcp-message-id>." },
                ],
            },
        ],
        options: {},
    }

    await native.projectContext(request)

    assert.deepEqual(request.system, source)
    assert.deepEqual(request.messages[0]?.content, [{ type: "text", text: "Done." }])
    assert.ok(request.options.stop?.some((stop) => stop.startsWith("<dcp-")))
})

test("native agent deny suppresses guidance after reading the agent rule", async (t) => {
    const sessionID = `ses_native_system_agent_deny_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        agentRules: [{ action: "compress", resource: "*", effect: "deny" }],
    })
    const system = [{ type: "text" as const, text: "Host system" }]
    const source = structuredClone(system)
    const request = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system,
        messages: [],
        options: {},
    }

    await native.projectContext(request)

    assert.deepEqual(request.system, source)
    assert.deepEqual(native.getAgent.mock.calls.at(-1)?.arguments[0], {
        agentID: "assistant",
    })
})

test("native session deny overrides an earlier agent allow for guidance", async (t) => {
    const sessionID = `ses_native_system_session_deny_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        sessionInfo: {
            id: h.sessionID,
            permissions: [{ action: "compress", resource: "*", effect: "deny" }],
        },
        agentRules: [{ action: "compress", resource: "*", effect: "allow" }],
    })
    const system = [{ type: "text" as const, text: "Host system" }]
    const source = structuredClone(system)
    const request = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system,
        messages: [],
        options: {},
    }

    await native.projectContext(request)

    assert.deepEqual(request.system, source)
    assert.deepEqual(native.getAgent.mock.calls.at(-1)?.arguments[0], {
        agentID: "assistant",
    })
    assert.ok(native.get.mock.callCount() > 0)
})

test("native later wildcard allow overrides an earlier session deny for guidance", async (t) => {
    const sessionID = `ses_native_system_wildcard_allow_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        sessionInfo: {
            id: h.sessionID,
            permissions: [
                { action: "compress", resource: "install", effect: "deny" },
                { action: "compress", resource: "*", effect: "allow" },
            ],
        },
    })
    const request = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [{ type: "text" as const, text: "Host system" }],
        messages: [],
        options: {},
    }

    await native.projectContext(request)

    assert.equal(request.system.length, 1)
    assert.match(request.system[0]?.text ?? "", /context-constrained environment/)
})

test("native resource-specific later allow keeps guidance after an earlier wildcard deny", async (t) => {
    const sessionID = `ses_native_system_resource_allow_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        sessionInfo: {
            id: h.sessionID,
            permissions: [
                { action: "compress", resource: "*", effect: "deny" },
                { action: "compress", resource: "install", effect: "allow" },
            ],
        },
    })
    const request = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [{ type: "text" as const, text: "Host system" }],
        messages: [],
        options: {},
    }

    await native.projectContext(request)

    assert.equal(request.system.length, 1)
    assert.match(request.system[0]?.text ?? "", /context-constrained environment/)
})

test("native ask permission yields guidance without calling permission.assert", async (t) => {
    const sessionID = `ses_native_system_ask_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        compressPermission: "ask",
    })
    const request = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [{ type: "text" as const, text: "Host system" }],
        messages: [],
        options: {},
    }

    await native.projectContext(request)

    assert.equal(request.system.length, 1)
    assert.match(request.system[0]?.text ?? "", /context-constrained environment/)
    assert.equal(native.assertPermission.mock.callCount(), 0)
})

test("native guidance skips all four internal agent signatures", async (t) => {
    const sessionID = `ses_native_system_internal_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
    })

    for (const signature of [
        "You are a title generator",
        "You are a helpful AI assistant tasked with summarizing conversations",
        "You are an anchored context summarization assistant for coding sessions",
        "Summarize what was done in this conversation",
    ]) {
        const system = [{ type: "text" as const, text: `${signature} for this request.` }]
        const source = structuredClone(system)
        const request = {
            sessionID: h.sessionID,
            agent: "assistant",
            model: { providerID: "test", id: "test" },
            system,
            messages: [],
            options: {},
        }

        await native.projectContext(request)

        assert.deepEqual(request.system, source, signature)
    }
})

test("native subagent suppression and allowed subagent rendering follow the configured policy", async (t) => {
    const sessionID = `ses_native_system_subagent_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const sessionInfo = { id: h.sessionID, parentID: "msg_parent_session" }

    const disabled = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        sessionInfo,
        allowSubAgents: false,
    })
    const disabledSystem = [{ type: "text" as const, text: "Host system" }]
    const disabledSource = structuredClone(disabledSystem)
    const disabledRequest = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: disabledSystem,
        messages: [],
        options: {},
    }

    await disabled.projectContext(disabledRequest)
    assert.deepEqual(disabledRequest.system, disabledSource)

    const allowed = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        sessionInfo,
        allowSubAgents: true,
    })
    const allowedRequest = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [{ type: "text" as const, text: "Host system" }],
        messages: [],
        options: {},
    }

    await allowed.projectContext(allowedRequest)

    const text = allowedRequest.system.map((part) => part.text).join("\n")
    assert.match(text, /context-constrained environment/)
    assert.match(text, /You are operating in a subagent environment/)
    assert.equal(text.includes("Manual mode is enabled."), false)
})

test("native configured initial manual mode renders the manual extension", async (t) => {
    const sessionID = `ses_native_system_manual_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        manualModeEnabled: true,
    })
    const request = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [{ type: "text" as const, text: "Host system" }],
        messages: [],
        options: {},
    }

    await native.projectContext(request)

    const text = request.system.map((part) => part.text).join("\n")
    assert.match(text, /context-constrained environment/)
    assert.match(text, /Manual mode is enabled/)
})

test("native system context propagates metadata read errors", async (t) => {
    const sessionID = `ses_native_system_metadata_error_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        getError: new Error("native session metadata read failed"),
    })
    const request = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [{ type: "text" as const, text: "Host system" }],
        messages: [],
        options: {},
    }

    await assert.rejects(native.projectContext(request), /metadata/i)
})

test("native system context propagates history read errors", async (t) => {
    const sessionID = `ses_native_system_history_error_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        contextError: new Error("native history read failed"),
    })
    const request = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [{ type: "text" as const, text: "Host system" }],
        messages: [],
        options: {},
    }

    await assert.rejects(native.projectContext(request), /history/i)
})

test("native system context propagates agent read errors", async (t) => {
    const sessionID = `ses_native_system_agent_error_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        agentError: new Error("native agent read failed"),
    })
    const request = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [{ type: "text" as const, text: "Host system" }],
        messages: [],
        options: {},
    }

    await assert.rejects(native.projectContext(request), /agent/i)
})

test("native context injects the committed memo at index zero before request messages", async (t) => {
    const sessionID = `ses_native_memo_context_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    await seedCommittedMemo(h, {
        action: "append",
        topics: [
            {
                topicTitle: "Plan",
                textItems: ["Keep parser boundary."],
                topics: [{ topicTitle: "Nested", textItems: ["Use documented API."] }],
            },
        ],
    })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
    })
    const user = {
        id: "msg_memo_user",
        role: "user",
        content: [{ type: "text", text: "Investigate the parser boundary." }],
        metadata: { source: "user-prompt" },
    }
    const assistant = {
        id: "msg_memo_assistant",
        role: "assistant",
        content: [
            { type: "text", text: "Checking the parser." },
            {
                type: "tool-call",
                id: "call_memo_read",
                name: "read",
                input: { path: "src/parser.ts" },
                metadata: { sequence: 4 },
            },
        ],
        metadata: { source: "assistant-turn" },
    }
    const tool = {
        role: "tool",
        content: [
            {
                type: "tool-result",
                id: "call_memo_read",
                result: { type: "text", value: "export const parser = true" },
                metadata: { truncated: false },
            },
        ],
        metadata: { source: "tool-turn" },
    }
    const messages = [user, assistant, tool]
    const sources = structuredClone(messages)
    const request = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [{ type: "text" as const, text: "Host system" }],
        messages,
        options: {},
    }

    await native.projectContext(request)

    assert.deepEqual(request.messages[0], {
        id: "msg_dcp_memo",
        role: "user",
        content: [
            {
                type: "text",
                text: "[Memo]\n# Plan\nKeep parser boundary.\n## Nested\nUse documented API.",
            },
        ],
    })
    assert.equal(request.messages.length, sources.length + 1)
    for (const [index, source] of sources.entries())
        assert.equal(request.messages[index + 1], messages[index], `message ${index} identity`)
    assert.deepEqual(messages, sources)
    assert.equal(request.messages[2], assistant)
    assert.equal(request.messages[3], tool)
    assert.deepEqual((request.messages[2] as any).content[1], sources[1].content[1])
    assert.deepEqual((request.messages[3] as any).content[0], sources[2].content[0])
})

test("native context skips memo injection without a nonempty request user message", async (t) => {
    const sessionID = `ses_native_memo_no_user_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    await seedCommittedMemo(h, { action: "append", textItems: ["Persisted memo."] })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
    })
    const assistant = {
        id: "msg_memo_no_user_assistant",
        role: "assistant",
        content: [{ type: "text", text: "No user turn yet." }],
    }
    const withoutUser = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [{ type: "text" as const, text: "Host system" }],
        messages: [assistant],
        options: {},
    }

    await native.projectContext(withoutUser)
    assert.deepEqual(withoutUser.messages, [assistant])

    const emptyUser = {
        id: "msg_memo_empty_user",
        role: "user",
        content: [],
    }
    const withEmptyUser = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [{ type: "text" as const, text: "Host system" }],
        messages: [emptyUser],
        options: {},
    }

    await native.projectContext(withEmptyUser)
    assert.deepEqual(withEmptyUser.messages, [emptyUser])
})

test("native context skips memo injection when the committed memo is empty", async (t) => {
    const sessionID = `ses_native_memo_empty_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
    })
    const messages = [
        {
            id: "msg_memo_empty_assistant",
            role: "assistant",
            content: [{ type: "text", text: "Ordinary work." }],
        },
        {
            id: "msg_memo_empty_prompt",
            role: "user",
            content: [{ type: "text", text: "Continue." }],
        },
    ]
    const sources = structuredClone(messages)
    const request = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [{ type: "text" as const, text: "Host system" }],
        messages,
        options: {},
    }

    await native.projectContext(request)

    assert.deepEqual(request.messages, sources)
    assert.equal(request.messages.length, 2)
})

test("native context injects only the committed memo while read_memo returns the staged memo", async (t) => {
    const sessionID = `ses_native_memo_staged_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedCompressedMemoFixture(h)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    assert.ok(native.tool("read_memo"))
    assert.equal((await native.readMemo()).content, "Committed memo.\nStaged memo.")
    const user = {
        id: "msg_memo_staged_user",
        role: "user",
        content: [{ type: "text", text: "Continue after compression." }],
    }
    const request = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [{ type: "text" as const, text: "Host system" }],
        messages: [user],
        options: {},
    }

    await native.projectContext(request)

    assert.deepEqual(request.messages[0], {
        id: "msg_dcp_memo",
        role: "user",
        content: [{ type: "text", text: "[Memo]\nCommitted memo." }],
    })
    assert.equal(request.messages.length, 2)
    assert.equal(request.messages[1], user)
    const text = JSON.stringify(request.messages)
    assert.equal(text.includes("Committed memo."), true)
    assert.equal(text.includes("Staged memo."), false)
})

test("native context injects each session's committed memo in one setup", async (t) => {
    const firstID = `ses_native_memo_first_${randomUUID()}`
    const first = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(firstID) })
    await seedCommittedMemo(first, { action: "append", textItems: ["First session memo."] })
    const secondID = `ses_native_memo_second_${randomUUID()}`
    const second = await createHousekeepingHarness(t, {
        messages: nativeFixtureMessages(secondID),
    })
    await seedCommittedMemo(second, { action: "append", textItems: ["Second session memo."] })
    const native = await createNativeHarness(t, {
        root: first.root,
        sessionID: first.sessionID,
        contextMessages: toNativeHistory(first.history),
    })
    native.setContextFor(second.sessionID, toNativeHistory(second.history))
    native.setSessionInfoFor(second.sessionID, { id: second.sessionID })
    const firstUser = {
        id: "msg_memo_first_user",
        role: "user",
        content: [{ type: "text", text: "First request." }],
    }
    const secondUser = {
        id: "msg_memo_second_user",
        role: "user",
        content: [{ type: "text", text: "Second request." }],
    }
    const firstRequest = {
        sessionID: first.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [{ type: "text" as const, text: "Host system" }],
        messages: [firstUser],
        options: {},
    }
    const secondRequest = {
        sessionID: second.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [{ type: "text" as const, text: "Host system" }],
        messages: [secondUser],
        options: {},
    }

    await native.projectContext(firstRequest)
    await native.projectContext(secondRequest)

    assert.deepEqual(firstRequest.messages[0], {
        id: "msg_dcp_memo",
        role: "user",
        content: [{ type: "text", text: "[Memo]\nFirst session memo." }],
    })
    assert.deepEqual(secondRequest.messages[0], {
        id: "msg_dcp_memo",
        role: "user",
        content: [{ type: "text", text: "[Memo]\nSecond session memo." }],
    })
    assert.equal(firstRequest.messages[1], firstUser)
    assert.equal(secondRequest.messages[1], secondUser)
    assert.equal(JSON.stringify(firstRequest.messages).includes("Second session memo."), false)
    assert.equal(JSON.stringify(secondRequest.messages).includes("First session memo."), false)
})

test("native context repeated projection replaces its own memo injection without duplicates", async (t) => {
    const sessionID = `ses_native_memo_repeat_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    await seedCommittedMemo(h, { action: "append", textItems: ["Repeated memo."] })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
    })
    const user = {
        id: "msg_memo_repeat_user",
        role: "user",
        content: [{ type: "text", text: "Repeat this request." }],
    }
    const assistant = {
        id: "msg_memo_repeat_assistant",
        role: "assistant",
        content: [
            { type: "text", text: "Repeat answer." },
            { type: "tool-call", id: "call_repeat", name: "read", input: { path: "a.ts" } },
        ],
    }
    const request = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [{ type: "text" as const, text: "Host system" }],
        messages: [user, assistant],
        options: {},
    }

    await native.projectContext(request)
    await native.projectContext(request)

    const memos = request.messages.filter((message: any) => message.id === "msg_dcp_memo")
    assert.equal(memos.length, 1)
    assert.deepEqual(memos[0], {
        id: "msg_dcp_memo",
        role: "user",
        content: [{ type: "text", text: "[Memo]\nRepeated memo." }],
    })
    assert.equal(request.messages.length, 3)
    assert.equal(request.messages[1], user)
    assert.equal(request.messages[2], assistant)
    assert.deepEqual((request.messages[2] as any).content[1], assistant.content[1])
})

test("native context keeps the committed memo under DCP compression deny", async (t) => {
    const sessionID = `ses_native_memo_deny_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    await seedCommittedMemo(h, { action: "append", textItems: ["Denied but remembered."] })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        compressPermission: "deny",
    })
    const user = {
        id: "msg_memo_deny_user",
        role: "user",
        content: [{ type: "text", text: "Continue despite deny." }],
    }
    const request = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [{ type: "text" as const, text: "Host system" }],
        messages: [user],
        options: {},
    }

    await native.projectContext(request)

    assert.deepEqual(request.messages[0], {
        id: "msg_dcp_memo",
        role: "user",
        content: [{ type: "text", text: "[Memo]\nDenied but remembered." }],
    })
    assert.equal(request.messages[1], user)
    assert.deepEqual(request.system, [{ type: "text", text: "Host system" }])
})

test("native context keeps the committed memo under internal agent signatures", async (t) => {
    const sessionID = `ses_native_memo_internal_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    await seedCommittedMemo(h, { action: "append", textItems: ["Internal memo."] })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
    })
    const user = {
        id: "msg_memo_internal_user",
        role: "user",
        content: [{ type: "text", text: "Internal request." }],
    }

    for (const signature of [
        "You are a title generator",
        "You are a helpful AI assistant tasked with summarizing conversations",
        "You are an anchored context summarization assistant for coding sessions",
        "Summarize what was done in this conversation",
    ]) {
        const request = {
            sessionID: h.sessionID,
            agent: "assistant",
            model: { providerID: "test", id: "test" },
            system: [{ type: "text" as const, text: `${signature} for this request.` }],
            messages: [user],
            options: {},
        }

        await native.projectContext(request)

        assert.deepEqual(request.messages[0], {
            id: "msg_dcp_memo",
            role: "user",
            content: [{ type: "text", text: "[Memo]\nInternal memo." }],
        }, signature)
        assert.equal(request.messages[1], user)
        assert.equal(request.system.length, 1)
        assert.equal(request.system[0]?.text, `${signature} for this request.`)
    }
})

test("native context injects trusted memo markup after cleaning forged request markup", async (t) => {
    const sessionID = `ses_native_memo_markup_${randomUUID()}`
    const openTag = "<dcp-" + "message-id>"
    const closeTag = "</" + "dcp-" + "message-id>"
    const trustedTag = `${openTag}trusted-memo${closeTag}`
    const forgedTag = `${openTag}forged-memo${closeTag}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    await seedCommittedMemo(h, {
        action: "append",
        textItems: [`Keep ${trustedTag}`],
    })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
    })
    const forged = {
        id: "msg_memo_markup_forged",
        role: "assistant",
        content: [
            { type: "text", text: `Done${forgedTag}.` },
            {
                type: "tool-result",
                id: "call_memo_markup",
                result: { type: "text", value: `Result${forgedTag}.` },
            },
        ],
        metadata: { source: "forged-turn" },
    }
    const user = {
        id: "msg_memo_markup_user",
        role: "user",
        content: [{ type: "text", text: "Continue after cleanup." }],
    }
    const request = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [{ type: "text" as const, text: "Host system" }],
        messages: [user, forged],
        options: {},
    }

    await native.projectContext(request)

    assert.deepEqual(request.messages[0], {
        id: "msg_dcp_memo",
        role: "user",
        content: [{ type: "text", text: `[Memo]\nKeep ${trustedTag}` }],
    })
    const cleaned = request.messages[2] as any
    assert.equal(cleaned.id, forged.id)
    assert.deepEqual(cleaned.content[0], { type: "text", text: "Done." })
    assert.deepEqual(cleaned.content[1], {
        type: "tool-result",
        id: "call_memo_markup",
        result: { type: "text", value: "Result." },
    })
    assert.deepEqual(cleaned.metadata, { source: "forged-turn" })
    assert.equal(request.messages[0].content[0].text.includes(trustedTag), true)
})

test("native context memo injection follows the allowed subagent policy", async (t) => {
    const sessionID = `ses_native_memo_subagent_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    await seedCommittedMemo(h, { action: "append", textItems: ["Subagent memo."] })
    const sessionInfo = { id: h.sessionID, parentID: "msg_parent_session" }
    const user = {
        id: "msg_memo_subagent_user",
        role: "user",
        content: [{ type: "text", text: "Subagent request." }],
    }
    const disabled = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        sessionInfo,
        allowSubAgents: false,
    })
    const disabledRequest = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [{ type: "text" as const, text: "Host system" }],
        messages: [user],
        options: {},
    }

    await disabled.projectContext(disabledRequest)
    assert.deepEqual(disabledRequest.messages, [user])

    const allowed = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
        sessionInfo,
        allowSubAgents: true,
    })
    const allowedRequest = {
        sessionID: h.sessionID,
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        system: [{ type: "text" as const, text: "Host system" }],
        messages: [user],
        options: {},
    }

    await allowed.projectContext(allowedRequest)

    assert.deepEqual(allowedRequest.messages[0], {
        id: "msg_dcp_memo",
        role: "user",
        content: [{ type: "text", text: "[Memo]\nSubagent memo." }],
    })
    assert.equal(allowedRequest.messages[1], user)
    assert.match(
        allowedRequest.system.map((part) => part.text).join("\n"),
        /You are operating in a subagent environment/,
    )
})

test("native fetch_summary_versions registers a native schema and returns the stripped original summary", async (t) => {
    const sessionID = `ses_native_versions_register_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h)
    const persisted = await persistedBlock(h.sessionID)
    assert.match(String(persisted?.summary), /\[Compressed conversation section\]/)
    assert.match(String(persisted?.summary), /<dcp-message-id/)

    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    const definition = native.requiredTool("fetch_summary_versions")
    assert.equal(definition.input?.type, "object")
    assert.equal(definition.input?.additionalProperties, false)
    assert.deepEqual(definition.input?.required, ["blockId"])
    assert.equal(definition.input?.properties?.blockId?.type, "number")
    assert.equal(definition.input?.properties?.version?.type, "number")
    assert.equal(definition.input?.required?.includes("version"), false)
    assert.equal(definition.options?.codemode, false)
    assert.match(definition.description, /Fetch all summary versions for a compressed block/)
    assert.match(definition.description, /THE FORMAT/)

    const listing = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.equal(typeof listing, "string")
    assert.match(listing, /Block #1 — Parser/)
    assert.match(listing, /Status: active/)
    assert.match(listing, /Active version: v1 \(original\)/)
    assert.match(listing, /1 version\(s\) available/)
    assert.match(listing, /v1 \(original\): Original parser findings\./)
    assert.equal(listing.includes("[Compressed conversation section]"), false)
    assert.equal(listing.includes("<dcp-message-id"), false)

    assert.equal(
        await native.execute("fetch_summary_versions", { blockId: 1, version: 1 }),
        "Block #1 — Parser\nv1 (original):\n\nOriginal parser findings.",
    )
})

test("native fetch_summary_versions lists committed rewrites and fetches explicit versions", async (t) => {
    const sessionID = `ses_native_versions_committed_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h, {
        original: "Original parser findings.",
        committedRewrites: ["First parser rewrite.", "Second parser rewrite."],
    })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })

    const listing = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(listing, /Active version: v3 \(rewrite\)/)
    assert.match(listing, /3 version\(s\) available/)
    assert.match(listing, /v1 \(original\): Original parser findings\./)
    assert.match(listing, /v2 \(rewrite\): First parser rewrite\./)
    assert.match(listing, /v3 \(rewrite\): Second parser rewrite\.\s+← active/)
    assert.equal(
        await native.execute("fetch_summary_versions", { blockId: 1, version: 1 }),
        "Block #1 — Parser\nv1 (original):\n\nOriginal parser findings.",
    )
    assert.equal(
        await native.execute("fetch_summary_versions", { blockId: 1, version: 2 }),
        "Block #1 — Parser\nv2 (rewrite):\n\nFirst parser rewrite.",
    )
    assert.equal(
        await native.execute("fetch_summary_versions", { blockId: 1, version: 3 }),
        "Block #1 — Parser\nv3 (rewrite):\n\nSecond parser rewrite.",
    )
})

test("native fetch_summary_versions reads the staged rewrite and pending buffer without publishing", async (t) => {
    const sessionID = `ses_native_versions_staged_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h, {
        original: "Original parser findings.",
        stagedRewrite: "Staged parser rewrite.",
        stagedAppend: " Appended detail.",
    })
    const before = await persistedBlock(h.sessionID)
    assert.equal(before?.activeVersionIndex, 1)
    assert.deepEqual(before?.summaryVersions, [])
    assert.equal(before?.pendingEditBuffer, undefined)

    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    const first = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(first, /Active version: v2 \(rewrite\)/)
    assert.match(first, /2 version\(s\) available/)
    assert.match(first, /v1 \(original\): Original parser findings\./)
    assert.match(first, /v2 \(rewrite\): Staged parser rewrite\.\s+← active/)
    assert.match(first, /Pending edit buffer \(\d+ chars\):/)
    assert.match(first, /Staged parser rewrite\. Appended detail\./)
    assert.match(first, /pending changes remain staged/)
    assert.equal(
        await native.execute("fetch_summary_versions", { blockId: 1, version: 2 }),
        "Block #1 — Parser\nv2 (rewrite):\n\nStaged parser rewrite.",
    )

    const second = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.equal(second, first)
    assert.doesNotMatch(second, /3 version\(s\) available/)
    assert.match(second, /Pending edit buffer/)

    const after = await persistedBlock(h.sessionID)
    assert.equal(after?.activeVersionIndex, 1)
    assert.deepEqual(after?.summaryVersions, [])
    assert.equal(after?.pendingEditBuffer, undefined)
})

test("native fetch_summary_versions rejects missing blocks and invalid versions", async (t) => {
    const sessionID = `ses_native_versions_errors_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })

    await assert.rejects(
        native.execute("fetch_summary_versions", { blockId: 999 }),
        /Block 999 not found/,
    )
    for (const version of [0, -1, 99]) {
        await assert.rejects(
            native.execute("fetch_summary_versions", { blockId: 1, version }),
            new RegExp(`Version ${version} not found for block 1\\.`),
        )
    }
})

test("native fetch_summary_versions keeps two persisted sessions isolated in one setup", async (t) => {
    const firstSessionID = `ses_native_versions_isolated_first_${randomUUID()}`
    const first = await createHousekeepingHarness(t, {
        messages: nativeFixtureMessages(firstSessionID),
    })
    const firstContext = await seedVersionedSummaryFixture(first, {
        original: "First original findings.",
        committedRewrites: ["First rewrite."],
    })
    const secondSessionID = `ses_native_versions_isolated_second_${randomUUID()}`
    const second = await createHousekeepingHarness(t, {
        messages: nativeFixtureMessages(secondSessionID),
    })
    const secondContext = await seedVersionedSummaryFixture(second, {
        original: "Second original findings.",
        committedRewrites: ["Second rewrite."],
    })
    const native = await createNativeHarness(t, {
        root: first.root,
        sessionID: first.sessionID,
        contextMessages: firstContext,
    })
    native.setContextFor(second.sessionID, secondContext)
    native.setSessionInfoFor(first.sessionID, { id: first.sessionID })
    native.setSessionInfoFor(second.sessionID, { id: second.sessionID })

    const firstListing = await native.execute(
        "fetch_summary_versions",
        { blockId: 1 },
        { sessionID: first.sessionID },
    )
    const secondListing = await native.execute(
        "fetch_summary_versions",
        { blockId: 1 },
        { sessionID: second.sessionID },
    )
    assert.match(firstListing, /First original findings\./)
    assert.match(firstListing, /First rewrite\./)
    assert.equal(firstListing.includes("Second"), false)
    assert.match(secondListing, /Second original findings\./)
    assert.match(secondListing, /Second rewrite\./)
    assert.equal(secondListing.includes("First"), false)
    assert.equal(
        await native.execute(
            "fetch_summary_versions",
            { blockId: 1, version: 2 },
            { sessionID: first.sessionID },
        ),
        "Block #1 — Parser\nv2 (rewrite):\n\nFirst rewrite.",
    )
    assert.equal(
        await native.execute(
            "fetch_summary_versions",
            { blockId: 1, version: 2 },
            { sessionID: second.sessionID },
        ),
        "Block #1 — Parser\nv2 (rewrite):\n\nSecond rewrite.",
    )
})

test("native fetch_summary_versions asserts permission before any session read", async (t) => {
    const sessionID = `ses_native_versions_permission_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        assertError: new Error("permission denied"),
    })
    const messageID = "msg_native_versions_permission"
    const callID = "call_native_versions_permission"
    native.requiredTool("fetch_summary_versions")

    let returned: unknown
    await assert.rejects(async () => {
        returned = await native.execute(
            "fetch_summary_versions",
            { blockId: 1 },
            { messageID, callID },
        )
    }, /permission|denied/i)
    assert.equal(returned, undefined)
    assert.equal(native.context.mock.callCount(), 0)
    assert.equal(native.get.mock.callCount(), 0)
    assert.deepEqual(native.assertPermission.mock.calls.at(-1)?.arguments[0], {
        sessionID: h.sessionID,
        agent: "assistant",
        action: "fetch_summary_versions",
        resources: ["*"],
        source: { type: "tool", messageID, id: callID },
    })
})

test("native fetch_summary_versions propagates history and metadata read failures", async (t) => {
    const sessionID = `ses_native_versions_failures_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h)

    const historyFailure = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        contextError: new Error("native history read failed"),
    })
    assert.ok(historyFailure.tool("fetch_summary_versions"))
    await assert.rejects(
        historyFailure.execute("fetch_summary_versions", { blockId: 1 }),
        /history/i,
    )

    const metadataFailure = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        getError: new Error("native session metadata read failed"),
    })
    assert.ok(metadataFailure.tool("fetch_summary_versions"))
    await assert.rejects(
        metadataFailure.execute("fetch_summary_versions", { blockId: 1 }),
        /metadata/i,
    )
})

test("native fetch_summary_versions follows the subagent policy", async (t) => {
    const sessionID = `ses_native_versions_subagent_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h)
    const sessionInfo = { id: h.sessionID, parentID: "msg_parent_session" }

    const disallowed = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        sessionInfo,
        allowSubAgents: false,
    })
    assert.ok(disallowed.tool("fetch_summary_versions"))
    await assert.rejects(
        disallowed.execute("fetch_summary_versions", { blockId: 1 }),
        /subagent|sub-agent|parent/i,
    )

    const allowed = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        sessionInfo,
        allowSubAgents: true,
    })
    assert.ok(allowed.tool("fetch_summary_versions"))
    assert.match(
        await allowed.execute("fetch_summary_versions", { blockId: 1 }),
        /Original parser findings\./,
    )
})

test("native fetch_summary_versions is omitted by DCP deny and disabled setup", async (t) => {
    const sessionID = `ses_native_versions_omitted_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h)

    const denied = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        compressPermission: "deny",
    })
    assert.equal(denied.tool("fetch_summary_versions"), undefined)

    const disabled = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        enabled: false,
    })
    assert.equal(disabled.tool("fetch_summary_versions"), undefined)
    assert.deepEqual(disabled.definitions, [])
})

function pushNativeRunningCall(
    messages: NativeMessage[],
    sessionID: string,
    messageID: string,
    callID: string,
    name: string,
    input: Record<string, unknown> = {},
    created = 10,
): void {
    messages.push(
        nativeToolCallMessage(sessionID, messageID, callID, name, input, {
            status: "running",
            created,
        }),
    )
}

test("native append_summary registers a native schema and stages text over the original summary", async (t) => {
    const sessionID = `ses_native_append_register_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h, {
        original: "Original parser findings.",
    })
    const entry = { messageID: "msg_native_append_entry", callID: "call_native_append_entry" }
    pushNativeRunningCall(
        contextMessages,
        h.sessionID,
        entry.messageID,
        entry.callID,
        "enter_housekeeping",
    )
    const before = await persistedBlock(h.sessionID)
    assert.equal(before?.activeVersionIndex, 1)
    assert.deepEqual(before?.summaryVersions, [])

    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    const definition = native.requiredTool("append_summary")
    assert.equal(definition.input?.type, "object")
    assert.equal(definition.input?.additionalProperties, false)
    assert.equal(definition.input?.required?.length, 2)
    assert.ok(definition.input?.required?.includes("blockId"))
    assert.ok(definition.input?.required?.includes("text"))
    assert.equal(definition.input?.properties?.blockId?.type, "number")
    assert.equal(definition.input?.properties?.text?.type, "string")
    assert.equal(definition.options?.codemode, false)
    assert.match(definition.description, /Append text to a block's summary editing buffer/)
    assert.match(definition.description, /THE FORMAT/)

    await native.execute("enter_housekeeping", {}, entry)
    const append = {
        messageID: "msg_native_append_stage",
        callID: "call_native_append_stage",
    }
    const result = await native.execute(
        "append_summary",
        { blockId: 1, text: " Added detail." },
        append,
    )
    assert.match(result, /Appended to summary for block 1/)
    assert.match(result, /staged/)
    native.appendToolCall(
        append.messageID,
        append.callID,
        "append_summary",
        { blockId: 1, text: " Added detail." },
        { text: result, created: 20 },
    )

    const listing = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(listing, /Pending edit buffer/)
    assert.match(listing, /Original parser findings\. Added detail\./)
    assert.match(listing, /1 version\(s\) available/)

    const after = await persistedBlock(h.sessionID)
    assert.equal(after?.activeVersionIndex, 1)
    assert.deepEqual(after?.summaryVersions, [])
    assert.equal(after?.pendingEditBuffer, undefined)
})

test("native append_summary accumulates successive appends into one pending buffer", async (t) => {
    const sessionID = `ses_native_append_accumulate_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h, {
        original: "Original parser findings.",
    })
    const entry = {
        messageID: "msg_native_append_accumulate_entry",
        callID: "call_native_append_accumulate_entry",
    }
    pushNativeRunningCall(
        contextMessages,
        h.sessionID,
        entry.messageID,
        entry.callID,
        "enter_housekeeping",
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    await native.execute("enter_housekeeping", {}, entry)

    const first = {
        messageID: "msg_native_append_accumulate_first",
        callID: "call_native_append_accumulate_first",
    }
    const firstResult = await native.execute(
        "append_summary",
        { blockId: 1, text: " First." },
        first,
    )
    native.appendToolCall(
        first.messageID,
        first.callID,
        "append_summary",
        { blockId: 1, text: " First." },
        { text: firstResult, created: 20 },
    )
    const second = {
        messageID: "msg_native_append_accumulate_second",
        callID: "call_native_append_accumulate_second",
    }
    const secondResult = await native.execute(
        "append_summary",
        { blockId: 1, text: " Second." },
        second,
    )
    native.appendToolCall(
        second.messageID,
        second.callID,
        "append_summary",
        { blockId: 1, text: " Second." },
        { text: secondResult, created: 30 },
    )

    const listing = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(listing, /Original parser findings\. First\. Second\./)
    assert.match(listing, /1 version\(s\) available/)
})

test("native append_summary retries the same message and call once, including a fresh native setup", async (t) => {
    const sessionID = `ses_native_append_retry_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h, {
        original: "Original parser findings.",
    })
    const entry = {
        messageID: "msg_native_append_retry_entry",
        callID: "call_native_append_retry_entry",
    }
    pushNativeRunningCall(
        contextMessages,
        h.sessionID,
        entry.messageID,
        entry.callID,
        "enter_housekeeping",
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    await native.execute("enter_housekeeping", {}, entry)

    const append = {
        messageID: "msg_native_append_retry_call",
        callID: "call_native_append_retry_call",
    }
    const input = { blockId: 1, text: " Retry-safe detail." }
    const firstResult = await native.execute("append_summary", input, append)
    native.appendToolCall(append.messageID, append.callID, "append_summary", input, {
        text: firstResult,
        created: 20,
    })
    const before = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(before, /Original parser findings\. Retry-safe detail\./)

    assert.equal(await native.execute("append_summary", input, append), firstResult)
    assert.equal(await native.execute("fetch_summary_versions", { blockId: 1 }), before)

    const fresh = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: native.getContext(),
    })
    assert.equal(await fresh.execute("append_summary", input, append), firstResult)
    assert.equal(await fresh.execute("fetch_summary_versions", { blockId: 1 }), before)

    const after = await persistedBlock(h.sessionID)
    assert.equal(after?.activeVersionIndex, 1)
    assert.deepEqual(after?.summaryVersions, [])
})

test("native append_summary applies the same text again from a different call", async (t) => {
    const sessionID = `ses_native_append_distinct_call_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h, {
        original: "Original parser findings.",
    })
    const entry = {
        messageID: "msg_native_append_distinct_entry",
        callID: "call_native_append_distinct_entry",
    }
    pushNativeRunningCall(
        contextMessages,
        h.sessionID,
        entry.messageID,
        entry.callID,
        "enter_housekeeping",
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    await native.execute("enter_housekeeping", {}, entry)

    for (const [index, callID] of ["call_native_append_repeat_first", "call_native_append_repeat_second"].entries()) {
        const messageID = `msg_native_append_repeat_${index}`
        const input = { blockId: 1, text: " Repeated detail." }
        const result = await native.execute("append_summary", input, { messageID, callID })
        native.appendToolCall(messageID, callID, "append_summary", input, {
            text: result,
            created: 20 + index,
        })
    }

    const listing = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(listing, /Original parser findings\. Repeated detail\. Repeated detail\./)
})

test("native forced leave commits one version from the staged append and a fresh setup sees it committed", async (t) => {
    const sessionID = `ses_native_append_leave_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h, {
        original: "Original parser findings.",
    })
    const entry = {
        messageID: "msg_native_append_leave_entry",
        callID: "call_native_append_leave_entry",
    }
    pushNativeRunningCall(
        contextMessages,
        h.sessionID,
        entry.messageID,
        entry.callID,
        "enter_housekeeping",
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    await native.execute("enter_housekeeping", {}, entry)

    const append = {
        messageID: "msg_native_append_leave_append",
        callID: "call_native_append_leave_append",
    }
    const appendInput = { blockId: 1, text: " Added detail." }
    const appendResult = await native.execute("append_summary", appendInput, append)
    native.appendToolCall(append.messageID, append.callID, "append_summary", appendInput, {
        text: appendResult,
        created: 20,
    })
    const before = await persistedBlock(h.sessionID)
    assert.equal(before?.activeVersionIndex, 1)
    assert.deepEqual(before?.summaryVersions, [])

    const leave = {
        messageID: "msg_native_append_leave_leave",
        callID: "call_native_append_leave_leave",
    }
    const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
    assert.match(receipt, /Housekeeping complete/)
    assert.match(receipt, /b1 v2/)
    native.appendToolCall(
        leave.messageID,
        leave.callID,
        "leave_housekeeping",
        { force: true },
        { text: receipt, created: 30 },
    )

    const committed = await persistedBlock(h.sessionID)
    assert.equal(committed?.activeVersionIndex, 2)
    assert.deepEqual(committed?.summaryVersions, ["Original parser findings. Added detail."])
    assert.equal(committed?.pendingEditBuffer, undefined)

    const fresh = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: native.getContext(),
    })
    const listing = await fresh.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(listing, /Active version: v2 \(rewrite\)/)
    assert.match(listing, /2 version\(s\) available/)
    assert.match(listing, /Original parser findings\. Added detail\./)
    assert.doesNotMatch(listing, /Pending edit buffer/)
    assert.equal(
        await fresh.execute("fetch_summary_versions", { blockId: 1, version: 2 }),
        "Block #1 — Parser\nv2 (rewrite):\n\nOriginal parser findings. Added detail.",
    )
})

test("native append_summary requires an active housekeeping transaction", async (t) => {
    const sessionID = `ses_native_append_no_entry_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h, {
        original: "Original parser findings.",
    })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })

    await assert.rejects(
        native.execute(
            "append_summary",
            { blockId: 1, text: " No entry." },
            { messageID: "msg_native_append_no_entry", callID: "call_native_append_no_entry" },
        ),
        /enter_housekeeping|before making/i,
    )
    const persisted = await persistedBlock(h.sessionID)
    assert.equal(persisted?.activeVersionIndex, 1)
    assert.deepEqual(persisted?.summaryVersions, [])
})

test("native append_summary rejects a missing block without corrupting the staged buffer", async (t) => {
    const sessionID = `ses_native_append_missing_block_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h, {
        original: "Original parser findings.",
    })
    const entry = {
        messageID: "msg_native_append_missing_entry",
        callID: "call_native_append_missing_entry",
    }
    pushNativeRunningCall(
        contextMessages,
        h.sessionID,
        entry.messageID,
        entry.callID,
        "enter_housekeeping",
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    await native.execute("enter_housekeeping", {}, entry)

    const append = {
        messageID: "msg_native_append_missing_retained",
        callID: "call_native_append_missing_retained",
    }
    const input = { blockId: 1, text: " Retained detail." }
    const result = await native.execute("append_summary", input, append)
    native.appendToolCall(append.messageID, append.callID, "append_summary", input, {
        text: result,
        created: 20,
    })

    await assert.rejects(
        native.execute(
            "append_summary",
            { blockId: 999, text: " Wrong block." },
            { messageID: "msg_native_append_missing_block", callID: "call_native_append_missing_block" },
        ),
        /Block 999 not found/,
    )
    const listing = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(listing, /Original parser findings\. Retained detail\./)
    assert.doesNotMatch(listing, /Wrong block\./)

    const leave = {
        messageID: "msg_native_append_missing_leave",
        callID: "call_native_append_missing_leave",
    }
    const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
    native.appendToolCall(
        leave.messageID,
        leave.callID,
        "leave_housekeeping",
        { force: true },
        { text: receipt, created: 30 },
    )
    const committed = await persistedBlock(h.sessionID)
    assert.equal(committed?.activeVersionIndex, 2)
    assert.deepEqual(committed?.summaryVersions, ["Original parser findings. Retained detail."])
})

test("native append_summary accepts empty text and preserves the current summary text", async (t) => {
    const sessionID = `ses_native_append_empty_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h, {
        original: "Original parser findings.",
    })
    const entry = {
        messageID: "msg_native_append_empty_entry",
        callID: "call_native_append_empty_entry",
    }
    pushNativeRunningCall(
        contextMessages,
        h.sessionID,
        entry.messageID,
        entry.callID,
        "enter_housekeeping",
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    await native.execute("enter_housekeeping", {}, entry)

    const append = {
        messageID: "msg_native_append_empty_append",
        callID: "call_native_append_empty_append",
    }
    const input = { blockId: 1, text: "" }
    const result = await native.execute("append_summary", input, append)
    assert.match(result, /Appended to summary for block 1/)
    native.appendToolCall(append.messageID, append.callID, "append_summary", input, {
        text: result,
        created: 20,
    })

    const listing = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(listing, /Pending edit buffer/)
    assert.match(listing, /Original parser findings\./)
    assert.doesNotMatch(listing, /Added/)

    const leave = {
        messageID: "msg_native_append_empty_leave",
        callID: "call_native_append_empty_leave",
    }
    const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
    native.appendToolCall(
        leave.messageID,
        leave.callID,
        "leave_housekeeping",
        { force: true },
        { text: receipt, created: 30 },
    )
    const committed = await persistedBlock(h.sessionID)
    assert.equal(committed?.activeVersionIndex, 2)
    assert.deepEqual(committed?.summaryVersions, ["Original parser findings."])
})

test("native append_summary keeps two sessions' staged buffers isolated in one setup", async (t) => {
    const firstSessionID = `ses_native_append_isolated_first_${randomUUID()}`
    const first = await createHousekeepingHarness(t, {
        messages: nativeFixtureMessages(firstSessionID),
    })
    const firstContext = await seedVersionedSummaryFixture(first, {
        original: "First original findings.",
    })
    const secondSessionID = `ses_native_append_isolated_second_${randomUUID()}`
    const second = await createHousekeepingHarness(t, {
        messages: nativeFixtureMessages(secondSessionID),
    })
    const secondContext = await seedVersionedSummaryFixture(second, {
        original: "Second original findings.",
    })
    const firstEntry = {
        messageID: "msg_native_append_isolated_first_entry",
        callID: "call_native_append_isolated_first_entry",
    }
    const secondEntry = {
        messageID: "msg_native_append_isolated_second_entry",
        callID: "call_native_append_isolated_second_entry",
    }
    pushNativeRunningCall(
        firstContext,
        first.sessionID,
        firstEntry.messageID,
        firstEntry.callID,
        "enter_housekeeping",
    )
    pushNativeRunningCall(
        secondContext,
        second.sessionID,
        secondEntry.messageID,
        secondEntry.callID,
        "enter_housekeeping",
    )

    const native = await createNativeHarness(t, {
        root: first.root,
        sessionID: first.sessionID,
        contextMessages: firstContext,
    })
    native.setContextFor(second.sessionID, secondContext)
    native.setSessionInfoFor(first.sessionID, { id: first.sessionID })
    native.setSessionInfoFor(second.sessionID, { id: second.sessionID })

    await native.execute("enter_housekeeping", {}, firstEntry)
    await native.execute(
        "enter_housekeeping",
        {},
        { ...secondEntry, sessionID: second.sessionID },
    )
    const firstAppend = {
        messageID: "msg_native_append_isolated_first_append",
        callID: "call_native_append_isolated_first_append",
    }
    const firstInput = { blockId: 1, text: " First appended detail." }
    const firstResult = await native.execute("append_summary", firstInput, firstAppend)
    native.appendToolCall(
        firstAppend.messageID,
        firstAppend.callID,
        "append_summary",
        firstInput,
        { text: firstResult, created: 20 },
    )
    const secondAppend = {
        messageID: "msg_native_append_isolated_second_append",
        callID: "call_native_append_isolated_second_append",
    }
    const secondInput = { blockId: 1, text: " Second appended detail." }
    const secondResult = await native.execute("append_summary", secondInput, {
        ...secondAppend,
        sessionID: second.sessionID,
    })
    native.appendToolCall(
        secondAppend.messageID,
        secondAppend.callID,
        "append_summary",
        secondInput,
        { sessionID: second.sessionID, text: secondResult, created: 20 },
    )

    const firstListing = await native.execute(
        "fetch_summary_versions",
        { blockId: 1 },
        { sessionID: first.sessionID },
    )
    const secondListing = await native.execute(
        "fetch_summary_versions",
        { blockId: 1 },
        { sessionID: second.sessionID },
    )
    assert.match(firstListing, /First original findings\. First appended detail\./)
    assert.equal(firstListing.includes("Second"), false)
    assert.match(secondListing, /Second original findings\. Second appended detail\./)
    assert.equal(secondListing.includes("First"), false)
})

test("native append_summary asserts permission before any session read and reports its native source", async (t) => {
    const sessionID = `ses_native_append_permission_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h, {
        original: "Original parser findings.",
    })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        assertError: new Error("permission denied"),
    })
    const messageID = "msg_native_append_permission"
    const callID = "call_native_append_permission"
    native.requiredTool("append_summary")

    let returned: unknown
    await assert.rejects(async () => {
        returned = await native.execute(
            "append_summary",
            { blockId: 1, text: " Denied detail." },
            { messageID, callID },
        )
    }, /permission|denied/i)
    assert.equal(returned, undefined)
    assert.equal(native.context.mock.callCount(), 0)
    assert.equal(native.get.mock.callCount(), 0)
    assert.deepEqual(native.assertPermission.mock.calls.at(-1)?.arguments[0], {
        sessionID: h.sessionID,
        agent: "assistant",
        action: "append_summary",
        resources: ["*"],
        source: { type: "tool", messageID, id: callID },
    })
})

test("native append_summary propagates history and metadata read failures", async (t) => {
    const sessionID = `ses_native_append_failures_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h, {
        original: "Original parser findings.",
    })

    const historyFailure = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        contextError: new Error("native history read failed"),
    })
    assert.ok(historyFailure.tool("append_summary"))
    await assert.rejects(
        historyFailure.execute("append_summary", { blockId: 1, text: " Detail." }),
        /history/i,
    )

    const metadataFailure = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        getError: new Error("native session metadata read failed"),
    })
    assert.ok(metadataFailure.tool("append_summary"))
    await assert.rejects(
        metadataFailure.execute("append_summary", { blockId: 1, text: " Detail." }),
        /metadata/i,
    )
})

test("native append_summary follows the subagent policy", async (t) => {
    const sessionID = `ses_native_append_subagent_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h, {
        original: "Original parser findings.",
    })
    const sessionInfo = { id: h.sessionID, parentID: "msg_parent_session" }

    const disallowed = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        sessionInfo,
        allowSubAgents: false,
    })
    assert.ok(disallowed.tool("append_summary"))
    await assert.rejects(
        disallowed.execute("append_summary", { blockId: 1, text: " Denied detail." }),
        /subagent|sub-agent|parent/i,
    )

    const entry = {
        messageID: "msg_native_append_subagent_entry",
        callID: "call_native_append_subagent_entry",
    }
    pushNativeRunningCall(
        contextMessages,
        h.sessionID,
        entry.messageID,
        entry.callID,
        "enter_housekeeping",
    )
    const allowed = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        sessionInfo,
        allowSubAgents: true,
    })
    await allowed.execute("enter_housekeeping", {}, entry)
    const append = {
        messageID: "msg_native_append_subagent_append",
        callID: "call_native_append_subagent_append",
    }
    const input = { blockId: 1, text: " Allowed detail." }
    const result = await allowed.execute("append_summary", input, append)
    allowed.appendToolCall(append.messageID, append.callID, "append_summary", input, {
        text: result,
        created: 20,
    })
    assert.match(
        await allowed.execute("fetch_summary_versions", { blockId: 1 }),
        /Original parser findings\. Allowed detail\./,
    )
})

test("native append_summary is omitted by DCP deny and disabled setup", async (t) => {
    const sessionID = `ses_native_append_omitted_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h, {
        original: "Original parser findings.",
    })

    const denied = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        compressPermission: "deny",
    })
    assert.equal(denied.tool("append_summary"), undefined)

    const disabled = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        enabled: false,
    })
    assert.equal(disabled.tool("append_summary"), undefined)
    assert.deepEqual(disabled.definitions, [])
})

async function seedNativeEditCommittedBlock(
    t: TestContext,
    options: { original?: string; committedRewrites?: string[] } = {},
) {
    const sessionID = `ses_native_edit_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h, options)
    return { h, contextMessages }
}

async function enterNativeEditTransaction(
    t: TestContext,
    h: Awaited<ReturnType<typeof createHousekeepingHarness>>,
    contextMessages: NativeMessage[],
    options: Pick<NativeHarnessOptions, "sessionInfo" | "allowSubAgents"> = {},
) {
    const suffix = nextNativeFixtureSuffix()
    const entry = {
        messageID: `msg_native_edit_entry_${suffix}`,
        callID: `call_native_edit_entry_${suffix}`,
    }
    pushNativeRunningCall(
        contextMessages,
        h.sessionID,
        entry.messageID,
        entry.callID,
        "enter_housekeeping",
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        ...options,
    })
    await native.execute("enter_housekeeping", {}, entry)
    return { native, entry }
}

async function recordNativeToolResult(
    native: Awaited<ReturnType<typeof createNativeHarness>>,
    name:
        | "edit_summary"
        | "append_summary"
        | "rewrite_summary"
        | "toggle_summary_version"
        | "expand_block",
    input: Record<string, unknown>,
    identity: { messageID: string; callID: string; sessionID?: string; created?: number },
): Promise<string> {
    const result = await native.execute(name, input, identity)
    native.appendToolCall(identity.messageID, identity.callID, name, input, {
        ...(identity.sessionID === undefined ? {} : { sessionID: identity.sessionID }),
        text: result,
        created: identity.created ?? 20,
    })
    return result
}

test("native edit_summary registers a native schema and stages an edited summary", async (t) => {
    const { h, contextMessages } = await seedNativeEditCommittedBlock(t)
    const { native } = await enterNativeEditTransaction(t, h, contextMessages)
    const definition = native.requiredTool("edit_summary")
    assert.equal(definition.input?.type, "object")
    assert.equal(definition.input?.additionalProperties, false)
    assert.equal(definition.input?.required?.length, 3)
    assert.ok(definition.input?.required?.includes("blockId"))
    assert.ok(definition.input?.required?.includes("oldString"))
    assert.ok(definition.input?.required?.includes("newString"))
    assert.equal(definition.input?.required?.includes("replaceAll"), false)
    assert.equal(definition.input?.properties?.blockId?.type, "number")
    assert.equal(definition.input?.properties?.oldString?.type, "string")
    assert.equal(definition.input?.properties?.newString?.type, "string")
    assert.equal(definition.input?.properties?.replaceAll?.type, "boolean")
    assert.equal(definition.options?.codemode, false)
    assert.match(definition.description, /Replace text in a block's summary editing buffer/)
    assert.match(definition.description, /THE FORMAT/)

    const edit = {
        messageID: "msg_native_edit_register",
        callID: "call_native_edit_register",
    }
    const result = await recordNativeToolResult(
        native,
        "edit_summary",
        { blockId: 1, oldString: "parser", newString: "Lexer" },
        edit,
    )
    assert.match(result, /Edited summary for block 1/)
    assert.match(result, /staged/)

    const listing = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(listing, /Pending edit buffer/)
    assert.match(listing, /Original Lexer findings\./)

    const before = await persistedBlock(h.sessionID)
    assert.equal(before?.activeVersionIndex, 1)
    assert.deepEqual(before?.summaryVersions, [])
})

for (const replaceAll of [undefined, false]) {
    const label = replaceAll === undefined ? "omitted" : "false"
    test(`native edit_summary replaces only the first occurrence when replaceAll is ${label}`, async (t) => {
        const { h, contextMessages } = await seedNativeEditCommittedBlock(t)
        const { native } = await enterNativeEditTransaction(t, h, contextMessages)
        await recordNativeToolResult(
            native,
            "append_summary",
            { blockId: 1, text: " Alpha Alpha tail." },
            {
                messageID: `msg_native_edit_first_append_${label}`,
                callID: `call_native_edit_first_append_${label}`,
            },
        )
        const input =
            replaceAll === undefined
                ? { blockId: 1, oldString: "Alpha", newString: "Beta" }
                : { blockId: 1, oldString: "Alpha", newString: "Beta", replaceAll }
        await recordNativeToolResult(native, "edit_summary", input, {
            messageID: `msg_native_edit_first_edit_${label}`,
            callID: `call_native_edit_first_edit_${label}`,
        })

        const listing = await native.execute("fetch_summary_versions", { blockId: 1 })
        assert.match(listing, /Original parser findings\. Beta Alpha tail\./)
        assert.doesNotMatch(listing, /Beta Beta tail\./)
    })
}

test("native edit_summary replaces every occurrence when replaceAll is true", async (t) => {
    const { h, contextMessages } = await seedNativeEditCommittedBlock(t)
    const { native } = await enterNativeEditTransaction(t, h, contextMessages)
    await recordNativeToolResult(
        native,
        "append_summary",
        { blockId: 1, text: " Alpha Alpha tail." },
        {
            messageID: "msg_native_edit_all_append",
            callID: "call_native_edit_all_append",
        },
    )
    await recordNativeToolResult(
        native,
        "edit_summary",
        { blockId: 1, oldString: "Alpha", newString: "Beta", replaceAll: true },
        {
            messageID: "msg_native_edit_all_edit",
            callID: "call_native_edit_all_edit",
        },
    )

    const listing = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(listing, /Original parser findings\. Beta Beta tail\./)
    assert.doesNotMatch(listing, /Beta Alpha tail\./)
})

test("native edit_summary edits a buffer produced by an earlier append and edit", async (t) => {
    const { h, contextMessages } = await seedNativeEditCommittedBlock(t)
    const { native } = await enterNativeEditTransaction(t, h, contextMessages)
    await recordNativeToolResult(
        native,
        "append_summary",
        { blockId: 1, text: " Red Red tail." },
        {
            messageID: "msg_native_edit_chain_append",
            callID: "call_native_edit_chain_append",
        },
    )
    await recordNativeToolResult(
        native,
        "edit_summary",
        { blockId: 1, oldString: "Red", newString: "Green", replaceAll: false },
        {
            messageID: "msg_native_edit_chain_first",
            callID: "call_native_edit_chain_first",
            created: 20,
        },
    )
    await recordNativeToolResult(
        native,
        "edit_summary",
        { blockId: 1, oldString: "Red", newString: "Blue", replaceAll: false },
        {
            messageID: "msg_native_edit_chain_second",
            callID: "call_native_edit_chain_second",
            created: 30,
        },
    )

    const listing = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(listing, /Original parser findings\. Green Blue tail\./)

    const leave = {
        messageID: "msg_native_edit_chain_leave",
        callID: "call_native_edit_chain_leave",
    }
    const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
    assert.match(receipt, /b1 v2/)
    native.appendToolCall(
        leave.messageID,
        leave.callID,
        "leave_housekeeping",
        { force: true },
        { text: receipt, created: 40 },
    )

    const committed = await persistedBlock(h.sessionID)
    assert.equal(committed?.activeVersionIndex, 2)
    assert.deepEqual(committed?.summaryVersions, [
        "Original parser findings. Green Blue tail.",
    ])
})

test("native edit_summary retries the same message and call once, including a fresh native setup", async (t) => {
    const { h, contextMessages } = await seedNativeEditCommittedBlock(t)
    const { native } = await enterNativeEditTransaction(t, h, contextMessages)
    await recordNativeToolResult(
        native,
        "append_summary",
        { blockId: 1, text: " Token Token detail." },
        {
            messageID: "msg_native_edit_retry_append",
            callID: "call_native_edit_retry_append",
        },
    )
    const edit = {
        messageID: "msg_native_edit_retry_call",
        callID: "call_native_edit_retry_call",
    }
    const input = { blockId: 1, oldString: "Token", newString: "Mark" }
    const firstResult = await recordNativeToolResult(native, "edit_summary", input, edit)
    const before = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(before, /Original parser findings\. Mark Token detail\./)

    assert.equal(await native.execute("edit_summary", input, edit), firstResult)
    assert.equal(await native.execute("fetch_summary_versions", { blockId: 1 }), before)

    const fresh = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: native.getContext(),
    })
    assert.equal(await fresh.execute("edit_summary", input, edit), firstResult)
    assert.equal(await fresh.execute("fetch_summary_versions", { blockId: 1 }), before)
    assert.doesNotMatch(before, /Mark Mark detail\./)

    const after = await persistedBlock(h.sessionID)
    assert.equal(after?.activeVersionIndex, 1)
    assert.deepEqual(after?.summaryVersions, [])
})

test("native edit_summary applies a distinct call again while the source text still matches", async (t) => {
    const { h, contextMessages } = await seedNativeEditCommittedBlock(t)
    const { native } = await enterNativeEditTransaction(t, h, contextMessages)
    await recordNativeToolResult(
        native,
        "append_summary",
        { blockId: 1, text: " Token Token detail." },
        {
            messageID: "msg_native_edit_repeat_append",
            callID: "call_native_edit_repeat_append",
        },
    )
    for (const [index, callID] of [
        "call_native_edit_repeat_first",
        "call_native_edit_repeat_second",
    ].entries()) {
        await recordNativeToolResult(
            native,
            "edit_summary",
            { blockId: 1, oldString: "Token", newString: "Mark" },
            { messageID: `msg_native_edit_repeat_${index}`, callID, created: 20 + index },
        )
    }

    const listing = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(listing, /Original parser findings\. Mark Mark detail\./)
})

test("native edit_summary leaves committed versions unchanged until a forced leave publishes one combined version", async (t) => {
    const { h, contextMessages } = await seedNativeEditCommittedBlock(t, {
        original: "Original parser findings.",
        committedRewrites: ["First parser rewrite."],
    })
    const { native } = await enterNativeEditTransaction(t, h, contextMessages)
    await recordNativeToolResult(
        native,
        "append_summary",
        { blockId: 1, text: " Alpha Alpha tail." },
        {
            messageID: "msg_native_edit_leave_append",
            callID: "call_native_edit_leave_append",
        },
    )
    await recordNativeToolResult(
        native,
        "edit_summary",
        { blockId: 1, oldString: "Alpha", newString: "Beta", replaceAll: true },
        {
            messageID: "msg_native_edit_leave_edit",
            callID: "call_native_edit_leave_edit",
        },
    )

    const staged = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(staged, /Active version: v2 \(rewrite\)/)
    assert.match(staged, /2 version\(s\) available/)
    assert.match(staged, /Pending edit buffer/)
    assert.match(staged, /First parser rewrite\. Beta Beta tail\./)

    const before = await persistedBlock(h.sessionID)
    assert.equal(before?.activeVersionIndex, 2)
    assert.deepEqual(before?.summaryVersions, ["First parser rewrite."])
    assert.equal(before?.pendingEditBuffer, undefined)
    assert.equal(
        await native.execute("fetch_summary_versions", { blockId: 1, version: 1 }),
        "Block #1 — Parser\nv1 (original):\n\nOriginal parser findings.",
    )
    assert.equal(
        await native.execute("fetch_summary_versions", { blockId: 1, version: 2 }),
        "Block #1 — Parser\nv2 (rewrite):\n\nFirst parser rewrite.",
    )

    const leave = {
        messageID: "msg_native_edit_leave_leave",
        callID: "call_native_edit_leave_leave",
    }
    const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
    assert.match(receipt, /b1 v3/)
    native.appendToolCall(
        leave.messageID,
        leave.callID,
        "leave_housekeeping",
        { force: true },
        { text: receipt, created: 40 },
    )

    const committed = await persistedBlock(h.sessionID)
    assert.equal(committed?.activeVersionIndex, 3)
    assert.deepEqual(committed?.summaryVersions, [
        "First parser rewrite.",
        "First parser rewrite. Beta Beta tail.",
    ])
    assert.equal(committed?.pendingEditBuffer, undefined)

    const fresh = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: native.getContext(),
    })
    const listing = await fresh.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(listing, /Active version: v3 \(rewrite\)/)
    assert.match(listing, /3 version\(s\) available/)
    assert.doesNotMatch(listing, /Pending edit buffer/)
    assert.equal(
        await fresh.execute("fetch_summary_versions", { blockId: 1, version: 3 }),
        "Block #1 — Parser\nv3 (rewrite):\n\nFirst parser rewrite. Beta Beta tail.",
    )
})

test("native edit_summary requires an active housekeeping transaction", async (t) => {
    const { h, contextMessages } = await seedNativeEditCommittedBlock(t)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })

    await assert.rejects(
        native.execute(
            "edit_summary",
            { blockId: 1, oldString: "Parser", newString: "Lexer" },
            { messageID: "msg_native_edit_no_entry", callID: "call_native_edit_no_entry" },
        ),
        /enter_housekeeping|before making/i,
    )
    const persisted = await persistedBlock(h.sessionID)
    assert.equal(persisted?.activeVersionIndex, 1)
    assert.deepEqual(persisted?.summaryVersions, [])
})

test("native edit_summary rejects a missing block without corrupting the staged buffer", async (t) => {
    const { h, contextMessages } = await seedNativeEditCommittedBlock(t)
    const { native } = await enterNativeEditTransaction(t, h, contextMessages)
    await recordNativeToolResult(
        native,
        "append_summary",
        { blockId: 1, text: " Retained detail." },
        {
            messageID: "msg_native_edit_missing_retained",
            callID: "call_native_edit_missing_retained",
        },
    )

    await assert.rejects(
        native.execute(
            "edit_summary",
            { blockId: 999, oldString: "Retained", newString: "Wrong" },
            {
                messageID: "msg_native_edit_missing_block",
                callID: "call_native_edit_missing_block",
            },
        ),
        /Block 999 not found/,
    )
    const retained = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(retained, /Original parser findings\. Retained detail\./)
    assert.doesNotMatch(retained, /Wrong/)

    await recordNativeToolResult(
        native,
        "edit_summary",
        { blockId: 1, oldString: "Retained", newString: "Kept" },
        {
            messageID: "msg_native_edit_missing_valid",
            callID: "call_native_edit_missing_valid",
        },
    )
    const after = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(after, /Original parser findings\. Kept detail\./)
})

test("native edit_summary rejects matching old and new strings without discarding the pending buffer", async (t) => {
    const { h, contextMessages } = await seedNativeEditCommittedBlock(t)
    const { native } = await enterNativeEditTransaction(t, h, contextMessages)
    await recordNativeToolResult(
        native,
        "append_summary",
        { blockId: 1, text: " Retained detail." },
        {
            messageID: "msg_native_edit_identical_retained",
            callID: "call_native_edit_identical_retained",
        },
    )

    await assert.rejects(
        native.execute(
            "edit_summary",
            { blockId: 1, oldString: "Retained", newString: "Retained", replaceAll: false },
            {
                messageID: "msg_native_edit_identical_call",
                callID: "call_native_edit_identical_call",
            },
        ),
        /differ/,
    )
    const retained = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(retained, /Original parser findings\. Retained detail\./)

    await recordNativeToolResult(
        native,
        "edit_summary",
        { blockId: 1, oldString: "parser", newString: "Syntax", replaceAll: false },
        {
            messageID: "msg_native_edit_identical_valid",
            callID: "call_native_edit_identical_valid",
        },
    )
    const after = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(after, /Original Syntax findings\. Retained detail\./)
})

test("native edit_summary rejects absent old strings in both replacement modes without discarding the pending buffer", async (t) => {
    const { h, contextMessages } = await seedNativeEditCommittedBlock(t)
    const { native } = await enterNativeEditTransaction(t, h, contextMessages)
    await recordNativeToolResult(
        native,
        "append_summary",
        { blockId: 1, text: " Retained detail." },
        {
            messageID: "msg_native_edit_absent_retained",
            callID: "call_native_edit_absent_retained",
        },
    )

    for (const replaceAll of [false, true]) {
        await assert.rejects(
            native.execute(
                "edit_summary",
                {
                    blockId: 1,
                    oldString: "Absent",
                    newString: "Replacement",
                    replaceAll,
                },
                {
                    messageID: `msg_native_edit_absent_${replaceAll}`,
                    callID: `call_native_edit_absent_${replaceAll}`,
                },
            ),
            /Old string not found/,
        )
        const retained = await native.execute("fetch_summary_versions", { blockId: 1 })
        assert.match(retained, /Original parser findings\. Retained detail\./)
        assert.doesNotMatch(retained, /Replacement/)
    }

    await recordNativeToolResult(
        native,
        "edit_summary",
        { blockId: 1, oldString: "Retained", newString: "Kept", replaceAll: false },
        {
            messageID: "msg_native_edit_absent_valid",
            callID: "call_native_edit_absent_valid",
        },
    )
    const after = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(after, /Original parser findings\. Kept detail\./)
})

test("native edit_summary preserves the legacy empty oldString prefix insertion", async (t) => {
    const { h, contextMessages } = await seedNativeEditCommittedBlock(t)
    const { native } = await enterNativeEditTransaction(t, h, contextMessages)
    await recordNativeToolResult(
        native,
        "append_summary",
        { blockId: 1, text: " tail." },
        {
            messageID: "msg_native_edit_empty_prefix_append",
            callID: "call_native_edit_empty_prefix_append",
        },
    )
    await recordNativeToolResult(
        native,
        "edit_summary",
        { blockId: 1, oldString: "", newString: "PRE" },
        {
            messageID: "msg_native_edit_empty_prefix_edit",
            callID: "call_native_edit_empty_prefix_edit",
        },
    )

    const listing = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(listing, /PREOriginal parser findings\. tail\./)
})

test("native edit_summary follows split and join for empty oldString when replaceAll is true", async (t) => {
    const { h, contextMessages } = await seedNativeEditCommittedBlock(t)
    const { native } = await enterNativeEditTransaction(t, h, contextMessages)
    await recordNativeToolResult(
        native,
        "append_summary",
        { blockId: 1, text: " tail." },
        {
            messageID: "msg_native_edit_empty_split_append",
            callID: "call_native_edit_empty_split_append",
        },
    )
    await recordNativeToolResult(
        native,
        "edit_summary",
        { blockId: 1, oldString: "", newString: "-", replaceAll: true },
        {
            messageID: "msg_native_edit_empty_split_edit",
            callID: "call_native_edit_empty_split_edit",
        },
    )

    const listing = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(
        listing,
        /O-r-i-g-i-n-a-l- -p-a-r-s-e-r- -f-i-n-d-i-n-g-s-\.- -t-a-i-l-\./,
    )
})

test("native edit_summary keeps two sessions' staged buffers isolated in one setup", async (t) => {
    const firstSessionID = `ses_native_edit_isolated_first_${randomUUID()}`
    const first = await createHousekeepingHarness(t, {
        messages: nativeFixtureMessages(firstSessionID),
    })
    const firstContext = await seedVersionedSummaryFixture(first, {
        original: "First original findings.",
    })
    const secondSessionID = `ses_native_edit_isolated_second_${randomUUID()}`
    const second = await createHousekeepingHarness(t, {
        messages: nativeFixtureMessages(secondSessionID),
    })
    const secondContext = await seedVersionedSummaryFixture(second, {
        original: "Second original findings.",
    })
    const firstEntry = {
        messageID: "msg_native_edit_isolated_first_entry",
        callID: "call_native_edit_isolated_first_entry",
    }
    const secondEntry = {
        messageID: "msg_native_edit_isolated_second_entry",
        callID: "call_native_edit_isolated_second_entry",
    }
    pushNativeRunningCall(
        firstContext,
        first.sessionID,
        firstEntry.messageID,
        firstEntry.callID,
        "enter_housekeeping",
    )
    pushNativeRunningCall(
        secondContext,
        second.sessionID,
        secondEntry.messageID,
        secondEntry.callID,
        "enter_housekeeping",
    )

    const native = await createNativeHarness(t, {
        root: first.root,
        sessionID: first.sessionID,
        contextMessages: firstContext,
    })
    native.setContextFor(second.sessionID, secondContext)
    native.setSessionInfoFor(first.sessionID, { id: first.sessionID })
    native.setSessionInfoFor(second.sessionID, { id: second.sessionID })

    await native.execute("enter_housekeeping", {}, firstEntry)
    await native.execute("enter_housekeeping", {}, {
        ...secondEntry,
        sessionID: second.sessionID,
    })
    await recordNativeToolResult(
        native,
        "edit_summary",
        { blockId: 1, oldString: "First", newString: "One", replaceAll: false },
        {
            messageID: "msg_native_edit_isolated_first_edit",
            callID: "call_native_edit_isolated_first_edit",
        },
    )
    await recordNativeToolResult(
        native,
        "edit_summary",
        { blockId: 1, oldString: "Second", newString: "Two", replaceAll: false },
        {
            messageID: "msg_native_edit_isolated_second_edit",
            callID: "call_native_edit_isolated_second_edit",
            sessionID: second.sessionID,
        },
    )

    const firstListing = await native.execute(
        "fetch_summary_versions",
        { blockId: 1 },
        { sessionID: first.sessionID },
    )
    const secondListing = await native.execute(
        "fetch_summary_versions",
        { blockId: 1 },
        { sessionID: second.sessionID },
    )
    assert.match(firstListing, /One original findings\./)
    assert.equal(firstListing.includes("Two"), false)
    assert.match(secondListing, /Two original findings\./)
    assert.equal(secondListing.includes("One"), false)
})

test("native edit_summary asserts permission before any session read and reports its native source", async (t) => {
    const { h, contextMessages } = await seedNativeEditCommittedBlock(t)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        assertError: new Error("permission denied"),
    })
    const messageID = "msg_native_edit_permission"
    const callID = "call_native_edit_permission"
    native.requiredTool("edit_summary")

    let returned: unknown
    await assert.rejects(async () => {
        returned = await native.execute(
            "edit_summary",
            { blockId: 1, oldString: "Parser", newString: "Lexer" },
            { messageID, callID },
        )
    }, /permission|denied/i)
    assert.equal(returned, undefined)
    assert.equal(native.context.mock.callCount(), 0)
    assert.equal(native.get.mock.callCount(), 0)
    assert.deepEqual(native.assertPermission.mock.calls.at(-1)?.arguments[0], {
        sessionID: h.sessionID,
        agent: "assistant",
        action: "edit_summary",
        resources: ["*"],
        source: { type: "tool", messageID, id: callID },
    })
})

test("native edit_summary propagates history and metadata read failures", async (t) => {
    const { h, contextMessages } = await seedNativeEditCommittedBlock(t)

    const historyFailure = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        contextError: new Error("native history read failed"),
    })
    assert.ok(historyFailure.tool("edit_summary"))
    await assert.rejects(
        historyFailure.execute("edit_summary", {
            blockId: 1,
            oldString: "Parser",
            newString: "Lexer",
        }),
        /history/i,
    )

    const metadataFailure = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        getError: new Error("native session metadata read failed"),
    })
    assert.ok(metadataFailure.tool("edit_summary"))
    await assert.rejects(
        metadataFailure.execute("edit_summary", {
            blockId: 1,
            oldString: "Parser",
            newString: "Lexer",
        }),
        /metadata/i,
    )
})

test("native edit_summary follows the subagent policy", async (t) => {
    const { h, contextMessages } = await seedNativeEditCommittedBlock(t)
    const sessionInfo = { id: h.sessionID, parentID: "msg_parent_session" }

    const disallowed = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        sessionInfo,
        allowSubAgents: false,
    })
    assert.ok(disallowed.tool("edit_summary"))
    await assert.rejects(
        disallowed.execute("edit_summary", {
            blockId: 1,
            oldString: "Parser",
            newString: "Lexer",
        }),
        /subagent|sub-agent|parent/i,
    )

    const { native } = await enterNativeEditTransaction(t, h, contextMessages, {
        sessionInfo,
        allowSubAgents: true,
    })
    await recordNativeToolResult(
        native,
        "edit_summary",
        { blockId: 1, oldString: "Original", newString: "Allowed", replaceAll: false },
        {
            messageID: "msg_native_edit_subagent_edit",
            callID: "call_native_edit_subagent_edit",
        },
    )
    assert.match(
        await native.execute("fetch_summary_versions", { blockId: 1 }),
        /Allowed parser findings\./,
    )
})

test("native edit_summary is omitted by DCP deny and disabled setup", async (t) => {
    const { h, contextMessages } = await seedNativeEditCommittedBlock(t)

    const allowed = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    assert.ok(allowed.tool("edit_summary"))

    const denied = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        compressPermission: "deny",
    })
    assert.equal(denied.tool("edit_summary"), undefined)

    const disabled = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        enabled: false,
    })
    assert.equal(disabled.tool("edit_summary"), undefined)
    assert.deepEqual(disabled.definitions, [])
})

async function seedNativeRewriteCommittedBlock(
    t: TestContext,
    options: { original?: string; committedRewrites?: string[] } = {},
) {
    const sessionID = `ses_native_rewrite_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h, options)
    return { h, contextMessages }
}

async function enterNativeRewriteTransaction(
    t: TestContext,
    h: Awaited<ReturnType<typeof createHousekeepingHarness>>,
    contextMessages: NativeMessage[],
    options: Pick<NativeHarnessOptions, "sessionInfo" | "allowSubAgents" | "customPrompts"> = {},
) {
    const suffix = nextNativeFixtureSuffix()
    const entry = {
        messageID: `msg_native_rewrite_entry_${suffix}`,
        callID: `call_native_rewrite_entry_${suffix}`,
    }
    pushNativeRunningCall(
        contextMessages,
        h.sessionID,
        entry.messageID,
        entry.callID,
        "enter_housekeeping",
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        ...options,
    })
    await native.execute("enter_housekeeping", {}, entry)
    return { native, entry }
}

test("native rewrite_summary registers a native schema and runtime description", async (t) => {
    const { h, contextMessages } = await seedNativeRewriteCommittedBlock(t)
    const { native } = await enterNativeRewriteTransaction(t, h, contextMessages)
    const definition = native.requiredTool("rewrite_summary")
    assert.equal(definition.input?.type, "object")
    assert.equal(definition.input?.additionalProperties, false)
    assert.equal(definition.input?.required?.length, 2)
    assert.ok(definition.input?.required?.includes("blockId"))
    assert.ok(definition.input?.required?.includes("summary"))
    assert.equal(definition.input?.required?.includes("version"), false)
    assert.equal(definition.input?.properties?.blockId?.type, "number")
    assert.equal(definition.input?.properties?.summary?.type, "string")
    assert.equal(definition.options?.codemode, false)
    assert.match(definition.description, /Rewrite a compression block's summary/)
    assert.match(definition.description, /THE FORMAT OF REWRITE_SUMMARY/)
})

test("native rewrite_summary stages a trimmed rewrite and leaves committed versions unchanged", async (t) => {
    const { h, contextMessages } = await seedNativeRewriteCommittedBlock(t)
    const { native } = await enterNativeRewriteTransaction(t, h, contextMessages)
    const rewrite = {
        messageID: "msg_native_rewrite_stage",
        callID: "call_native_rewrite_stage",
    }
    const input = { blockId: 1, summary: " \n  Trimmed parser rewrite.\t " }
    const result = await recordNativeToolResult(native, "rewrite_summary", input, rewrite)
    assert.equal(
        result,
        "Rewrote summary for block 1 (v2 now active). Previous versions can be toggled with /dcp toggle 1.",
    )

    const listing = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(listing, /Active version: v2 \(rewrite\)/)
    assert.match(listing, /2 version\(s\) available/)
    assert.doesNotMatch(listing, /Pending edit buffer/)
    assert.equal(
        await native.execute("fetch_summary_versions", { blockId: 1, version: 2 }),
        "Block #1 — Parser\nv2 (rewrite):\n\nTrimmed parser rewrite.",
    )

    const persisted = await persistedBlock(h.sessionID)
    assert.equal(persisted?.activeVersionIndex, 1)
    assert.deepEqual(persisted?.summaryVersions, [])
})

test("native rewrite_summary accumulates successive rewrites as draft versions", async (t) => {
    const { h, contextMessages } = await seedNativeRewriteCommittedBlock(t)
    const { native } = await enterNativeRewriteTransaction(t, h, contextMessages)
    for (const [index, summary] of ["First draft rewrite.", "Second draft rewrite."].entries()) {
        const input = { blockId: 1, summary }
        await recordNativeToolResult(native, "rewrite_summary", input, {
            messageID: `msg_native_rewrite_accumulate_${index}`,
            callID: `call_native_rewrite_accumulate_${index}`,
            created: 20 + index,
        })
    }

    const listing = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(listing, /Active version: v3 \(rewrite\)/)
    assert.match(listing, /3 version\(s\) available/)
    assert.equal(
        await native.execute("fetch_summary_versions", { blockId: 1, version: 2 }),
        "Block #1 — Parser\nv2 (rewrite):\n\nFirst draft rewrite.",
    )
    assert.equal(
        await native.execute("fetch_summary_versions", { blockId: 1, version: 3 }),
        "Block #1 — Parser\nv3 (rewrite):\n\nSecond draft rewrite.",
    )

    const persisted = await persistedBlock(h.sessionID)
    assert.equal(persisted?.activeVersionIndex, 1)
    assert.deepEqual(persisted?.summaryVersions, [])
})

for (const pending of ["append", "edit"] as const) {
    test(`native rewrite_summary materializes a pending ${pending} as its own version before the rewrite`, async (t) => {
        const { h, contextMessages } = await seedNativeRewriteCommittedBlock(t)
        const { native } = await enterNativeRewriteTransaction(t, h, contextMessages)
        const pendingInput =
            pending === "append"
                ? { blockId: 1, text: " Added detail." }
                : { blockId: 1, oldString: "parser", newString: "Lexer", replaceAll: false }
        await recordNativeToolResult(
            native,
            pending === "append" ? "append_summary" : "edit_summary",
            pendingInput,
            {
                messageID: `msg_native_rewrite_pending_${pending}`,
                callID: `call_native_rewrite_pending_${pending}`,
            },
        )
        const pendingText =
            pending === "append"
                ? "Original parser findings. Added detail."
                : "Original Lexer findings."
        const before = await native.execute("fetch_summary_versions", { blockId: 1 })
        assert.match(before, /Pending edit buffer/)
        assert.ok(before.includes(pendingText), before)

        await recordNativeToolResult(
            native,
            "rewrite_summary",
            { blockId: 1, summary: "Replacement rewrite." },
            {
                messageID: `msg_native_rewrite_after_pending_${pending}`,
                callID: `call_native_rewrite_after_pending_${pending}`,
                created: 20,
            },
        )

        const draft = await native.execute("fetch_summary_versions", { blockId: 1 })
        assert.match(draft, /Active version: v3 \(rewrite\)/)
        assert.match(draft, /3 version\(s\) available/)
        assert.doesNotMatch(draft, /Pending edit buffer/)
        assert.equal(
            await native.execute("fetch_summary_versions", { blockId: 1, version: 2 }),
            `Block #1 — Parser\nv2 (rewrite):\n\n${pendingText}`,
        )
        assert.equal(
            await native.execute("fetch_summary_versions", { blockId: 1, version: 3 }),
            "Block #1 — Parser\nv3 (rewrite):\n\nReplacement rewrite.",
        )

        const persistedBeforeLeave = await persistedBlock(h.sessionID)
        assert.equal(persistedBeforeLeave?.activeVersionIndex, 1)
        assert.deepEqual(persistedBeforeLeave?.summaryVersions, [])

        const leave = {
            messageID: `msg_native_rewrite_pending_leave_${pending}`,
            callID: `call_native_rewrite_pending_leave_${pending}`,
        }
        const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
        assert.match(receipt, /b1 v3/)
        native.appendToolCall(
            leave.messageID,
            leave.callID,
            "leave_housekeeping",
            { force: true },
            { text: receipt, created: 30 },
        )

        const committed = await persistedBlock(h.sessionID)
        assert.equal(committed?.activeVersionIndex, 3)
        assert.deepEqual(committed?.summaryVersions, [pendingText, "Replacement rewrite."])
        assert.equal(committed?.pendingEditBuffer, undefined)

        const fresh = await createNativeHarness(t, {
            root: h.root,
            sessionID: h.sessionID,
            contextMessages: native.getContext(),
        })
        const freshListing = await fresh.execute("fetch_summary_versions", { blockId: 1 })
        assert.match(freshListing, /Active version: v3 \(rewrite\)/)
        assert.match(freshListing, /3 version\(s\) available/)
        assert.doesNotMatch(freshListing, /Pending edit buffer/)
    })
}

test("native rewrite_summary retries the same message and call once, including a fresh native setup", async (t) => {
    const { h, contextMessages } = await seedNativeRewriteCommittedBlock(t)
    const { native } = await enterNativeRewriteTransaction(t, h, contextMessages)
    const rewrite = {
        messageID: "msg_native_rewrite_retry_call",
        callID: "call_native_rewrite_retry_call",
    }
    const input = { blockId: 1, summary: "Retry-safe rewrite." }
    const firstResult = await recordNativeToolResult(native, "rewrite_summary", input, rewrite)
    const before = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(before, /Retry-safe rewrite\./)

    assert.equal(await native.execute("rewrite_summary", input, rewrite), firstResult)
    assert.equal(await native.execute("fetch_summary_versions", { blockId: 1 }), before)

    const fresh = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: native.getContext(),
    })
    assert.equal(await fresh.execute("rewrite_summary", input, rewrite), firstResult)
    assert.equal(await fresh.execute("fetch_summary_versions", { blockId: 1 }), before)

    const after = await persistedBlock(h.sessionID)
    assert.equal(after?.activeVersionIndex, 1)
    assert.deepEqual(after?.summaryVersions, [])
})

test("native rewrite_summary applies the same summary again from a distinct call", async (t) => {
    const { h, contextMessages } = await seedNativeRewriteCommittedBlock(t)
    const { native } = await enterNativeRewriteTransaction(t, h, contextMessages)
    for (const [index, callID] of [
        "call_native_rewrite_repeat_first",
        "call_native_rewrite_repeat_second",
    ].entries()) {
        const messageID = `msg_native_rewrite_repeat_${index}`
        const input = { blockId: 1, summary: "Repeated rewrite." }
        await recordNativeToolResult(native, "rewrite_summary", input, {
            messageID,
            callID,
            created: 20 + index,
        })
    }

    const listing = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(listing, /Active version: v3 \(rewrite\)/)
    assert.match(listing, /3 version\(s\) available/)
    assert.equal(
        await native.execute("fetch_summary_versions", { blockId: 1, version: 2 }),
        "Block #1 — Parser\nv2 (rewrite):\n\nRepeated rewrite.",
    )
    assert.equal(
        await native.execute("fetch_summary_versions", { blockId: 1, version: 3 }),
        "Block #1 — Parser\nv3 (rewrite):\n\nRepeated rewrite.",
    )
})

test("native forced leave publishes the active rewrite and a fresh setup sees no pending buffer", async (t) => {
    const { h, contextMessages } = await seedNativeRewriteCommittedBlock(t)
    const { native } = await enterNativeRewriteTransaction(t, h, contextMessages)
    await recordNativeToolResult(
        native,
        "rewrite_summary",
        { blockId: 1, summary: "Published rewrite." },
        {
            messageID: "msg_native_rewrite_publish",
            callID: "call_native_rewrite_publish",
        },
    )

    const leave = {
        messageID: "msg_native_rewrite_publish_leave",
        callID: "call_native_rewrite_publish_leave",
    }
    const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
    assert.match(receipt, /b1 v2/)
    native.appendToolCall(
        leave.messageID,
        leave.callID,
        "leave_housekeeping",
        { force: true },
        { text: receipt, created: 30 },
    )

    const committed = await persistedBlock(h.sessionID)
    assert.equal(committed?.activeVersionIndex, 2)
    assert.deepEqual(committed?.summaryVersions, ["Published rewrite."])
    assert.equal(committed?.pendingEditBuffer, undefined)

    const fresh = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: native.getContext(),
    })
    const listing = await fresh.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(listing, /Active version: v2 \(rewrite\)/)
    assert.match(listing, /2 version\(s\) available/)
    assert.doesNotMatch(listing, /Pending edit buffer/)
    assert.equal(
        await fresh.execute("fetch_summary_versions", { blockId: 1, version: 2 }),
        "Block #1 — Parser\nv2 (rewrite):\n\nPublished rewrite.",
    )
})

test("native rewrite_summary requires an active housekeeping transaction", async (t) => {
    const { h, contextMessages } = await seedNativeRewriteCommittedBlock(t)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })

    await assert.rejects(
        native.execute(
            "rewrite_summary",
            { blockId: 1, summary: "No entry." },
            { messageID: "msg_native_rewrite_no_entry", callID: "call_native_rewrite_no_entry" },
        ),
        /enter_housekeeping|before making/i,
    )
    const persisted = await persistedBlock(h.sessionID)
    assert.equal(persisted?.activeVersionIndex, 1)
    assert.deepEqual(persisted?.summaryVersions, [])
})

test("native rewrite_summary rejects a missing block without corrupting draft versions", async (t) => {
    const { h, contextMessages } = await seedNativeRewriteCommittedBlock(t)
    const { native } = await enterNativeRewriteTransaction(t, h, contextMessages)
    await recordNativeToolResult(
        native,
        "rewrite_summary",
        { blockId: 1, summary: "Retained draft." },
        {
            messageID: "msg_native_rewrite_missing_retained",
            callID: "call_native_rewrite_missing_retained",
        },
    )

    await assert.rejects(
        native.execute(
            "rewrite_summary",
            { blockId: 999, summary: "Wrong block." },
            {
                messageID: "msg_native_rewrite_missing_block",
                callID: "call_native_rewrite_missing_block",
            },
        ),
        /Block 999 not found/,
    )
    const retained = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(retained, /Active version: v2 \(rewrite\)/)
    assert.match(retained, /Retained draft\./)
    assert.doesNotMatch(retained, /Wrong block\./)

    await recordNativeToolResult(
        native,
        "rewrite_summary",
        { blockId: 1, summary: "After missing block." },
        {
            messageID: "msg_native_rewrite_missing_valid",
            callID: "call_native_rewrite_missing_valid",
        },
    )
    const after = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(after, /Active version: v3 \(rewrite\)/)
    assert.match(after, /Retained draft\./)
    assert.match(after, /After missing block\./)
})

test("native rewrite_summary rejects blank summaries without materializing the pending buffer", async (t) => {
    const { h, contextMessages } = await seedNativeRewriteCommittedBlock(t)
    const { native } = await enterNativeRewriteTransaction(t, h, contextMessages)
    await recordNativeToolResult(
        native,
        "append_summary",
        { blockId: 1, text: " Retained detail." },
        {
            messageID: "msg_native_rewrite_blank_append",
            callID: "call_native_rewrite_blank_append",
        },
    )

    for (const [index, summary] of ["", " \n\t "].entries()) {
        await assert.rejects(
            native.execute(
                "rewrite_summary",
                { blockId: 1, summary },
                {
                    messageID: `msg_native_rewrite_blank_${index}`,
                    callID: `call_native_rewrite_blank_${index}`,
                },
            ),
            /empty/i,
        )
        const preserved = await native.execute("fetch_summary_versions", { blockId: 1 })
        assert.match(preserved, /Pending edit buffer/)
        assert.match(preserved, /1 version\(s\) available/)
        assert.ok(preserved.includes("Original parser findings. Retained detail."), preserved)
    }

    await recordNativeToolResult(
        native,
        "rewrite_summary",
        { blockId: 1, summary: "Valid rewrite." },
        {
            messageID: "msg_native_rewrite_blank_valid",
            callID: "call_native_rewrite_blank_valid",
        },
    )
    const after = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(after, /Active version: v3 \(rewrite\)/)
    assert.match(after, /3 version\(s\) available/)
    assert.doesNotMatch(after, /Pending edit buffer/)
    assert.equal(
        await native.execute("fetch_summary_versions", { blockId: 1, version: 2 }),
        "Block #1 — Parser\nv2 (rewrite):\n\nOriginal parser findings. Retained detail.",
    )
    assert.equal(
        await native.execute("fetch_summary_versions", { blockId: 1, version: 3 }),
        "Block #1 — Parser\nv3 (rewrite):\n\nValid rewrite.",
    )

    const persisted = await persistedBlock(h.sessionID)
    assert.equal(persisted?.activeVersionIndex, 1)
    assert.deepEqual(persisted?.summaryVersions, [])
})

test("native rewrite_summary keeps two sessions' draft versions isolated in one setup", async (t) => {
    const firstSessionID = `ses_native_rewrite_isolated_first_${randomUUID()}`
    const first = await createHousekeepingHarness(t, {
        messages: nativeFixtureMessages(firstSessionID),
    })
    const firstContext = await seedVersionedSummaryFixture(first, {
        original: "First original findings.",
    })
    const secondSessionID = `ses_native_rewrite_isolated_second_${randomUUID()}`
    const second = await createHousekeepingHarness(t, {
        messages: nativeFixtureMessages(secondSessionID),
    })
    const secondContext = await seedVersionedSummaryFixture(second, {
        original: "Second original findings.",
    })
    const firstEntry = {
        messageID: "msg_native_rewrite_isolated_first_entry",
        callID: "call_native_rewrite_isolated_first_entry",
    }
    const secondEntry = {
        messageID: "msg_native_rewrite_isolated_second_entry",
        callID: "call_native_rewrite_isolated_second_entry",
    }
    pushNativeRunningCall(
        firstContext,
        first.sessionID,
        firstEntry.messageID,
        firstEntry.callID,
        "enter_housekeeping",
    )
    pushNativeRunningCall(
        secondContext,
        second.sessionID,
        secondEntry.messageID,
        secondEntry.callID,
        "enter_housekeeping",
    )

    const native = await createNativeHarness(t, {
        root: first.root,
        sessionID: first.sessionID,
        contextMessages: firstContext,
    })
    native.setContextFor(second.sessionID, secondContext)
    native.setSessionInfoFor(first.sessionID, { id: first.sessionID })
    native.setSessionInfoFor(second.sessionID, { id: second.sessionID })

    await native.execute("enter_housekeeping", {}, firstEntry)
    await native.execute("enter_housekeeping", {}, {
        ...secondEntry,
        sessionID: second.sessionID,
    })
    await recordNativeToolResult(
        native,
        "rewrite_summary",
        { blockId: 1, summary: "First rewritten summary." },
        {
            messageID: "msg_native_rewrite_isolated_first",
            callID: "call_native_rewrite_isolated_first",
        },
    )
    await recordNativeToolResult(
        native,
        "rewrite_summary",
        { blockId: 1, summary: "Second rewritten summary." },
        {
            messageID: "msg_native_rewrite_isolated_second",
            callID: "call_native_rewrite_isolated_second",
            sessionID: second.sessionID,
        },
    )

    const firstListing = await native.execute(
        "fetch_summary_versions",
        { blockId: 1 },
        { sessionID: first.sessionID },
    )
    const secondListing = await native.execute(
        "fetch_summary_versions",
        { blockId: 1 },
        { sessionID: second.sessionID },
    )
    assert.match(firstListing, /First rewritten summary\./)
    assert.equal(firstListing.includes("Second rewritten summary."), false)
    assert.match(secondListing, /Second rewritten summary\./)
    assert.equal(secondListing.includes("First rewritten summary."), false)

    const firstPersisted = await persistedBlock(first.sessionID)
    const secondPersisted = await persistedBlock(second.sessionID)
    assert.equal(firstPersisted?.activeVersionIndex, 1)
    assert.deepEqual(firstPersisted?.summaryVersions, [])
    assert.equal(secondPersisted?.activeVersionIndex, 1)
    assert.deepEqual(secondPersisted?.summaryVersions, [])
})

test("native rewrite_summary asserts permission before any session read and reports its native source", async (t) => {
    const { h, contextMessages } = await seedNativeRewriteCommittedBlock(t)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        assertError: new Error("permission denied"),
    })
    const messageID = "msg_native_rewrite_permission"
    const callID = "call_native_rewrite_permission"
    native.requiredTool("rewrite_summary")

    let returned: unknown
    await assert.rejects(async () => {
        returned = await native.execute(
            "rewrite_summary",
            { blockId: 1, summary: "Denied rewrite." },
            { messageID, callID },
        )
    }, /permission|denied/i)
    assert.equal(returned, undefined)
    assert.equal(native.context.mock.callCount(), 0)
    assert.equal(native.get.mock.callCount(), 0)
    assert.deepEqual(native.assertPermission.mock.calls.at(-1)?.arguments[0], {
        sessionID: h.sessionID,
        agent: "assistant",
        action: "rewrite_summary",
        resources: ["*"],
        source: { type: "tool", messageID, id: callID },
    })
})

test("native rewrite_summary propagates history and metadata read failures", async (t) => {
    const { h, contextMessages } = await seedNativeRewriteCommittedBlock(t)

    const historyFailure = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        contextError: new Error("native history read failed"),
    })
    assert.ok(historyFailure.tool("rewrite_summary"))
    await assert.rejects(
        historyFailure.execute("rewrite_summary", { blockId: 1, summary: "History rewrite." }),
        /history/i,
    )

    const metadataFailure = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        getError: new Error("native session metadata read failed"),
    })
    assert.ok(metadataFailure.tool("rewrite_summary"))
    await assert.rejects(
        metadataFailure.execute("rewrite_summary", { blockId: 1, summary: "Metadata rewrite." }),
        /metadata/i,
    )
})

test("native rewrite_summary follows the subagent policy", async (t) => {
    const { h, contextMessages } = await seedNativeRewriteCommittedBlock(t)
    const sessionInfo = { id: h.sessionID, parentID: "msg_parent_session" }

    const disallowed = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        sessionInfo,
        allowSubAgents: false,
    })
    assert.ok(disallowed.tool("rewrite_summary"))
    await assert.rejects(
        disallowed.execute("rewrite_summary", { blockId: 1, summary: "Denied rewrite." }),
        /subagent|sub-agent|parent/i,
    )

    const { native } = await enterNativeRewriteTransaction(t, h, contextMessages, {
        sessionInfo,
        allowSubAgents: true,
    })
    await recordNativeToolResult(
        native,
        "rewrite_summary",
        { blockId: 1, summary: "Allowed rewrite." },
        {
            messageID: "msg_native_rewrite_subagent",
            callID: "call_native_rewrite_subagent",
        },
    )
    assert.match(
        await native.execute("fetch_summary_versions", { blockId: 1 }),
        /Allowed rewrite\./,
    )
})

test("native rewrite_summary is omitted by DCP deny and disabled setup", async (t) => {
    const { h, contextMessages } = await seedNativeRewriteCommittedBlock(t)

    const allowed = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    assert.ok(allowed.tool("rewrite_summary"))

    const denied = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        compressPermission: "deny",
    })
    assert.equal(denied.tool("rewrite_summary"), undefined)

    const disabled = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        enabled: false,
    })
    assert.equal(disabled.tool("rewrite_summary"), undefined)
    assert.deepEqual(disabled.definitions, [])
})

test("native rewrite_summary uses the configured runtime description", async (t) => {
    const { h, contextMessages } = await seedNativeRewriteCommittedBlock(t)
    const overrideDir = join(h.root, ".opencode", "dcp-prompts", "overrides")
    await mkdir(overrideDir, { recursive: true })
    await writeFile(join(overrideDir, "rewrite-summary.md"), "Configured rewrite instructions.\n")

    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        customPrompts: true,
    })
    const definition = native.requiredTool("rewrite_summary")
    assert.match(definition.description, /Configured rewrite instructions\./)
    assert.match(definition.description, /THE FORMAT OF REWRITE_SUMMARY/)
    assert.doesNotMatch(
        definition.description,
        /Rewrite a compression block's summary to a shorter or focused version/,
    )
})

async function seedNativeToggleCommittedBlock(
    t: TestContext,
    options: {
        original?: string
        committedRewrites?: string[]
        autotoggle?: "on" | "off"
    } = {},
) {
    const sessionID = `ses_native_toggle_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h, {
        original: options.original,
        committedRewrites: options.committedRewrites,
    })
    if (options.autotoggle === "on") await h.command("autotoggle on")
    if (options.autotoggle === "off") {
        await h.command("autotoggle on")
        await h.command("autotoggle off")
    }
    return { h, contextMessages }
}

async function enterNativeToggleTransaction(
    t: TestContext,
    h: Awaited<ReturnType<typeof createHousekeepingHarness>>,
    contextMessages: NativeMessage[],
    options: Pick<NativeHarnessOptions, "sessionInfo" | "allowSubAgents"> = {},
) {
    const suffix = nextNativeFixtureSuffix()
    const entry = {
        messageID: `msg_native_toggle_entry_${suffix}`,
        callID: `call_native_toggle_entry_${suffix}`,
    }
    pushNativeRunningCall(
        contextMessages,
        h.sessionID,
        entry.messageID,
        entry.callID,
        "enter_housekeeping",
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        ...options,
    })
    await native.execute("enter_housekeeping", {}, entry)
    return { native, entry }
}

test("native toggle_summary_version registers the shared native schema and exact description", async (t) => {
    const { h, contextMessages } = await seedNativeToggleCommittedBlock(t, {
        autotoggle: "on",
    })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    const definition = native.requiredTool("toggle_summary_version")
    assert.equal(definition.input?.type, "object")
    assert.equal(definition.input?.additionalProperties, false)
    assert.deepEqual([...(definition.input?.required ?? [])].sort(), ["blockId", "version"])
    assert.deepEqual(Object.keys(definition.input?.properties ?? {}).sort(), [
        "blockId",
        "version",
    ])
    assert.equal(definition.input?.properties?.blockId?.type, "number")
    assert.equal(definition.input?.properties?.version?.type, "number")
    assert.equal(definition.options?.codemode, false)
    assert.equal(
        definition.description,
        [
            "Switch the active summary version of a compressed block.",
            "",
            "Use after calling fetch_summary_versions to inspect available versions, then call this tool to switch.",
            "Version 0 disables the summary (block content is no longer summarized in context).",
            "Version 1 is the original summary produced at compression time.",
            "Versions 2+ are rewrite summaries produced via rewrite_summary or edit_summary.",
            "",
            "Requires /dcp autotoggle on to be enabled in the session.",
            "",
            "THE FORMAT",
            "{",
            "  blockId: number,    // Block ID to toggle (e.g. 3)",
            "  version: number     // Target version: 0=disabled, 1=original, 2+=rewrite",
            "}",
        ].join("\n"),
    )
})

for (const version of [0, 1, 2, 3]) {
    const label = version === 0 ? "disabled" : `v${version}`
    test(`native toggle_summary_version selects ${label} in the draft and a forced leave persists it`, async (t) => {
        const { h, contextMessages } = await seedNativeToggleCommittedBlock(t, {
            original: "Original parser findings.",
            committedRewrites: ["First parser rewrite.", "Latest parser rewrite."],
            autotoggle: "on",
        })
        const before = await persistedBlock(h.sessionID)
        assert.equal(before?.activeVersionIndex, 3)
        const { native } = await enterNativeToggleTransaction(t, h, contextMessages)

        const input = { blockId: 1, version }
        const result = await recordNativeToolResult(
            native,
            "toggle_summary_version",
            input,
            {
                messageID: `msg_native_toggle_select_${version}`,
                callID: `call_native_toggle_select_${version}`,
            },
        )
        assert.equal(result, `Block #1 summary set to ${label}.`)

        const draft = await native.execute("fetch_summary_versions", { blockId: 1 })
        assert.match(draft, new RegExp(`Active version: ${label}\\b`))
        assert.match(draft, /3 version\(s\) available/)
        const unchanged = await persistedBlock(h.sessionID)
        assert.equal(unchanged?.activeVersionIndex, 3)
        assert.deepEqual(unchanged?.summaryVersions, [
            "First parser rewrite.",
            "Latest parser rewrite.",
        ])

        const leave = {
            messageID: `msg_native_toggle_leave_${version}`,
            callID: `call_native_toggle_leave_${version}`,
        }
        const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
        assert.match(receipt, /Housekeeping complete/)
        native.appendToolCall(
            leave.messageID,
            leave.callID,
            "leave_housekeeping",
            { force: true },
            { text: receipt, created: 30 },
        )

        const committed = await persistedBlock(h.sessionID)
        assert.equal(committed?.activeVersionIndex, version)
        assert.deepEqual(committed?.summaryVersions, [
            "First parser rewrite.",
            "Latest parser rewrite.",
        ])

        const fresh = await createNativeHarness(t, {
            root: h.root,
            sessionID: h.sessionID,
            contextMessages: native.getContext(),
        })
        const listing = await fresh.execute("fetch_summary_versions", { blockId: 1 })
        assert.match(listing, new RegExp(`Active version: ${label}\\b`))
        assert.match(listing, /3 version\(s\) available/)
    })
}

for (const mode of ["default", "explicit"] as const) {
    test(`native toggle_summary_version rejects ${mode === "default" ? "default-disabled" : "explicitly disabled"} autotoggle and preserves the pending draft`, async (t) => {
        const { h, contextMessages } = await seedNativeToggleCommittedBlock(t, {
            original: "Original parser findings.",
            autotoggle: mode === "explicit" ? "off" : undefined,
        })
        const { native } = await enterNativeToggleTransaction(t, h, contextMessages)
        const append = {
            messageID: `msg_native_toggle_autotoggle_${mode}`,
            callID: `call_native_toggle_autotoggle_${mode}`,
        }
        await recordNativeToolResult(
            native,
            "append_summary",
            { blockId: 1, text: " Retained pending detail." },
            append,
        )
        const before = await native.execute("fetch_summary_versions", { blockId: 1 })
        assert.match(before, /Pending edit buffer/)
        assert.match(before, /Active version: v1\b/)

        await assert.rejects(
            native.execute(
                "toggle_summary_version",
                { blockId: 1, version: 0 },
                {
                    messageID: `msg_native_toggle_autotoggle_rejected_${mode}`,
                    callID: `call_native_toggle_autotoggle_rejected_${mode}`,
                },
            ),
            /autotoggle/i,
        )

        const preserved = await native.execute("fetch_summary_versions", { blockId: 1 })
        assert.equal(preserved, before)

        const leave = {
            messageID: `msg_native_toggle_autotoggle_leave_${mode}`,
            callID: `call_native_toggle_autotoggle_leave_${mode}`,
        }
        const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
        assert.match(receipt, /Housekeeping complete/)
        native.appendToolCall(
            leave.messageID,
            leave.callID,
            "leave_housekeeping",
            { force: true },
            { text: receipt, created: 30 },
        )

        const committed = await persistedBlock(h.sessionID)
        assert.equal(committed?.activeVersionIndex, 2)
        assert.deepEqual(committed?.summaryVersions, [
            "Original parser findings. Retained pending detail.",
        ])
    })
}

test("native toggle_summary_version requires an active housekeeping transaction even when autotoggle is enabled", async (t) => {
    const { h, contextMessages } = await seedNativeToggleCommittedBlock(t, {
        original: "Original parser findings.",
        autotoggle: "on",
    })
    const before = await persistedBlock(h.sessionID)
    assert.equal(before?.activeVersionIndex, 1)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })

    await assert.rejects(
        native.execute(
            "toggle_summary_version",
            { blockId: 1, version: 0 },
            {
                messageID: "msg_native_toggle_no_entry",
                callID: "call_native_toggle_no_entry",
            },
        ),
        /enter_housekeeping|before making/i,
    )

    const after = await persistedBlock(h.sessionID)
    assert.equal(after?.activeVersionIndex, 1)
    assert.match(
        await native.execute("fetch_summary_versions", { blockId: 1 }),
        /Active version: v1\b/,
    )
})

test("native toggle_summary_version selects the original on a block with no rewrites", async (t) => {
    const { h, contextMessages } = await seedNativeToggleCommittedBlock(t, {
        original: "Original parser findings.",
        autotoggle: "on",
    })
    const { native } = await enterNativeToggleTransaction(t, h, contextMessages)

    const result = await recordNativeToolResult(
        native,
        "toggle_summary_version",
        { blockId: 1, version: 1 },
        {
            messageID: "msg_native_toggle_original_only",
            callID: "call_native_toggle_original_only",
        },
    )
    assert.equal(result, "Block #1 summary set to v1.")
    const listing = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(listing, /Active version: v1 \(original\)/)
    assert.match(listing, /1 version\(s\) available/)

    const leave = {
        messageID: "msg_native_toggle_original_only_leave",
        callID: "call_native_toggle_original_only_leave",
    }
    const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
    native.appendToolCall(
        leave.messageID,
        leave.callID,
        "leave_housekeeping",
        { force: true },
        { text: receipt, created: 30 },
    )

    const committed = await persistedBlock(h.sessionID)
    assert.equal(committed?.activeVersionIndex, 1)
    assert.deepEqual(committed?.summaryVersions, [])

    const fresh = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: native.getContext(),
    })
    assert.match(
        await fresh.execute("fetch_summary_versions", { blockId: 1 }),
        /Active version: v1 \(original\)/,
    )
})

for (const pending of ["append", "edit"] as const) {
    test(`native toggle_summary_version materializes a pending ${pending} before selecting its rewrite version`, async (t) => {
        const { h, contextMessages } = await seedNativeToggleCommittedBlock(t, {
            original: "Original parser findings.",
            autotoggle: "on",
        })
        const { native } = await enterNativeToggleTransaction(t, h, contextMessages)
        const pendingInput =
            pending === "append"
                ? { blockId: 1, text: " Added detail." }
                : { blockId: 1, oldString: "parser", newString: "Lexer", replaceAll: false }
        await recordNativeToolResult(
            native,
            pending === "append" ? "append_summary" : "edit_summary",
            pendingInput,
            {
                messageID: `msg_native_toggle_pending_${pending}`,
                callID: `call_native_toggle_pending_${pending}`,
            },
        )
        const pendingText =
            pending === "append"
                ? "Original parser findings. Added detail."
                : "Original Lexer findings."
        const before = await native.execute("fetch_summary_versions", { blockId: 1 })
        assert.match(before, /Pending edit buffer/)
        assert.match(before, /Active version: v1\b/)
        assert.ok(before.includes(pendingText), before)

        const result = await recordNativeToolResult(
            native,
            "toggle_summary_version",
            { blockId: 1, version: 2 },
            {
                messageID: `msg_native_toggle_after_pending_${pending}`,
                callID: `call_native_toggle_after_pending_${pending}`,
                created: 20,
            },
        )
        assert.equal(result, "Block #1 summary set to v2.")

        const draft = await native.execute("fetch_summary_versions", { blockId: 1 })
        assert.match(draft, /Active version: v2 \(rewrite\)/)
        assert.match(draft, /2 version\(s\) available/)
        assert.doesNotMatch(draft, /Pending edit buffer/)
        assert.equal(
            await native.execute("fetch_summary_versions", { blockId: 1, version: 2 }),
            `Block #1 — Parser\nv2 (rewrite):\n\n${pendingText}`,
        )

        const persistedBeforeLeave = await persistedBlock(h.sessionID)
        assert.equal(persistedBeforeLeave?.activeVersionIndex, 1)
        assert.deepEqual(persistedBeforeLeave?.summaryVersions, [])

        const leave = {
            messageID: `msg_native_toggle_pending_leave_${pending}`,
            callID: `call_native_toggle_pending_leave_${pending}`,
        }
        const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
        assert.match(receipt, /b1 v2/)
        native.appendToolCall(
            leave.messageID,
            leave.callID,
            "leave_housekeeping",
            { force: true },
            { text: receipt, created: 30 },
        )

        const committed = await persistedBlock(h.sessionID)
        assert.equal(committed?.activeVersionIndex, 2)
        assert.deepEqual(committed?.summaryVersions, [pendingText])
        assert.equal(committed?.pendingEditBuffer, undefined)

        const fresh = await createNativeHarness(t, {
            root: h.root,
            sessionID: h.sessionID,
            contextMessages: native.getContext(),
        })
        const freshListing = await fresh.execute("fetch_summary_versions", { blockId: 1 })
        assert.match(freshListing, /Active version: v2 \(rewrite\)/)
        assert.match(freshListing, /2 version\(s\) available/)
        assert.doesNotMatch(freshListing, /Pending edit buffer/)
    })
}

test("native toggle_summary_version rejects invalid or missing versions without losing the pending buffer and recovers", async (t) => {
    const { h, contextMessages } = await seedNativeToggleCommittedBlock(t, {
        original: "Original parser findings.",
        autotoggle: "on",
    })
    const { native } = await enterNativeToggleTransaction(t, h, contextMessages)
    await recordNativeToolResult(
        native,
        "append_summary",
        { blockId: 1, text: " Retained pending detail." },
        {
            messageID: "msg_native_toggle_invalid_pending",
            callID: "call_native_toggle_invalid_pending",
        },
    )
    const before = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(before, /Pending edit buffer/)
    assert.match(before, /Active version: v1\b/)
    assert.match(before, /Original parser findings\. Retained pending detail\./)

    for (const version of [-1, 1.5, 99]) {
        await assert.rejects(
            native.execute(
                "toggle_summary_version",
                { blockId: 1, version },
                {
                    messageID: `msg_native_toggle_invalid_${version}`,
                    callID: `call_native_toggle_invalid_${version}`,
                },
            ),
            /version/i,
        )
        assert.equal(await native.execute("fetch_summary_versions", { blockId: 1 }), before)
    }

    await assert.rejects(
        native.execute(
            "toggle_summary_version",
            { blockId: 999, version: 1 },
            {
                messageID: "msg_native_toggle_missing_block",
                callID: "call_native_toggle_missing_block",
            },
        ),
        /Block 999 not found/,
    )
    assert.equal(await native.execute("fetch_summary_versions", { blockId: 1 }), before)

    const retained = await persistedBlock(h.sessionID)
    assert.equal(retained?.activeVersionIndex, 1)
    assert.deepEqual(retained?.summaryVersions, [])

    await recordNativeToolResult(
        native,
        "toggle_summary_version",
        { blockId: 1, version: 2 },
        {
            messageID: "msg_native_toggle_invalid_recovered",
            callID: "call_native_toggle_invalid_recovered",
        },
    )
    const recovered = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(recovered, /Active version: v2 \(rewrite\)/)
    assert.match(recovered, /2 version\(s\) available/)
    assert.doesNotMatch(recovered, /Pending edit buffer/)

    const leave = {
        messageID: "msg_native_toggle_invalid_leave",
        callID: "call_native_toggle_invalid_leave",
    }
    const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
    native.appendToolCall(
        leave.messageID,
        leave.callID,
        "leave_housekeeping",
        { force: true },
        { text: receipt, created: 30 },
    )
    const committed = await persistedBlock(h.sessionID)
    assert.equal(committed?.activeVersionIndex, 2)
    assert.deepEqual(committed?.summaryVersions, [
        "Original parser findings. Retained pending detail.",
    ])
})

test("native toggle_summary_version retries the same message and call without reapplying a different selection, including fresh setup", async (t) => {
    const { h, contextMessages } = await seedNativeToggleCommittedBlock(t, {
        original: "Original parser findings.",
        committedRewrites: ["First parser rewrite.", "Latest parser rewrite."],
        autotoggle: "on",
    })
    const { native } = await enterNativeToggleTransaction(t, h, contextMessages)
    const retry = {
        messageID: "msg_native_toggle_retry",
        callID: "call_native_toggle_retry",
    }
    const firstResult = await recordNativeToolResult(
        native,
        "toggle_summary_version",
        { blockId: 1, version: 2 },
        retry,
    )
    assert.equal(firstResult, "Block #1 summary set to v2.")
    const afterFirst = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(afterFirst, /Active version: v2 \(rewrite\)/)

    assert.equal(
        await native.execute("toggle_summary_version", { blockId: 1, version: 1 }, retry),
        firstResult,
    )
    assert.equal(await native.execute("fetch_summary_versions", { blockId: 1 }), afterFirst)

    await recordNativeToolResult(
        native,
        "toggle_summary_version",
        { blockId: 1, version: 1 },
        {
            messageID: "msg_native_toggle_retry_distinct",
            callID: "call_native_toggle_retry_distinct",
            created: 30,
        },
    )
    const afterDistinct = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(afterDistinct, /Active version: v1 \(original\)/)

    assert.equal(
        await native.execute("toggle_summary_version", { blockId: 1, version: 3 }, retry),
        firstResult,
    )
    assert.equal(await native.execute("fetch_summary_versions", { blockId: 1 }), afterDistinct)

    const fresh = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: native.getContext(),
    })
    assert.equal(
        await fresh.execute("toggle_summary_version", { blockId: 1, version: 0 }, retry),
        firstResult,
    )
    assert.equal(await fresh.execute("fetch_summary_versions", { blockId: 1 }), afterDistinct)

    const leave = {
        messageID: "msg_native_toggle_retry_leave",
        callID: "call_native_toggle_retry_leave",
    }
    const receipt = await fresh.execute("leave_housekeeping", { force: true }, leave)
    fresh.appendToolCall(
        leave.messageID,
        leave.callID,
        "leave_housekeeping",
        { force: true },
        { text: receipt, created: 40 },
    )
    assert.equal((await persistedBlock(h.sessionID))?.activeVersionIndex, 1)
})

test("native toggle_summary_version isolates autotoggle and selection across sessions in one setup", async (t) => {
    const firstSessionID = `ses_native_toggle_isolated_first_${randomUUID()}`
    const first = await createHousekeepingHarness(t, {
        messages: nativeFixtureMessages(firstSessionID),
    })
    const firstContext = await seedVersionedSummaryFixture(first, {
        original: "First original findings.",
        committedRewrites: ["First rewrite."],
    })
    await first.command("autotoggle on")
    const secondSessionID = `ses_native_toggle_isolated_second_${randomUUID()}`
    const second = await createHousekeepingHarness(t, {
        messages: nativeFixtureMessages(secondSessionID),
    })
    const secondContext = await seedVersionedSummaryFixture(second, {
        original: "Second original findings.",
        committedRewrites: ["Second rewrite.", "Second latest rewrite."],
    })
    const firstEntry = {
        messageID: "msg_native_toggle_isolated_first_entry",
        callID: "call_native_toggle_isolated_first_entry",
    }
    const secondEntry = {
        messageID: "msg_native_toggle_isolated_second_entry",
        callID: "call_native_toggle_isolated_second_entry",
    }
    pushNativeRunningCall(
        firstContext,
        first.sessionID,
        firstEntry.messageID,
        firstEntry.callID,
        "enter_housekeeping",
    )
    pushNativeRunningCall(
        secondContext,
        second.sessionID,
        secondEntry.messageID,
        secondEntry.callID,
        "enter_housekeeping",
    )

    const native = await createNativeHarness(t, {
        root: first.root,
        sessionID: first.sessionID,
        contextMessages: firstContext,
    })
    native.setContextFor(second.sessionID, secondContext)
    native.setSessionInfoFor(first.sessionID, { id: first.sessionID })
    native.setSessionInfoFor(second.sessionID, { id: second.sessionID })

    await native.execute("enter_housekeeping", {}, firstEntry)
    await native.execute("enter_housekeeping", {}, {
        ...secondEntry,
        sessionID: second.sessionID,
    })
    const firstResult = await recordNativeToolResult(
        native,
        "toggle_summary_version",
        { blockId: 1, version: 1 },
        {
            messageID: "msg_native_toggle_isolated_first",
            callID: "call_native_toggle_isolated_first",
            sessionID: first.sessionID,
        },
    )
    assert.equal(firstResult, "Block #1 summary set to v1.")

    await assert.rejects(
        native.execute(
            "toggle_summary_version",
            { blockId: 1, version: 1 },
            {
                messageID: "msg_native_toggle_isolated_second",
                callID: "call_native_toggle_isolated_second",
                sessionID: second.sessionID,
            },
        ),
        /autotoggle/i,
    )

    const firstListing = await native.execute(
        "fetch_summary_versions",
        { blockId: 1 },
        { sessionID: first.sessionID },
    )
    const secondListing = await native.execute(
        "fetch_summary_versions",
        { blockId: 1 },
        { sessionID: second.sessionID },
    )
    assert.match(firstListing, /Active version: v1 \(original\)/)
    assert.match(firstListing, /First rewrite\./)
    assert.equal(firstListing.includes("Second"), false)
    assert.match(secondListing, /Active version: v3 \(rewrite\)/)
    assert.match(secondListing, /Second latest rewrite\./)
    assert.equal(secondListing.includes("First"), false)

    const firstLeave = {
        messageID: "msg_native_toggle_isolated_first_leave",
        callID: "call_native_toggle_isolated_first_leave",
    }
    const receipt = await native.execute(
        "leave_housekeeping",
        { force: true },
        { ...firstLeave, sessionID: first.sessionID },
    )
    native.appendToolCall(
        firstLeave.messageID,
        firstLeave.callID,
        "leave_housekeeping",
        { force: true },
        { sessionID: first.sessionID, text: receipt, created: 30 },
    )

    assert.equal((await persistedBlock(first.sessionID))?.activeVersionIndex, 1)
    assert.equal((await persistedBlock(second.sessionID))?.activeVersionIndex, 3)
})

test("native toggle_summary_version asserts permission before any session read and reports its native source", async (t) => {
    const { h, contextMessages } = await seedNativeToggleCommittedBlock(t, {
        original: "Original parser findings.",
        autotoggle: "on",
    })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        assertError: new Error("permission denied"),
    })
    const messageID = "msg_native_toggle_permission"
    const callID = "call_native_toggle_permission"
    native.requiredTool("toggle_summary_version")

    let returned: unknown
    await assert.rejects(async () => {
        returned = await native.execute(
            "toggle_summary_version",
            { blockId: 1, version: 0 },
            { messageID, callID },
        )
    }, /permission|denied/i)
    assert.equal(returned, undefined)
    assert.equal(native.context.mock.callCount(), 0)
    assert.equal(native.get.mock.callCount(), 0)
    assert.deepEqual(native.assertPermission.mock.calls.at(-1)?.arguments[0], {
        sessionID: h.sessionID,
        agent: "assistant",
        action: "toggle_summary_version",
        resources: ["*"],
        source: { type: "tool", messageID, id: callID },
    })
})

test("native toggle_summary_version propagates history and metadata read failures", async (t) => {
    const { h, contextMessages } = await seedNativeToggleCommittedBlock(t, {
        original: "Original parser findings.",
        autotoggle: "on",
    })

    const historyFailure = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        contextError: new Error("native history read failed"),
    })
    assert.ok(historyFailure.tool("toggle_summary_version"))
    await assert.rejects(
        historyFailure.execute("toggle_summary_version", { blockId: 1, version: 0 }),
        /history/i,
    )

    const metadataFailure = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        getError: new Error("native session metadata read failed"),
    })
    assert.ok(metadataFailure.tool("toggle_summary_version"))
    await assert.rejects(
        metadataFailure.execute("toggle_summary_version", { blockId: 1, version: 0 }),
        /metadata/i,
    )
})

test("native toggle_summary_version follows the subagent policy", async (t) => {
    const { h, contextMessages } = await seedNativeToggleCommittedBlock(t, {
        original: "Original parser findings.",
        committedRewrites: ["Allowed rewrite."],
        autotoggle: "on",
    })
    const sessionInfo = { id: h.sessionID, parentID: "msg_parent_session" }

    const disallowed = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        sessionInfo,
        allowSubAgents: false,
    })
    assert.ok(disallowed.tool("toggle_summary_version"))
    await assert.rejects(
        disallowed.execute(
            "toggle_summary_version",
            { blockId: 1, version: 1 },
            {
                messageID: "msg_native_toggle_subagent_denied",
                callID: "call_native_toggle_subagent_denied",
            },
        ),
        /subagent|sub-agent|parent/i,
    )

    const { native } = await enterNativeToggleTransaction(t, h, contextMessages, {
        sessionInfo,
        allowSubAgents: true,
    })
    const result = await recordNativeToolResult(
        native,
        "toggle_summary_version",
        { blockId: 1, version: 1 },
        {
            messageID: "msg_native_toggle_subagent_allowed",
            callID: "call_native_toggle_subagent_allowed",
        },
    )
    assert.equal(result, "Block #1 summary set to v1.")
    const listing = await native.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(listing, /Active version: v1 \(original\)/)
    assert.match(listing, /2 version\(s\) available/)
})

test("native toggle_summary_version is omitted by DCP deny and disabled setup with an allow control", async (t) => {
    const { h, contextMessages } = await seedNativeToggleCommittedBlock(t, {
        original: "Original parser findings.",
    })

    const allowed = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    assert.ok(allowed.tool("toggle_summary_version"))

    const denied = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        compressPermission: "deny",
    })
    assert.equal(denied.tool("toggle_summary_version"), undefined)

    const disabled = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        enabled: false,
    })
    assert.equal(disabled.tool("toggle_summary_version"), undefined)
    assert.deepEqual(disabled.definitions, [])
})

const EXPAND_BLOCK_DESCRIPTION = [
    "Extend a compressed block's message range to include newer messages.",
    "",
    "Use this tool when you want to widen an existing block's coverage without rewriting its summary. Later, use edit_summary or append_summary to update the text.",
    "",
    "THE FORMAT",
    "{",
    "  blockId: number,",
    '  endId: string   // message ref (e.g. "m0100") for the new end boundary',
    "}",
].join("\n")

async function persistedBlockById(sessionID: string, blockId = 1): Promise<any> {
    const fixture = JSON.parse(await readFile(getSessionFilePath(sessionID), "utf-8")) as any
    return fixture?.prune?.messages?.blocksById?.[blockId]
}

async function persistedActiveDraftBlock(sessionID: string, blockId = 1): Promise<any> {
    const fixture = JSON.parse(await readFile(getSessionFilePath(sessionID), "utf-8")) as any
    const ref = fixture?.housekeeping?.draftRef
    assert.ok(ref, "expected an active housekeeping draft")
    const draft = await readHousekeepingDraft(sessionID, ref)
    const block = draft.prune.messages.blocksById.get(blockId)
    assert.ok(block, `expected draft block ${blockId}`)
    return block
}

async function seedNativeExpansionCommittedBlock(
    t: TestContext,
    options: {
        summary?: string
        startId?: string
        endId?: string
        second?: { summary: string; startId: string; endId: string }
    } = {},
) {
    const sessionID = `ses_native_expand_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    await h.enter()
    await stageBlock(
        h,
        options.summary ?? "Parser findings.",
        options.startId ?? "m0001",
        options.endId ?? "m0002",
    )
    await h.leave()
    if (options.second) {
        await h.enter()
        await stageBlock(
            h,
            options.second.summary,
            options.second.startId,
            options.second.endId,
        )
        await h.leave()
    }
    return { h, contextMessages: toNativeHistory(h.history) }
}

async function enterNativeExpansionTransaction(
    t: TestContext,
    h: Awaited<ReturnType<typeof createHousekeepingHarness>>,
    contextMessages: NativeMessage[],
    options: Pick<NativeHarnessOptions, "sessionInfo" | "allowSubAgents"> = {},
) {
    const suffix = nextNativeFixtureSuffix()
    const entry = {
        messageID: `msg_native_expand_entry_${suffix}`,
        callID: `call_native_expand_entry_${suffix}`,
    }
    pushNativeRunningCall(
        contextMessages,
        h.sessionID,
        entry.messageID,
        entry.callID,
        "enter_housekeeping",
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        ...options,
    })
    await native.execute("enter_housekeeping", {}, entry)
    return { native, entry }
}

test("native expand_block registers the shared schema, description, codemode and result", async (t) => {
    const { h, contextMessages } = await seedNativeExpansionCommittedBlock(t)
    const { native } = await enterNativeExpansionTransaction(t, h, contextMessages)
    const definition = native.requiredTool("expand_block")
    assert.equal(definition.input?.type, "object")
    assert.equal(definition.input?.additionalProperties, false)
    assert.deepEqual([...(definition.input?.required ?? [])].sort(), ["blockId", "endId"])
    assert.deepEqual(Object.keys(definition.input?.properties ?? {}).sort(), ["blockId", "endId"])
    assert.equal(definition.input?.properties?.blockId?.type, "number")
    assert.equal(definition.input?.properties?.endId?.type, "string")
    assert.equal(definition.options?.codemode, false)
    assert.equal(definition.description, EXPAND_BLOCK_DESCRIPTION)

    const result = await recordNativeToolResult(
        native,
        "expand_block",
        { blockId: 1, endId: "m0003" },
        {
            messageID: "msg_native_expand_register",
            callID: "call_native_expand_register",
        },
    )
    assert.equal(
        result,
        "Expanded block 1 range to m0003. Use edit_summary or append_summary to update its summary. Complete all intended compression and edits across every affected block before calling leave_housekeeping once for the whole maintenance pass.",
    )
    const draft = await persistedActiveDraftBlock(h.sessionID)
    assert.equal(draft.endId, "m0003")
    assert.ok(draft.effectiveMessageIds.includes("msg_source_3"))
})

test("native expand_block accumulates distinct draft coverage while committed coverage and end stay unchanged", async (t) => {
    const { h, contextMessages } = await seedNativeExpansionCommittedBlock(t)
    const { native } = await enterNativeExpansionTransaction(t, h, contextMessages)
    const committedBefore = await persistedBlockById(h.sessionID)

    await recordNativeToolResult(
        native,
        "expand_block",
        { blockId: 1, endId: "m0003" },
        {
            messageID: "msg_native_expand_accumulate_first",
            callID: "call_native_expand_accumulate_first",
            created: 20,
        },
    )
    const firstDraft = await persistedActiveDraftBlock(h.sessionID)
    assert.equal(firstDraft.endId, "m0003")
    assert.ok(firstDraft.effectiveMessageIds.includes("msg_source_3"))
    assert.equal(firstDraft.effectiveMessageIds.includes("msg_source_4"), false)
    assert.deepEqual([...firstDraft.pendingExpandedMessageIds].sort(), ["msg_source_3"])
    assert.equal((await persistedBlockById(h.sessionID))?.endId, committedBefore?.endId)
    assert.deepEqual(
        (await persistedBlockById(h.sessionID))?.effectiveMessageIds,
        committedBefore?.effectiveMessageIds,
    )

    await recordNativeToolResult(
        native,
        "expand_block",
        { blockId: 1, endId: "m0004" },
        {
            messageID: "msg_native_expand_accumulate_second",
            callID: "call_native_expand_accumulate_second",
            created: 30,
        },
    )
    const secondDraft = await persistedActiveDraftBlock(h.sessionID)
    assert.equal(secondDraft.endId, "m0004")
    for (const messageId of ["msg_source_1", "msg_source_2", "msg_source_3", "msg_source_4"]) {
        assert.ok(secondDraft.effectiveMessageIds.includes(messageId))
    }
    assert.equal(
        new Set(secondDraft.effectiveMessageIds).size,
        secondDraft.effectiveMessageIds.length,
    )
    assert.deepEqual(
        [...secondDraft.pendingExpandedMessageIds].sort(),
        ["msg_source_3", "msg_source_4"],
    )
    assert.equal((await persistedBlockById(h.sessionID))?.endId, committedBefore?.endId)
    assert.deepEqual(
        (await persistedBlockById(h.sessionID))?.effectiveMessageIds,
        committedBefore?.effectiveMessageIds,
    )
})

test("native expand_block publishes coverage and one edited version at forced leave for a fresh setup", async (t) => {
    const { h, contextMessages } = await seedNativeExpansionCommittedBlock(t)
    const { native } = await enterNativeExpansionTransaction(t, h, contextMessages)
    await recordNativeToolResult(
        native,
        "expand_block",
        { blockId: 1, endId: "m0004" },
        {
            messageID: "msg_native_expand_publish_expand",
            callID: "call_native_expand_publish_expand",
            created: 20,
        },
    )
    await recordNativeToolResult(
        native,
        "append_summary",
        { blockId: 1, text: " Expanded detail." },
        {
            messageID: "msg_native_expand_publish_append",
            callID: "call_native_expand_publish_append",
            created: 30,
        },
    )
    const before = await persistedBlockById(h.sessionID)
    assert.equal(before?.endId, "m0002")
    assert.equal(before?.activeVersionIndex, 1)
    assert.deepEqual(before?.summaryVersions, [])

    const leave = {
        messageID: "msg_native_expand_publish_leave",
        callID: "call_native_expand_publish_leave",
    }
    const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
    assert.match(receipt, /Housekeeping complete/)
    assert.match(receipt, /b1 v2/)
    native.appendToolCall(
        leave.messageID,
        leave.callID,
        "leave_housekeeping",
        { force: true },
        { text: receipt, created: 40 },
    )

    const committed = await persistedBlockById(h.sessionID)
    assert.equal(committed?.endId, "m0004")
    for (const messageId of ["msg_source_1", "msg_source_2", "msg_source_3", "msg_source_4"]) {
        assert.ok(committed?.effectiveMessageIds.includes(messageId))
    }
    assert.equal(committed?.activeVersionIndex, 2)
    assert.deepEqual(committed?.summaryVersions, ["Parser findings. Expanded detail."])
    assert.equal(committed?.pendingEditBuffer, undefined)
    assert.equal(committed?.pendingExpandedMessageIds, undefined)

    const fresh = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: native.getContext(),
    })
    const listing = await fresh.execute("fetch_summary_versions", { blockId: 1 })
    assert.match(listing, /Active version: v2 \(rewrite\)/)
    assert.match(listing, /2 version\(s\) available/)
    assert.doesNotMatch(listing, /Pending edit buffer/)
    assert.equal(
        await fresh.execute("fetch_summary_versions", { blockId: 1, version: 2 }),
        "Block #1 — Parser\nv2 (rewrite):\n\nParser findings. Expanded detail.",
    )
})

test("native expand_block retries the same message and call without reapplying a differing endpoint, including restart", async (t) => {
    const { h, contextMessages } = await seedNativeExpansionCommittedBlock(t)
    const { native } = await enterNativeExpansionTransaction(t, h, contextMessages)
    const retry = {
        messageID: "msg_native_expand_retry",
        callID: "call_native_expand_retry",
    }
    const firstResult = await recordNativeToolResult(
        native,
        "expand_block",
        { blockId: 1, endId: "m0003" },
        retry,
    )
    assert.match(firstResult, /range to m0003/)
    await recordNativeToolResult(
        native,
        "expand_block",
        { blockId: 1, endId: "m0004" },
        {
            messageID: "msg_native_expand_retry_distinct",
            callID: "call_native_expand_retry_distinct",
            created: 30,
        },
    )
    const afterDistinct = await persistedActiveDraftBlock(h.sessionID)
    assert.equal(afterDistinct.endId, "m0004")
    assert.ok(afterDistinct.effectiveMessageIds.includes("msg_source_4"))

    assert.equal(
        await native.execute("expand_block", { blockId: 1, endId: "m0004" }, retry),
        firstResult,
    )
    assert.deepEqual(await persistedActiveDraftBlock(h.sessionID), afterDistinct)

    const fresh = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: native.getContext(),
    })
    assert.equal(
        await fresh.execute("expand_block", { blockId: 1, endId: "m0003" }, retry),
        firstResult,
    )
    assert.deepEqual(await persistedActiveDraftBlock(h.sessionID), afterDistinct)
})

test("native expand_block requires an active housekeeping transaction and then recovers", async (t) => {
    const { h, contextMessages } = await seedNativeExpansionCommittedBlock(t)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    const committedBefore = await persistedBlockById(h.sessionID)

    await assert.rejects(
        native.execute(
            "expand_block",
            { blockId: 1, endId: "m0003" },
            { messageID: "msg_native_expand_no_entry", callID: "call_native_expand_no_entry" },
        ),
        /enter_housekeeping|before making/i,
    )
    assert.deepEqual(await persistedBlockById(h.sessionID), committedBefore)

    const suffix = nextNativeFixtureSuffix()
    const entry = {
        messageID: `msg_native_expand_recovery_entry_${suffix}`,
        callID: `call_native_expand_recovery_entry_${suffix}`,
    }
    const recoveryContext = native.getContext()
    pushNativeRunningCall(
        recoveryContext,
        h.sessionID,
        entry.messageID,
        entry.callID,
        "enter_housekeeping",
    )
    const recovered = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: recoveryContext,
    })
    await recovered.execute("enter_housekeeping", {}, entry)
    await recordNativeToolResult(
        recovered,
        "expand_block",
        { blockId: 1, endId: "m0003" },
        {
            messageID: "msg_native_expand_recovery_expand",
            callID: "call_native_expand_recovery_expand",
        },
    )
    assert.equal((await persistedActiveDraftBlock(h.sessionID)).endId, "m0003")
})

for (const { name, args, error } of [
    { name: "unknown block", args: { blockId: 999, endId: "m0004" }, error: /block.*not found/i },
    {
        name: "unknown message reference",
        args: { blockId: 1, endId: "m9999" },
        error: /message|reference|boundary/i,
    },
    {
        name: "malformed reference",
        args: { blockId: 1, endId: "not-a-reference" },
        error: /reference|boundary/i,
    },
    {
        name: "block reference instead of a message",
        args: { blockId: 1, endId: "b1" },
        error: /reference|boundary/i,
    },
]) {
    test(`native expand_block rejects ${name} and preserves draft coverage, summary edits and recovery`, async (t) => {
        const { h, contextMessages } = await seedNativeExpansionCommittedBlock(t)
        const { native } = await enterNativeExpansionTransaction(t, h, contextMessages)
        await recordNativeToolResult(
            native,
            "expand_block",
            { blockId: 1, endId: "m0003" },
            {
                messageID: `msg_native_expand_invalid_first_${name}`,
                callID: `call_native_expand_invalid_first_${name}`,
            },
        )
        await recordNativeToolResult(
            native,
            "append_summary",
            { blockId: 1, text: " Keep staged details." },
            {
                messageID: `msg_native_expand_invalid_append_${name}`,
                callID: `call_native_expand_invalid_append_${name}`,
                created: 20,
            },
        )
        const draftBefore = await persistedActiveDraftBlock(h.sessionID)
        const committedBefore = await persistedBlockById(h.sessionID)
        const versionsBefore = await native.execute("fetch_summary_versions", { blockId: 1 })

        await assert.rejects(
            native.execute("expand_block", args, {
                messageID: `msg_native_expand_invalid_call_${name}`,
                callID: `call_native_expand_invalid_call_${name}`,
            }),
            error,
        )
        assert.deepEqual(await persistedActiveDraftBlock(h.sessionID), draftBefore)
        assert.deepEqual(await persistedBlockById(h.sessionID), committedBefore)
        assert.equal(await native.execute("fetch_summary_versions", { blockId: 1 }), versionsBefore)

        await recordNativeToolResult(
            native,
            "expand_block",
            { blockId: 1, endId: "m0004" },
            {
                messageID: `msg_native_expand_invalid_recover_${name}`,
                callID: `call_native_expand_invalid_recover_${name}`,
                created: 30,
            },
        )
        const leave = {
            messageID: `msg_native_expand_invalid_leave_${name}`,
            callID: `call_native_expand_invalid_leave_${name}`,
        }
        const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
        native.appendToolCall(
            leave.messageID,
            leave.callID,
            "leave_housekeeping",
            { force: true },
            { text: receipt, created: 40 },
        )
        const committed = await persistedBlockById(h.sessionID)
        assert.equal(committed?.endId, "m0004")
        for (const messageId of [
            "msg_source_1",
            "msg_source_2",
            "msg_source_3",
            "msg_source_4",
        ]) {
            assert.ok(committed?.effectiveMessageIds.includes(messageId))
        }
        assert.equal(committed?.activeVersionIndex, 2)
        assert.deepEqual(committed?.summaryVersions, ["Parser findings. Keep staged details."])
    })
}

test("native expand_block rejects overlap with another committed active block and preserves both drafts", async (t) => {
    const { h, contextMessages } = await seedNativeExpansionCommittedBlock(t, {
        second: {
            summary: "Documented API findings.",
            startId: "m0003",
            endId: "m0004",
        },
    })
    const { native } = await enterNativeExpansionTransaction(t, h, contextMessages)
    await recordNativeToolResult(
        native,
        "append_summary",
        { blockId: 1, text: " Retained pending detail." },
        {
            messageID: "msg_native_expand_overlap_append",
            callID: "call_native_expand_overlap_append",
        },
    )
    const firstDraftBefore = await persistedActiveDraftBlock(h.sessionID, 1)
    const secondDraftBefore = await persistedActiveDraftBlock(h.sessionID, 2)
    const firstCommittedBefore = await persistedBlockById(h.sessionID, 1)
    const secondCommittedBefore = await persistedBlockById(h.sessionID, 2)

    await assert.rejects(
        native.execute(
            "expand_block",
            { blockId: 1, endId: "m0003" },
            {
                messageID: "msg_native_expand_overlap_reject",
                callID: "call_native_expand_overlap_reject",
            },
        ),
        /overlap/i,
    )
    assert.deepEqual(await persistedActiveDraftBlock(h.sessionID, 1), firstDraftBefore)
    assert.deepEqual(await persistedActiveDraftBlock(h.sessionID, 2), secondDraftBefore)
    assert.deepEqual(await persistedBlockById(h.sessionID, 1), firstCommittedBefore)
    assert.deepEqual(await persistedBlockById(h.sessionID, 2), secondCommittedBefore)

    const leave = {
        messageID: "msg_native_expand_overlap_leave",
        callID: "call_native_expand_overlap_leave",
    }
    const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
    native.appendToolCall(
        leave.messageID,
        leave.callID,
        "leave_housekeeping",
        { force: true },
        { text: receipt, created: 30 },
    )
    const firstCommitted = await persistedBlockById(h.sessionID, 1)
    const secondCommitted = await persistedBlockById(h.sessionID, 2)
    assert.equal(firstCommitted?.endId, "m0002")
    assert.deepEqual(firstCommitted?.summaryVersions, ["Parser findings. Retained pending detail."])
    assert.equal(secondCommitted?.endId, "m0004")
    assert.deepEqual(secondCommitted, secondCommittedBefore)
})

test("native expand_block preserves existing covered IDs when the endpoint moves earlier", async (t) => {
    const { h, contextMessages } = await seedNativeExpansionCommittedBlock(t, {
        endId: "m0004",
    })
    const { native } = await enterNativeExpansionTransaction(t, h, contextMessages)
    const committedBefore = await persistedBlockById(h.sessionID)
    assert.equal(committedBefore?.endId, "m0004")

    await recordNativeToolResult(
        native,
        "expand_block",
        { blockId: 1, endId: "m0002" },
        {
            messageID: "msg_native_expand_earlier",
            callID: "call_native_expand_earlier",
        },
    )
    const draft = await persistedActiveDraftBlock(h.sessionID)
    assert.equal(draft.endId, "m0002")
    for (const messageId of ["msg_source_1", "msg_source_2", "msg_source_3", "msg_source_4"]) {
        assert.ok(draft.effectiveMessageIds.includes(messageId))
    }
    assert.deepEqual(draft.pendingExpandedMessageIds ?? [], [])
    assert.equal((await persistedBlockById(h.sessionID))?.endId, "m0004")

    const leave = {
        messageID: "msg_native_expand_earlier_leave",
        callID: "call_native_expand_earlier_leave",
    }
    const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
    native.appendToolCall(
        leave.messageID,
        leave.callID,
        "leave_housekeeping",
        { force: true },
        { text: receipt, created: 30 },
    )
    const committed = await persistedBlockById(h.sessionID)
    assert.equal(committed?.endId, "m0002")
    for (const messageId of ["msg_source_1", "msg_source_2", "msg_source_3", "msg_source_4"]) {
        assert.ok(committed?.effectiveMessageIds.includes(messageId))
    }
})

test("native expand_block keeps two sessions' draft coverage isolated in one setup", async (t) => {
    const firstSessionID = `ses_native_expand_isolated_first_${randomUUID()}`
    const first = await createHousekeepingHarness(t, {
        messages: nativeFixtureMessages(firstSessionID),
    })
    await commitBlock(first)
    const secondSessionID = `ses_native_expand_isolated_second_${randomUUID()}`
    const second = await createHousekeepingHarness(t, {
        messages: nativeFixtureMessages(secondSessionID),
    })
    await commitBlock(second)
    const firstContext = toNativeHistory(first.history)
    const secondContext = toNativeHistory(second.history)
    const firstEntry = {
        messageID: "msg_native_expand_isolated_first_entry",
        callID: "call_native_expand_isolated_first_entry",
    }
    const secondEntry = {
        messageID: "msg_native_expand_isolated_second_entry",
        callID: "call_native_expand_isolated_second_entry",
    }
    pushNativeRunningCall(
        firstContext,
        first.sessionID,
        firstEntry.messageID,
        firstEntry.callID,
        "enter_housekeeping",
    )
    pushNativeRunningCall(
        secondContext,
        second.sessionID,
        secondEntry.messageID,
        secondEntry.callID,
        "enter_housekeeping",
    )

    const native = await createNativeHarness(t, {
        root: first.root,
        sessionID: first.sessionID,
        contextMessages: firstContext,
    })
    native.setContextFor(second.sessionID, secondContext)
    native.setSessionInfoFor(first.sessionID, { id: first.sessionID })
    native.setSessionInfoFor(second.sessionID, { id: second.sessionID })

    await native.execute("enter_housekeeping", {}, firstEntry)
    await native.execute("enter_housekeeping", {}, {
        ...secondEntry,
        sessionID: second.sessionID,
    })
    await recordNativeToolResult(
        native,
        "expand_block",
        { blockId: 1, endId: "m0003" },
        {
            messageID: "msg_native_expand_isolated_first_expand",
            callID: "call_native_expand_isolated_first_expand",
            created: 20,
        },
    )
    await recordNativeToolResult(
        native,
        "expand_block",
        { blockId: 1, endId: "m0004" },
        {
            messageID: "msg_native_expand_isolated_second_expand",
            callID: "call_native_expand_isolated_second_expand",
            sessionID: second.sessionID,
            created: 20,
        },
    )

    const firstDraft = await persistedActiveDraftBlock(first.sessionID)
    const secondDraft = await persistedActiveDraftBlock(second.sessionID)
    assert.equal(firstDraft.endId, "m0003")
    assert.ok(firstDraft.effectiveMessageIds.includes("msg_source_3"))
    assert.equal(firstDraft.effectiveMessageIds.includes("msg_source_4"), false)
    assert.equal(secondDraft.endId, "m0004")
    assert.ok(secondDraft.effectiveMessageIds.includes("msg_source_4"))
    assert.equal(secondDraft.effectiveMessageIds.includes("msg_source_3"), true)

    const firstLeave = {
        messageID: "msg_native_expand_isolated_first_leave",
        callID: "call_native_expand_isolated_first_leave",
    }
    const firstReceipt = await native.execute("leave_housekeeping", { force: true }, firstLeave)
    native.appendToolCall(
        firstLeave.messageID,
        firstLeave.callID,
        "leave_housekeeping",
        { force: true },
        { text: firstReceipt, created: 30 },
    )
    const secondLeave = {
        messageID: "msg_native_expand_isolated_second_leave",
        callID: "call_native_expand_isolated_second_leave",
        sessionID: second.sessionID,
    }
    const secondReceipt = await native.execute("leave_housekeeping", { force: true }, secondLeave)
    native.appendToolCall(
        secondLeave.messageID,
        secondLeave.callID,
        "leave_housekeeping",
        { force: true },
        { sessionID: second.sessionID, text: secondReceipt, created: 30 },
    )

    const firstCommitted = await persistedBlockById(first.sessionID)
    const secondCommitted = await persistedBlockById(second.sessionID)
    assert.equal(firstCommitted?.endId, "m0003")
    assert.equal(firstCommitted?.effectiveMessageIds.includes("msg_source_4"), false)
    assert.equal(secondCommitted?.endId, "m0004")
    assert.equal(secondCommitted?.effectiveMessageIds.includes("msg_source_3"), true)
})

test("native expand_block asserts permission before any session read and reports its native source", async (t) => {
    const { h, contextMessages } = await seedNativeExpansionCommittedBlock(t)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        assertError: new Error("permission denied"),
    })
    const messageID = "msg_native_expand_permission"
    const callID = "call_native_expand_permission"
    native.requiredTool("expand_block")

    let returned: unknown
    await assert.rejects(async () => {
        returned = await native.execute(
            "expand_block",
            { blockId: 1, endId: "m0003" },
            { messageID, callID },
        )
    }, /permission|denied/i)
    assert.equal(returned, undefined)
    assert.equal(native.context.mock.callCount(), 0)
    assert.equal(native.get.mock.callCount(), 0)
    assert.deepEqual(native.assertPermission.mock.calls.at(-1)?.arguments[0], {
        sessionID: h.sessionID,
        agent: "assistant",
        action: "expand_block",
        resources: ["*"],
        source: { type: "tool", messageID, id: callID },
    })
})

test("native expand_block propagates history and metadata read failures", async (t) => {
    const { h, contextMessages } = await seedNativeExpansionCommittedBlock(t)

    const historyFailure = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        contextError: new Error("native history read failed"),
    })
    assert.ok(historyFailure.tool("expand_block"))
    await assert.rejects(
        historyFailure.execute("expand_block", { blockId: 1, endId: "m0003" }),
        /history/i,
    )

    const metadataFailure = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        getError: new Error("native session metadata read failed"),
    })
    assert.ok(metadataFailure.tool("expand_block"))
    await assert.rejects(
        metadataFailure.execute("expand_block", { blockId: 1, endId: "m0003" }),
        /metadata/i,
    )
})

test("native expand_block follows the subagent policy", async (t) => {
    const { h, contextMessages } = await seedNativeExpansionCommittedBlock(t)
    const sessionInfo = { id: h.sessionID, parentID: "msg_parent_session" }

    const disallowed = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        sessionInfo,
        allowSubAgents: false,
    })
    assert.ok(disallowed.tool("expand_block"))
    await assert.rejects(
        disallowed.execute(
            "expand_block",
            { blockId: 1, endId: "m0003" },
            {
                messageID: "msg_native_expand_subagent_denied",
                callID: "call_native_expand_subagent_denied",
            },
        ),
        /subagent|sub-agent|parent/i,
    )

    const { native } = await enterNativeExpansionTransaction(t, h, contextMessages, {
        sessionInfo,
        allowSubAgents: true,
    })
    await recordNativeToolResult(
        native,
        "expand_block",
        { blockId: 1, endId: "m0003" },
        {
            messageID: "msg_native_expand_subagent_allowed",
            callID: "call_native_expand_subagent_allowed",
        },
    )
    assert.equal((await persistedActiveDraftBlock(h.sessionID)).endId, "m0003")
})

test("native expand_block is omitted by DCP deny and disabled setup with an allow control", async (t) => {
    const { h, contextMessages } = await seedNativeExpansionCommittedBlock(t)

    const allowed = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    assert.ok(allowed.tool("expand_block"))

    const denied = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        compressPermission: "deny",
    })
    assert.equal(denied.tool("expand_block"), undefined)

    const disabled = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        enabled: false,
    })
    assert.equal(disabled.tool("expand_block"), undefined)
    assert.deepEqual(disabled.definitions, [])
})

function nativeRecallToolMessage(
    sessionID: string,
    messageID: string,
    tool: string,
    callID: string,
    output: string,
): WithParts {
    const message = ordinaryMessage(sessionID, messageID, "assistant", "")
    message.parts = [
        {
            id: `${messageID}-tool`,
            messageID,
            sessionID,
            type: "tool",
            tool,
            callID,
            state: {
                status: "completed",
                input: { filePath: "token.ts" },
                output,
                title: tool,
                metadata: {},
                time: { start: 1, end: 2 },
            },
        },
    ]
    return message
}

function nativeRecallMessages(sessionID: string, prefix = "RECALL"): WithParts[] {
    return [
        ordinaryMessage(
            sessionID,
            "msg_recall_1",
            "user",
            `${prefix}_USER_TEXT Fix the auth bug token origin.`,
        ),
        ordinaryMessage(
            sessionID,
            "msg_recall_2",
            "assistant",
            `${prefix}_ASSISTANT_TEXT established the parser boundary.`,
        ),
        ordinaryMessage(
            sessionID,
            "msg_recall_3",
            "user",
            `${prefix}_OUTSIDE_MARKER database connection pool.`,
        ),
        ordinaryMessage(
            sessionID,
            "msg_recall_4",
            "assistant",
            `${prefix}_BETA_TEXT applied the expiry fix to token.`,
        ),
        nativeRecallToolMessage(
            sessionID,
            "msg_recall_5",
            "read",
            "call_recall_read",
            `${prefix}_TOOL_OUTPUT export function validateToken...`,
        ),
        ordinaryMessage(
            sessionID,
            "msg_recall_6",
            "user",
            `${prefix}_TRAILING_MARKER follow-up.`,
        ),
    ]
}

function nativeTextMessage(
    messageID: string,
    role: "user" | "assistant",
    text: string,
    created = 5,
): NativeMessage {
    if (role === "user") return { id: messageID, type: "user", text, time: { created } }
    return {
        id: messageID,
        type: "assistant",
        agent: "assistant",
        model: { providerID: "test", id: "test" },
        content: [{ type: "text", text }],
        time: { created },
    }
}

async function seedNativeRecallFixture(
    t: TestContext,
    options: { prefix?: string; blocks?: boolean } = {},
) {
    const prefix = options.prefix ?? "RECALL"
    const sessionID = `ses_native_recall_${randomUUID()}`
    const h = await createHousekeepingHarness(t, {
        messages: nativeRecallMessages(sessionID, prefix),
    })
    if (options.blocks !== false) {
        await h.enter()
        await stageBlock(h, `${prefix}_BLOCK_ONE_SUMMARY`, "m0001", "m0002")
        await stageBlock(h, `${prefix}_BLOCK_TWO_SUMMARY`, "m0004", "m0005")
        await h.leave()
    }
    return { prefix, h, contextMessages: toNativeHistory(h.history) }
}

async function enterNativeRecallTransaction(
    t: TestContext,
    h: Awaited<ReturnType<typeof createHousekeepingHarness>>,
    contextMessages: NativeMessage[],
    options: Pick<NativeHarnessOptions, "sessionInfo" | "allowSubAgents"> = {},
) {
    const suffix = nextNativeFixtureSuffix()
    const entry = {
        messageID: `msg_native_recall_entry_${suffix}`,
        callID: `call_native_recall_entry_${suffix}`,
    }
    pushNativeRunningCall(
        contextMessages,
        h.sessionID,
        entry.messageID,
        entry.callID,
        "enter_housekeeping",
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        ...options,
    })
    await native.execute("enter_housekeeping", {}, entry)
    return { native, entry }
}

async function persistedHousekeepingOperationCount(sessionID: string): Promise<number> {
    const fixture = JSON.parse(await readFile(getSessionFilePath(sessionID), "utf-8")) as any
    return fixture?.housekeeping?.operationRecords?.length ?? 0
}

test("native recall_compressed registers the shared schema, runtime description, codemode and result", async (t) => {
    const { h, contextMessages } = await seedNativeRecallFixture(t)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    const definition = native.requiredTool("recall_compressed")
    assert.equal(definition.input?.type, "object")
    assert.equal(definition.input?.additionalProperties, false)
    assert.deepEqual([...(definition.input?.required ?? [])], ["action"])
    assert.deepEqual(Object.keys(definition.input?.properties ?? {}).sort(), [
        "action",
        "blockId",
        "blockIdEnd",
        "blockIdStart",
        "messageId",
        "messageIdEnd",
        "messageIdStart",
        "query",
    ])
    assert.deepEqual(definition.input?.properties?.action?.enum, ["get", "search"])
    for (const key of ["blockId", "blockIdStart", "blockIdEnd"])
        assert.equal(definition.input?.properties?.[key]?.type, "number", key)
    for (const key of ["messageId", "messageIdStart", "messageIdEnd", "query"])
        assert.equal(definition.input?.properties?.[key]?.type, "string", key)
    assert.equal(definition.options?.codemode, false)
    assert.equal(definition.description, RECALL_COMPRESSED + RECALL_FORMAT_EXTENSION)

    const result = await native.execute("recall_compressed", {
        action: "get",
        messageId: "m0001",
    })
    assert.match(result, /^Message m0001 — 1 message\(s\), ~/)
    assert.match(result, /RECALL_USER_TEXT/)
    assert.doesNotMatch(result, /BLOCK_ONE_SUMMARY/)
})

test("native recall_compressed uses the configured runtime description", async (t) => {
    const { h, contextMessages } = await seedNativeRecallFixture(t)
    const overrideDir = join(h.root, ".opencode", "dcp-prompts", "overrides")
    await mkdir(overrideDir, { recursive: true })
    await writeFile(join(overrideDir, "recall.md"), "Configured recall instructions.\n")

    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        customPrompts: true,
    })
    const definition = native.requiredTool("recall_compressed")
    assert.match(definition.description, /Configured recall instructions\./)
    assert.match(definition.description, /THE FORMAT OF RECALL_COMPRESSED/)
    assert.doesNotMatch(definition.description, /lets you retrieve original messages/)
})

test("native recall_compressed gets original user and assistant text instead of the summary", async (t) => {
    const { h, contextMessages } = await seedNativeRecallFixture(t)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    const user = await native.execute("recall_compressed", { action: "get", messageId: "m0001" })
    assert.match(user, /--- user ---/)
    assert.match(user, /RECALL_USER_TEXT Fix the auth bug token origin\./)
    assert.doesNotMatch(user, /BLOCK_ONE_SUMMARY/)

    const assistant = await native.execute("recall_compressed", {
        action: "get",
        messageId: "m0002",
    })
    assert.match(assistant, /--- assistant ---/)
    assert.match(assistant, /RECALL_ASSISTANT_TEXT established the parser boundary\./)
    assert.doesNotMatch(assistant, /BLOCK_ONE_SUMMARY/)
})

test("native recall_compressed retrieves and searches native tool text content", async (t) => {
    const { h, contextMessages } = await seedNativeRecallFixture(t)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    const get = await native.execute("recall_compressed", { action: "get", messageId: "m0005" })
    assert.match(get, /\[tool:read\] RECALL_TOOL_OUTPUT export function validateToken/)
    assert.doesNotMatch(get, /RECALL_USER_TEXT|RECALL_BETA_TEXT/)

    const search = await native.execute("recall_compressed", {
        action: "search",
        query: "TOOL_OUTPUT",
        blockId: 2,
    })
    assert.match(search, /Found 1 match/)
    assert.match(search, /RECALL_TOOL_OUTPUT/)
    assert.doesNotMatch(search, /RECALL_USER_TEXT|RECALL_OUTSIDE_MARKER/)
})

test("native recall_compressed returns inclusive message ranges in original order", async (t) => {
    const { h, contextMessages } = await seedNativeRecallFixture(t)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    const result = await native.execute("recall_compressed", {
        action: "get",
        messageIdStart: "m0001",
        messageIdEnd: "m0003",
    })
    assert.match(result, /Messages m0001 → m0003 — 3 message\(s\)/)
    const userIndex = result.indexOf("RECALL_USER_TEXT")
    const assistantIndex = result.indexOf("RECALL_ASSISTANT_TEXT")
    const outsideIndex = result.indexOf("RECALL_OUTSIDE_MARKER")
    assert.ok(userIndex >= 0 && assistantIndex > userIndex && outsideIndex > assistantIndex)
    assert.doesNotMatch(result, /RECALL_BETA_TEXT|RECALL_TRAILING_MARKER/)
})

for (const scenario of [
    {
        title: "a missing message reference",
        input: { action: "get", messageId: "m9999" },
        error: /not found/i,
    },
    {
        title: "a prohibited block target",
        input: { action: "get", blockId: 1 },
        error: /Cannot use blockId/,
    },
    {
        title: "a missing selector",
        input: { action: "get" },
        error: /Provide a messageId/,
    },
    {
        title: "an incomplete message range",
        input: { action: "get", messageIdStart: "m0001" },
        error: /Provide a messageId/,
    },
]) {
    test(`native recall_compressed get rejects ${scenario.title}`, async (t) => {
        const { h, contextMessages } = await seedNativeRecallFixture(t)
        const native = await createNativeHarness(t, {
            root: h.root,
            sessionID: h.sessionID,
            contextMessages,
        })
        await assert.rejects(
            native.execute("recall_compressed", scenario.input),
            scenario.error,
        )
    })
}

for (const scenario of [
    {
        title: "the default compressed coverage",
        input: { action: "search", query: "." },
        included: [
            "RECALL_USER_TEXT",
            "RECALL_ASSISTANT_TEXT",
            "RECALL_BETA_TEXT",
            "RECALL_TOOL_OUTPUT",
        ],
        excluded: ["RECALL_OUTSIDE_MARKER", "RECALL_TRAILING_MARKER"],
        count: /Found 4 match/,
    },
    {
        title: "a single block",
        input: { action: "search", query: ".", blockId: 1 },
        included: ["RECALL_USER_TEXT", "RECALL_ASSISTANT_TEXT"],
        excluded: ["RECALL_BETA_TEXT", "RECALL_TOOL_OUTPUT", "RECALL_OUTSIDE_MARKER"],
        count: /Found 2 match/,
    },
    {
        title: "a paired block range",
        input: { action: "search", query: ".", blockIdStart: 1, blockIdEnd: 2 },
        included: [
            "RECALL_USER_TEXT",
            "RECALL_ASSISTANT_TEXT",
            "RECALL_BETA_TEXT",
            "RECALL_TOOL_OUTPUT",
        ],
        excluded: ["RECALL_OUTSIDE_MARKER", "RECALL_TRAILING_MARKER"],
        count: /Found 4 match/,
    },
    {
        title: "a message range",
        input: {
            action: "search",
            query: ".",
            messageIdStart: "m0001",
            messageIdEnd: "m0003",
        },
        included: ["RECALL_USER_TEXT", "RECALL_ASSISTANT_TEXT", "RECALL_OUTSIDE_MARKER"],
        excluded: ["RECALL_BETA_TEXT", "RECALL_TOOL_OUTPUT", "RECALL_TRAILING_MARKER"],
        count: /Found 3 match/,
    },
]) {
    test(`native recall_compressed search covers ${scenario.title}`, async (t) => {
        const { h, contextMessages } = await seedNativeRecallFixture(t)
        const native = await createNativeHarness(t, {
            root: h.root,
            sessionID: h.sessionID,
            contextMessages,
        })
        const result = await native.execute("recall_compressed", scenario.input)
        assert.match(result, scenario.count)
        for (const marker of scenario.included) assert.ok(result.includes(marker), marker)
        for (const marker of scenario.excluded) assert.equal(result.includes(marker), false, marker)
    })
}

test("native recall_compressed search matches regex patterns case-insensitively", async (t) => {
    const { h, contextMessages } = await seedNativeRecallFixture(t)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    const result = await native.execute("recall_compressed", {
        action: "search",
        query: "recall_(assistant|nonexistent)_text",
    })
    assert.match(result, /Found 1 match/)
    assert.match(result, /RECALL_ASSISTANT_TEXT/)
})

test("native recall_compressed search reports no matches", async (t) => {
    const { h, contextMessages } = await seedNativeRecallFixture(t)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    assert.equal(
        await native.execute("recall_compressed", {
            action: "search",
            query: "RECALL_NO_SUCH_MARKER",
        }),
        "No matches found for the query.",
    )
})

test("native recall_compressed search reports no messages without compressed blocks", async (t) => {
    const sessionID = `ses_native_recall_empty_${randomUUID()}`
    const h = await createHousekeepingHarness(t, {
        messages: nativeRecallMessages(sessionID, "EMPTY"),
    })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
    })
    assert.equal(
        await native.execute("recall_compressed", { action: "search", query: "." }),
        "No messages to search.",
    )
})

test("native recall_compressed search rejects an invalid regex with a nonempty target", async (t) => {
    const { h, contextMessages } = await seedNativeRecallFixture(t)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    await assert.rejects(
        native.execute("recall_compressed", { action: "search", query: "[" }),
        /Invalid search pattern/,
    )
})

test("native recall_compressed search rejects a missing query", async (t) => {
    const { h, contextMessages } = await seedNativeRecallFixture(t)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    await assert.rejects(
        native.execute("recall_compressed", { action: "search" }),
        /Query is required/,
    )
})

test("native recall_compressed search rejects an absent block", async (t) => {
    const { h, contextMessages } = await seedNativeRecallFixture(t)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    await assert.rejects(
        native.execute("recall_compressed", { action: "search", query: ".", blockId: 99 }),
        /Block 99 not found/,
    )
})

for (const action of ["get", "search"] as const) {
    for (const scenario of [
        {
            title: "a malformed start reference",
            range: { messageIdStart: "x0001", messageIdEnd: "m0002" },
            error: /Invalid message reference/,
        },
        {
            title: "a malformed end reference",
            range: { messageIdStart: "m0001", messageIdEnd: "x0002" },
            error: /Invalid message reference/,
        },
        {
            title: "reversed existing references",
            range: { messageIdStart: "m0004", messageIdEnd: "m0002" },
            error: /reversed/i,
        },
    ]) {
        test(`native recall_compressed ${action} rejects ${scenario.title}`, async (t) => {
            const { h, contextMessages } = await seedNativeRecallFixture(t)
            const native = await createNativeHarness(t, {
                root: h.root,
                sessionID: h.sessionID,
                contextMessages,
            })
            const input =
                action === "search"
                    ? { action, query: ".", ...scenario.range }
                    : { action, ...scenario.range }
            await assert.rejects(
                native.execute("recall_compressed", input),
                scenario.error,
            )
        })
    }
}

test("native recall excludes completed housekeeping interior text and tool output", async (t) => {
    const sessionID = `ses_native_recall_interior_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    await h.enter()
    h.addText("private-recall-note", "HOUSEKEEPING_RECALL_PRIVATE token investigation")
    h.history.push(
        nativeRecallToolMessage(
            sessionID,
            "private-recall-tool",
            "read",
            "call_private_recall",
            "HOUSEKEEPING_RECALL_TOOL_PRIVATE output",
        ),
    )
    await h.leave({ force: true })
    h.addText("msg_source_5", "Outside token follow-up.", "user")
    await h.render()
    await h.enter()
    await stageBlock(h, "Cross-boundary ordinary findings.", "m0001", "m0005")
    await h.leave({ force: true })

    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages: toNativeHistory(h.history),
    })
    const range = await native.execute("recall_compressed", {
        action: "get",
        messageIdStart: "m0001",
        messageIdEnd: "m0005",
    })
    assert.match(range, /Messages m0001 → m0005 — 5 message\(s\)/)
    assert.match(range, /Outside token follow-up\./)
    assert.doesNotMatch(
        range,
        /HOUSEKEEPING_RECALL_PRIVATE|HOUSEKEEPING_RECALL_TOOL_PRIVATE|\[tool:enter_housekeeping\]|\[tool:leave_housekeeping\]/,
    )
    assert.equal(
        await native.execute("recall_compressed", {
            action: "search",
            query: "HOUSEKEEPING_RECALL",
        }),
        "No matches found for the query.",
    )
})

test("native recall restricts active-mode sources to messages captured at entry", async (t) => {
    const sessionID = `ses_native_recall_active_${randomUUID()}`
    const h = await createHousekeepingHarness(t, {
        messages: [
            ordinaryMessage(sessionID, "msg_active_1", "user", "ACTIVE_FIRST inbound."),
            ordinaryMessage(sessionID, "msg_active_2", "assistant", "ACTIVE_SECOND reply."),
            ordinaryMessage(sessionID, "msg_active_3", "user", "ACTIVE_THIRD follow-up."),
        ],
    })
    const contextMessages = toNativeHistory(h.history)
    const suffix = nextNativeFixtureSuffix()
    const entry = {
        messageID: `msg_native_recall_active_entry_${suffix}`,
        callID: `call_native_recall_active_entry_${suffix}`,
    }
    pushNativeRunningCall(
        contextMessages,
        h.sessionID,
        entry.messageID,
        entry.callID,
        "enter_housekeeping",
    )
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    await native.execute("enter_housekeeping", {}, entry)
    const live = native.getContext()
    live.splice(
        2,
        0,
        nativeTextMessage("msg_active_post", "user", "POST_ENTRY_SECRET must stay hidden", 25),
    )
    native.setContext(live)

    for (const input of [
        { action: "get", messageIdStart: "m0001", messageIdEnd: "m0003" },
        {
            action: "search",
            query: ".",
            messageIdStart: "m0001",
            messageIdEnd: "m0003",
        },
    ]) {
        const result = await native.execute("recall_compressed", input)
        assert.match(result, input.action === "get" ? /3 message\(s\)/ : /Found 3 match/)
        assert.match(result, /ACTIVE_FIRST inbound/)
        assert.match(result, /ACTIVE_THIRD follow-up/)
        assert.doesNotMatch(result, /POST_ENTRY_SECRET/)
    }
})

test("native recall sees active expanded draft coverage without changing committed coverage or operations", async (t) => {
    const { h, contextMessages } = await seedNativeRecallFixture(t)
    const { native } = await enterNativeRecallTransaction(t, h, contextMessages)
    await recordNativeToolResult(
        native,
        "expand_block",
        { blockId: 1, endId: "m0003" },
        {
            messageID: "msg_native_recall_expand",
            callID: "call_native_recall_expand",
        },
    )

    const committedBefore = await persistedBlockById(h.sessionID, 1)
    assert.equal(committedBefore?.endId, "m0002")
    assert.deepEqual([...(committedBefore?.effectiveMessageIds ?? [])].sort(), [
        "msg_recall_1",
        "msg_recall_2",
    ])
    const draftBefore = await persistedActiveDraftBlock(h.sessionID, 1)
    assert.equal(draftBefore.endId, "m0003")
    const operationsBefore = await persistedHousekeepingOperationCount(h.sessionID)
    assert.ok(operationsBefore > 0)

    const single = await native.execute("recall_compressed", {
        action: "search",
        query: "RECALL_OUTSIDE_MARKER",
        blockId: 1,
    })
    assert.match(single, /Found 1 match/)
    assert.match(single, /RECALL_OUTSIDE_MARKER/)
    const expanded = await native.execute("recall_compressed", {
        action: "search",
        query: ".",
        blockId: 1,
    })
    assert.match(expanded, /Found 3 match/)
    assert.doesNotMatch(expanded, /RECALL_BETA_TEXT/)
    const recalled = await native.execute("recall_compressed", {
        action: "get",
        messageId: "m0003",
    })
    assert.match(recalled, /RECALL_OUTSIDE_MARKER/)

    assert.equal(await persistedHousekeepingOperationCount(h.sessionID), operationsBefore)
    assert.deepEqual(await persistedActiveDraftBlock(h.sessionID, 1), draftBefore)
    assert.deepEqual(await persistedBlockById(h.sessionID, 1), committedBefore)
})

test("native recall retrieves committed content without entering housekeeping", async (t) => {
    const { h, contextMessages } = await seedNativeRecallFixture(t)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    const got = await native.execute("recall_compressed", { action: "get", messageId: "m0001" })
    assert.match(got, /RECALL_USER_TEXT/)
    const searched = await native.execute("recall_compressed", {
        action: "search",
        query: "RECALL_ASSISTANT_TEXT",
        blockId: 1,
    })
    assert.match(searched, /Found 1 match/)
    assert.match(searched, /RECALL_ASSISTANT_TEXT/)
})

test("native recall keeps two sessions isolated in one setup", async (t) => {
    const first = await seedNativeRecallFixture(t, { prefix: "FIRST_SESSION" })
    const second = await seedNativeRecallFixture(t, { prefix: "SECOND_SESSION" })
    const native = await createNativeHarness(t, {
        root: first.h.root,
        sessionID: first.h.sessionID,
        contextMessages: first.contextMessages,
    })
    native.setContextFor(second.h.sessionID, second.contextMessages)
    native.setSessionInfoFor(first.h.sessionID, { id: first.h.sessionID })
    native.setSessionInfoFor(second.h.sessionID, { id: second.h.sessionID })

    const firstResult = await native.execute(
        "recall_compressed",
        { action: "search", query: "." },
        { sessionID: first.h.sessionID },
    )
    const secondResult = await native.execute(
        "recall_compressed",
        { action: "search", query: "." },
        { sessionID: second.h.sessionID },
    )
    assert.match(firstResult, /FIRST_SESSION_USER_TEXT/)
    assert.doesNotMatch(firstResult, /SECOND_SESSION/)
    assert.match(secondResult, /SECOND_SESSION_USER_TEXT/)
    assert.doesNotMatch(secondResult, /FIRST_SESSION/)
})

test("native recall asserts permission before any session read and reports its native source", async (t) => {
    const { h, contextMessages } = await seedNativeRecallFixture(t)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        assertError: new Error("permission denied"),
    })
    const messageID = "msg_native_recall_permission"
    const callID = "call_native_recall_permission"
    native.requiredTool("recall_compressed")

    await assert.rejects(
        native.execute(
            "recall_compressed",
            { action: "get", messageId: "m0001" },
            { messageID, callID },
        ),
        /permission|denied/i,
    )
    assert.equal(native.context.mock.callCount(), 0)
    assert.equal(native.get.mock.callCount(), 0)
    assert.deepEqual(native.assertPermission.mock.calls.at(-1)?.arguments[0], {
        sessionID: h.sessionID,
        agent: "assistant",
        action: "recall_compressed",
        resources: ["*"],
        source: { type: "tool", messageID, id: callID },
    })
})

for (const scenario of [
    {
        title: "history",
        options: { contextError: new Error("native history read failed") },
        error: /history/i,
    },
    {
        title: "metadata",
        options: { getError: new Error("native session metadata read failed") },
        error: /metadata/i,
    },
]) {
    test(`native recall propagates ${scenario.title} read failures`, async (t) => {
        const { h, contextMessages } = await seedNativeRecallFixture(t)
        const native = await createNativeHarness(t, {
            root: h.root,
            sessionID: h.sessionID,
            contextMessages,
            ...scenario.options,
        })
        assert.ok(native.tool("recall_compressed"))
        await assert.rejects(
            native.execute("recall_compressed", { action: "get", messageId: "m0001" }),
            scenario.error,
        )
    })
}

test("native recall follows the subagent policy", async (t) => {
    const { h, contextMessages } = await seedNativeRecallFixture(t)
    const sessionInfo = { id: h.sessionID, parentID: "msg_parent_session" }

    const disallowed = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        sessionInfo,
        allowSubAgents: false,
    })
    assert.ok(disallowed.tool("recall_compressed"))
    await assert.rejects(
        disallowed.execute("recall_compressed", { action: "get", messageId: "m0001" }),
        /subagent|sub-agent|parent/i,
    )

    const allowed = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        sessionInfo,
        allowSubAgents: true,
    })
    assert.match(
        await allowed.execute("recall_compressed", { action: "get", messageId: "m0001" }),
        /RECALL_USER_TEXT/,
    )
})

test("native recall is omitted by DCP deny and disabled setup with an allow control", async (t) => {
    const { h, contextMessages } = await seedNativeRecallFixture(t)

    const allowed = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
    })
    assert.ok(allowed.tool("recall_compressed"))

    const denied = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        compressPermission: "deny",
    })
    assert.equal(denied.tool("recall_compressed"), undefined)

    const disabled = await createNativeHarness(t, {
        root: h.root,
        sessionID: h.sessionID,
        contextMessages,
        enabled: false,
    })
    assert.equal(disabled.tool("recall_compressed"), undefined)
    assert.deepEqual(disabled.definitions, [])
})

test("v2 server commands register dcp only when commands and DCP are enabled", async (t) => {
    const sessionID = `ses_server_commands_gate_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })

    const enabled = await createNativeHarness(t, {
        root: h.root,
        sessionID,
        contextMessages: toNativeHistory(h.history),
        commandSurface: true,
    })
    const definition = enabled.command("dcp")
    assert.ok(definition, "dcp command must be registered")
    assert.equal(definition.name, "dcp")
    assert.equal(typeof definition.description, "string")
    assert.ok(definition.description.length > 0)
    assert.equal(typeof definition.execute, "function")
    assert.ok(enabled.commandTransform.mock.callCount() > 0)

    const commandsDisabled = await createNativeHarness(t, {
        root: h.root,
        sessionID,
        contextMessages: toNativeHistory(h.history),
        commandsEnabled: false,
        commandSurface: true,
    })
    assert.equal(commandsDisabled.command("dcp"), undefined)
    assert.deepEqual(commandsDisabled.commandDefinitions, [])

    const dcpDisabled = await createNativeHarness(t, {
        root: h.root,
        sessionID,
        contextMessages: toNativeHistory(h.history),
        enabled: false,
        commandSurface: true,
    })
    assert.equal(dcpDisabled.command("dcp"), undefined)
    assert.deepEqual(dcpDisabled.commandDefinitions, [])
})

test("v2 server commands stats output is queued display-only synthetic without a prompt", async (t) => {
    const sessionID = `ses_server_commands_stats_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID,
        contextMessages: toNativeHistory(h.history),
        commandSurface: true,
    })

    await native.runCommand("stats")

    assert.equal(native.synthetic.mock.callCount(), 1)
    const call = native.synthetic.mock.calls[0]?.arguments[0] as any
    assert.equal(call.sessionID, sessionID)
    assert.match(call.text, /DCP Statistics/)
    assert.match(call.text, /All-time:/)
    assert.equal(call.metadata?.hyperdcp?.displayOnly, true)
    assert.equal(call.resume, false)
    assert.equal(native.prompt.mock.callCount(), 0)
    assert.ok(native.context.mock.callCount() > 0)
    for (const contextCall of native.context.mock.calls)
        assert.deepEqual(contextCall.arguments[0], { sessionID })
})

test("v2 server commands manual mutation outputs display-only text isolated per session", async (t) => {
    const sessionID = `ses_server_commands_manual_a_${randomUUID()}`
    const otherSessionID = `ses_server_commands_manual_b_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID,
        contextMessages: toNativeHistory(h.history),
        commandSurface: true,
    })
    native.setContextFor(otherSessionID, toNativeHistory(nativeFixtureMessages(otherSessionID)))
    native.setSessionInfoFor(otherSessionID, { id: otherSessionID, parentID: undefined })

    await native.runCommand("manual on")
    await native.runCommand("manual on", { sessionID: otherSessionID })

    assert.equal(native.synthetic.mock.callCount(), 2)
    const calls = native.synthetic.mock.calls.map((call) => call.arguments[0] as any)
    assert.equal(calls[0]?.sessionID, sessionID)
    assert.equal(calls[1]?.sessionID, otherSessionID)
    for (const call of calls) {
        assert.match(call.text, /Manual mode is now ON\./)
        assert.equal(call.metadata?.hyperdcp?.displayOnly, true)
        assert.equal(call.resume, false)
    }
    assert.equal(native.prompt.mock.callCount(), 0)
})

test("v2 server commands compress generation prompts with supplied focus and delivery", async (t) => {
    const sessionID = `ses_server_commands_compress_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID,
        contextMessages: toNativeHistory(h.history),
        commandSurface: true,
    })
    const files = [{ uri: "file:///focus.md", name: "focus.md", source: { type: "uri", uri: "file:///focus.md" } }]
    const agents = [{ name: "reviewer" }]
    const skills = [{ id: "skill_review" }]

    await native.runCommand("compress inspect parser boundary", {
        delivery: "queue",
        files,
        agents,
        skills,
    })

    assert.equal(native.prompt.mock.callCount(), 1)
    const call = native.prompt.mock.calls[0]?.arguments[0] as any
    assert.equal(call.sessionID, sessionID)
    assert.match(call.text, /COMPRESS FLOW/)
    assert.match(call.text, /Additional user focus:\ninspect parser boundary/)
    assert.equal(call.delivery, "queue")
    assert.deepEqual(call.files, files)
    assert.deepEqual(call.agents, agents)
    assert.deepEqual(call.skills, skills)
    assert.equal(native.synthetic.mock.callCount(), 0)
})

test("v2 server commands rewrite generation prompts with supplied block aspect and delivery", async (t) => {
    const sessionID = `ses_server_commands_rewrite_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h)
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID,
        contextMessages,
        commandSurface: true,
    })

    await native.runCommand("rewrite 1 tighten examples", { delivery: "steer" })

    assert.equal(native.prompt.mock.callCount(), 1)
    const call = native.prompt.mock.calls[0]?.arguments[0] as any
    assert.equal(call.sessionID, sessionID)
    assert.match(call.text, /Rewrite the summary for compression block #1\./)
    assert.match(call.text, /instruction: "tighten examples"/)
    assert.equal(call.delivery, "steer")
    assert.equal(native.synthetic.mock.callCount(), 0)
})

test("v2 server commands persist editor memo and summary files across setup restart", async (t) => {
    const sessionID = `ses_server_editor_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = await seedVersionedSummaryFixture(h)
    const options = { root: h.root, sessionID, contextMessages, commandSurface: true }
    const native = await createNativeHarness(t, options)
    const memoFile = join(h.root, "memo.md")
    const summaryFile = join(h.root, "summary.md")
    await writeFile(memoFile, "Saved memo from editor")
    await writeFile(summaryFile, "Saved summary from editor")

    await native.runCommand(`memo-file ${memoFile}`)
    await native.runCommand(`edit-file 1 ${summaryFile}`)

    const persisted = await readFile(getSessionFilePath(sessionID), "utf8")
    assert.match(persisted, /Saved memo from editor/)
    assert.ok((await persistedBlock(sessionID)).summaryVersions.includes("Saved summary from editor"))
    const restarted = await createNativeHarness(t, options)
    assert.equal((await restarted.readMemo()).content, "Saved memo from editor")
    assert.match(await restarted.execute("fetch_summary_versions", { blockId: 1 }), /Saved summary from editor/)
    assert.equal(native.prompt.mock.callCount(), 0)
})

test("v2 server commands exclude owned display-only synthetic while keeping ordinary synthetic", async (t) => {
    const sessionID = `ses_server_commands_display_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const contextMessages = toNativeHistory(h.history)
    contextMessages.push({
        id: "msg_owned_context_output",
        type: "synthetic",
        text: "DCP Statistics: owned output",
        metadata: { hyperdcp: { displayOnly: true } },
        time: { created: 20 },
    })
    contextMessages.push({
        id: "msg_ordinary_synthetic_output",
        type: "synthetic",
        text: "Ordinary synthetic report",
        metadata: { source: "goal" },
        time: { created: 21 },
    })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID,
        contextMessages,
        commandSurface: true,
    })

    const request = {
        sessionID,
        options: {},
        messages: [
            { id: "msg_source_1", role: "user", content: [{ type: "text", text: "Investigate the parser boundary." }] },
            {
                id: "msg_owned_request_output",
                role: "user",
                metadata: { hyperdcp: { displayOnly: true } },
                content: [{ type: "text", text: "DCP Statistics: owned output" }],
            },
            {
                id: "msg_owned_context_output",
                role: "user",
                content: [{ type: "text", text: "DCP Statistics: owned output" }],
            },
            {
                id: "msg_ordinary_synthetic_output",
                role: "user",
                content: [{ type: "text", text: "Ordinary synthetic report" }],
            },
        ],
    }
    await native.projectContext(request)

    const ids = request.messages.map((message) => message.id)
    assert.equal(ids.includes("msg_owned_request_output"), false)
    assert.equal(ids.includes("msg_owned_context_output"), false)
    assert.equal(ids.includes("msg_ordinary_synthetic_output"), true)
    assert.doesNotMatch(JSON.stringify(request.messages), /owned output/)
    assert.match(JSON.stringify(request.messages), /Ordinary synthetic report/)
})

test("v2 server commands generation admission failure propagates without synthetic output", async (t) => {
    const sessionID = `ses_server_commands_error_${randomUUID()}`
    const h = await createHousekeepingHarness(t, { messages: nativeFixtureMessages(sessionID) })
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID,
        contextMessages: toNativeHistory(h.history),
        commandSurface: true,
    })
    native.prompt.mock.mockImplementation(async () => {
        throw new Error("generation admission denied")
    })

    await assert.rejects(native.runCommand("compress"), /generation admission denied/)

    assert.equal(native.synthetic.mock.callCount(), 0)
})

async function runNativeNotificationLifecycle(
    t: TestContext,
    options: Omit<NativeHarnessOptions, "root" | "sessionID" | "contextMessages"> & {
        configureNative?: (native: any) => void
    } = {},
) {
    const sessionID = `ses_native_notification_${randomUUID()}`
    const h = await createHousekeepingHarness(t, {
        messages: nativeFixtureMessages(sessionID),
        mode: "range",
    })
    const { configureNative, ...nativeOptions } = options
    const native = await createNativeHarness(t, {
        root: h.root,
        sessionID,
        contextMessages: toNativeHistory(h.history),
        commandSurface: true,
        compressMode: "range",
        ...nativeOptions,
    })
    configureNative?.(native)
    const suffix = nextNativeFixtureSuffix()
    const enter = {
        messageID: `msg_notify_enter_${suffix}`,
        callID: `call_notify_enter_${suffix}`,
    }
    native.appendToolCall(enter.messageID, enter.callID, "enter_housekeeping", {}, { status: "running" })
    await native.execute("enter_housekeeping", {}, enter)
    const input = {
        topic: "Parser",
        content: [{ startId: "m0001", endId: "m0002", summary: "Parser findings." }],
    }
    const compress = {
        messageID: `msg_notify_compress_${suffix}`,
        callID: `call_notify_compress_${suffix}`,
    }
    native.appendToolCall(compress.messageID, compress.callID, "compress", input, { status: "running" })
    await native.execute("compress", input, compress)
    const leave = {
        messageID: `msg_notify_leave_${suffix}`,
        callID: `call_notify_leave_${suffix}`,
    }
    const receipt = await native.execute("leave_housekeeping", { force: true }, leave)
    native.appendToolCall(
        leave.messageID,
        leave.callID,
        "leave_housekeeping",
        { force: true },
        { text: receipt, created: 30 },
    )
    return { h, native, receipt, sessionID }
}

test("v2 compression notifications stay silent when notifications are off", async (t) => {
    const { h, native } = await runNativeNotificationLifecycle(t, {
        pruneNotification: "off",
        pruneNotificationType: "chat",
        showCompression: true,
    })

    assert.equal(native.synthetic.mock.callCount(), 0)
    assert.equal(native.toastEvents.length, 0)
    const committed = await persistedBlockById(h.sessionID)
    assert.equal(committed?.endId, "m0002")
    assert.ok(committed?.effectiveMessageIds.includes("msg_source_1"))
})

test("v2 compression messages deliver owned display-only synthetic and keep the committed block", async (t) => {
    const { h, native, sessionID } = await runNativeNotificationLifecycle(t, {
        pruneNotification: "detailed",
        pruneNotificationType: "chat",
        showCompression: true,
    })

    assert.equal(native.synthetic.mock.callCount(), 1)
    const call = native.synthetic.mock.calls[0]?.arguments[0] as any
    assert.equal(call.sessionID, sessionID)
    assert.equal(call.resume, false)
    assert.equal(call.metadata?.hyperdcp?.displayOnly, true)
    assert.match(call.text, /▣ DCP \|/)
    assert.match(call.text, /Compression #1/)
    assert.match(call.text, /Topic: Parser/)
    assert.match(call.text, /Items: 2 messages/)
    assert.match(call.text, /Compression \(~/)
    assert.equal(native.toastEvents.length, 0)
    const committed = await persistedBlockById(h.sessionID)
    assert.equal(committed?.endId, "m0002")
    assert.ok(committed?.effectiveMessageIds.includes("msg_source_1"))
})

test("v2 compression toasts emit through the registered notification RPC", async (t) => {
    const { h, native, sessionID } = await runNativeNotificationLifecycle(t, {
        pruneNotification: "detailed",
        pruneNotificationType: "toast",
        showCompression: true,
        configureNative(native) {
            Object.assign(native.host.location, { workspaceID: "ws_notification" })
        },
    })

    assert.equal(native.rpcRegister.mock.callCount(), 1)
    const registration = native.rpcRegistrations[0]
    assert.equal(registration?.definition?.id, "hyperdcp-notifications")
    assert.deepEqual(registration?.definition?.methods, {})
    assert.equal(registration?.definition?.events?.toast?.schema?.type, "object")
    assert.deepEqual(registration?.handlers, {})
    assert.equal(native.toastEvents.length, 1)
    const payload = native.toastEvents[0] as any
    assert.equal(payload.sessionID, sessionID)
    assert.equal(payload.workspaceID, "ws_notification")
    assert.equal(payload.title, "DCP: Compress Notification")
    assert.equal(payload.variant, "info")
    assert.equal(payload.duration, 5000)
    assert.match(payload.message, /▣ DCP \|/)
    assert.match(payload.message, /Compression #1/)
    assert.match(payload.message, /Topic: Parser/)
    assert.match(payload.message, /Items: 2 messages/)
    assert.match(payload.message, /Compression \(~/)
    assert.equal(native.synthetic.mock.callCount(), 0)
    const committed = await persistedBlockById(h.sessionID)
    assert.equal(committed?.endId, "m0002")
})

test("v2 compression notification delivery failure leaves the commit intact", async (t) => {
    const { h, native, receipt } = await runNativeNotificationLifecycle(t, {
        pruneNotification: "detailed",
        pruneNotificationType: "chat",
        showCompression: true,
        configureNative(native) {
            native.synthetic.mock.mockImplementation(async () => {
                throw new Error("notification delivery unavailable")
            })
        },
    })

    assert.match(receipt, /Housekeeping complete/)
    assert.equal(native.synthetic.mock.callCount(), 1)
    const committed = await persistedBlockById(h.sessionID)
    assert.equal(committed?.endId, "m0002")
    assert.ok(committed?.effectiveMessageIds.includes("msg_source_1"))
})
