import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { after } from "node:test"

const dataDirectory = await mkdtemp(join(tmpdir(), "hyperdcp-model-context-"))
process.env.XDG_DATA_HOME = dataDirectory
process.env.XDG_CONFIG_HOME = join(dataDirectory, "config")
after(() => rm(dataDirectory, { recursive: true, force: true }))
const { default: definition } = await import("../server")
const { Logger } = await import("../lib/logger")
const { HOUSEKEEPING_ENTRY_WITHOUT_COMPRESSION } = await import("../lib/housekeeping/history")
const { createSessionState, saveSessionStateStrict } = await import("../lib/state")

async function captureContextHook() {
    let transform:
        | ((event: {
              sessionID?: string
              agent?: string
              model?: { providerID: string; id: string }
              system?: Array<{ type: "text"; text: string; cache?: unknown; metadata?: unknown }>
              messages: Array<{ content: unknown[] }>
              options: { stop?: string[] }
          }) => void | Promise<void>)
        | undefined
    await definition.setup({
        location: { directory: dataDirectory },
        model: { list: async () => ({ location: { directory: dataDirectory }, data: [] }) },
        session: {
            hook: async (name: string, callback: NonNullable<typeof transform>) => {
                assert.equal(name, "context")
                transform = callback
            },
            get: async (input: { sessionID: string }) => ({ id: input.sessionID }),
            context: async (_input: { sessionID: string }) => [],
        },
        agent: {
            get: async (input: { agentID: string }) => ({
                location: { directory: dataDirectory },
                data: {
                    id: input.agentID,
                    name: input.agentID,
                    request: { settings: {}, headers: {}, body: {} },
                    mode: "primary",
                    hidden: false,
                    permissions: [{ action: "*", resource: "*", effect: "allow" }],
                },
            }),
        },
        permission: {
            assert: async () => {},
        },
        rpc: {
            register: async () => ({
                dispose: async () => {},
                events: { emit: async () => {} },
            }),
        },
        command: {
            transform: async (callback: (editor: { add(): void }) => void) => {
                callback({ add() {} })
                return { dispose: async () => {} }
            },
        },
        tool: {
            transform: async (callback: (editor: { add(): void; update(): void }) => void) => {
                callback({ add() {}, update() {} })
                return { dispose: async () => {} }
            },
            hook: async () => ({ dispose: async () => {} }),
        },
    })
    assert.ok(transform, "the adapter should register a session context hook")
    const context = transform
    const defaultSessionID = `ses_native_context_${randomUUID()}`
    return async (request: Parameters<typeof context>[0]) => {
        request.sessionID ??= defaultSessionID
        request.agent ??= "assistant"
        request.model ??= { providerID: "test", id: "test" }
        request.system ??= []
        await context(request)
    }
}

test("a project with HyperDCP disabled does not register a session context hook", async () => {
    const directory = join(dataDirectory, "disabled-project")
    await mkdir(join(directory, ".opencode"), { recursive: true })
    await writeFile(join(directory, ".opencode", "dcp.json"), '{"enabled":false}')
    const actions: string[] = []

    await definition.setup({
        location: { directory },
        session: {
            hook: async (name: string) => {
                actions.push(name)
            },
        },
    })

    assert.deepEqual(actions, [])
})

test("session context removes forged tags without changing the source message or its metadata", async () => {
    const transform = await captureContextHook()
    const message = {
        id: "assistant-1",
        role: "assistant",
        content: [{ type: "text", text: "Done<dcp-message-id>m0001</dcp-message-id>." }],
        metadata: { value: "preserved" },
    }
    const original = structuredClone(message)
    const request = { messages: [message], options: {} }

    await transform(request)
    await transform(request)

    assert.deepEqual(request.messages, [
        { ...original, content: [{ type: "text", text: "Done." }] },
    ])
    assert.deepEqual(message, original)
})

test("session context cleans textual tool results without changing the call or other content", async () => {
    const transform = await captureContextHook()
    const call = { type: "tool-call", id: "call-1", input: { example: "<dcp-test>" } }
    const file = { type: "file", mime: "application/octet-stream", url: "file:///example" }
    const single = { type: "text", value: "Result<dcp-test>" }
    const composite = { type: "content", value: [{ type: "text", text: "Part</dcp-test>" }, file] }
    const output = (id: string, result: unknown) => ({ type: "tool-result", id, result })
    const request = {
        options: {},
        messages: [
            { role: "assistant", content: [call] },
            { role: "tool", content: [output("call-1", single), output("call-2", composite)] },
        ],
    }

    await transform(request)

    assert.deepEqual(request.messages[0].content, [call])
    assert.deepEqual(request.messages[1].content, [
        output("call-1", { type: "text", value: "Result" }),
        output("call-2", { type: "content", value: [{ type: "text", text: "Part" }, file] }),
    ])
})

