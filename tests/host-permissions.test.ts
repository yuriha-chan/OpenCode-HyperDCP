import "./helpers/storage-env"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import server from "../index"
import nativeServerDefinition from "../server"
import { getSessionFilePath } from "../lib/paths"
import type { SkillContext, WithParts } from "../lib/state"
import { createHousekeepingHarness, ordinaryMessage } from "./helpers/housekeeping"
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
    allowSubAgents?: boolean
    manualModeEnabled?: boolean
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
        "enabled" | "compressPermission" | "allowSubAgents" | "manualModeEnabled" | "allowedTools"
    >,
): Promise<void> {
    await mkdir(join(root, ".opencode"), { recursive: true })
    await writeFile(
        join(root, ".opencode", "dcp.json"),
        JSON.stringify({
            enabled: options.enabled ?? true,
            autoUpdate: false,
            debug: false,
            compress: { permission: options.compressPermission ?? "allow" },
            manualMode: { enabled: options.manualModeEnabled ?? false },
            housekeeping: { allowedTools: options.allowedTools ?? [] },
            experimental: {
                allowSubAgents: options.allowSubAgents ?? false,
                customPrompts: false,
            },
        }),
    )
}

async function createNativeHarness(t: TestContext, options: NativeHarnessOptions) {
    await writeNativeConfig(options.root, options)
    const definitions: any[] = []
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
    const host = {
        location: { directory: options.root },
        session: { hook, context, get },
        agent: { get: getAgent },
        permission: { assert: assertPermission },
        tool: { transform, hook: toolHook },
    }
    await nativeServerDefinition.setup(host as any)
    const tool = (name: string) => definitions.find((definition) => definition.name === name)
    const requiredTool = (name: string) => {
        const definition = tool(name)
        assert.ok(definition, `${name} must be registered`)
        return definition
    }
    let callCounter = 0
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
            progress: async () => {},
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
        tool,
        requiredTool,
        execute,
        readMemo,
        guard,
        requireGuard,
        projectContext,
        context,
        get,
        getAgent,
        assertPermission,
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
        "1 memo edit. details truncated.",
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