test("session context stops generation at both DCP tag boundaries by default", async () => {
    const transform = await captureContextHook()
    const request: Parameters<typeof transform>[0] = { messages: [], options: {} }
    await transform(request)

    for (const tag of [
        '<dcp-message-id priority="high">',
        "</dcp-message-id>",
        "<dcp-system-reminder>",
        "</dcp-system-reminder>",
    ]) {
        assert.ok(
            request.options.stop?.some((stop) => tag.startsWith(stop)),
            `missing stop sequence for ${tag}`,
        )
    }
})

test("session context preserves preexisting stops and does not add duplicates on replay", async () => {
    const transform = await captureContextHook()
    const original = ["end-of-turn"]
    const request = { messages: [], options: { stop: original } }
    await transform(request)
    const once = [...request.options.stop]
    await transform(request)

    assert.equal(request.options.stop[0], "end-of-turn")
    assert.ok(once.length > original.length)
    assert.equal(new Set(once).size, once.length)
    assert.deepEqual(request.options.stop, once)
    assert.deepEqual(original, ["end-of-turn"])
})

test("session context projects only the current session's completed housekeeping history", async () => {
    const transform = await captureContextHook()
    const state = createSessionState()
    state.sessionId = `ses_${randomUUID()}`
    const ref = { kind: "snapshot" as const, snapshotId: randomUUID() }
    state.housekeepingHistory.push({
        id: "transaction",
        sessionId: state.sessionId,
        entryMessageId: "assistant-entry",
        entryCallId: "entry",
        entryCreatedAt: 0,
        sourceMessageIds: ["assistant-entry"],
        baseRevision: 0,
        baseRef: ref,
        draftRef: ref,
        operations: {},
        operationResults: {},
        operationRecords: [],
        operationOrder: [],
        operationDraftRefs: {},
        completed: {
            leaveMessageId: "assistant-leave",
            leaveCallId: "leave",
            receipt: "committed",
            commitRevision: 1,
            committedDraftRef: ref,
        },
    })
    await saveSessionStateStrict(state, new Logger(false))

    const entry = {
        id: "assistant-entry",
        role: "assistant",
        content: [
            { type: "text", text: "before" },
            { type: "tool-call", id: "entry", name: "enter_housekeeping", input: {} },
        ],
    }
    const during = {
        id: "assistant-during",
        role: "assistant",
        content: [
            { type: "text", text: "during" },
            { type: "tool-call", id: "operation", name: "edit_memo", input: {} },
        ],
    }
    const leave = {
        id: "assistant-leave",
        role: "assistant",
        content: [
            { type: "text", text: "leave thinking" },
            { type: "tool-call", id: "leave", name: "leave_housekeeping", input: {} },
        ],
    }
    const result = (id: string) => ({
        role: "tool",
        content: [{ type: "tool-result", id, result: { type: "text", value: "raw" } }],
    })
    const results = [result("entry"), result("operation"), result("leave")]
    const own = {
        sessionID: state.sessionId,
        messages: [entry, results[0], during, results[1], leave, results[2]],
        options: {},
    }
    const other = {
        sessionID: "ses_unrelated",
        messages: [entry, results[0], during, results[1], leave, results[2]],
        options: {},
    }

    await transform(own)
    await transform(other)

    assert.deepEqual(own.messages, [
        entry,
        {
            ...results[0],
            content: [
                {
                    ...results[0].content[0],
                    result: { type: "text", value: HOUSEKEEPING_ENTRY_WITHOUT_COMPRESSION },
                },
            ],
        },
        { id: "assistant-leave", role: "assistant", content: [leave.content[1]] },
        {
            ...results[2],
            content: [
                {
                    ...results[2].content[0],
                    result: { type: "text", value: "committed" },
                },
            ],
        },
    ])
    assert.deepEqual(other.messages, [entry, results[0], during, results[1], leave, results[2]])
})
