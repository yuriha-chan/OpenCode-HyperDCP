import assert from "node:assert/strict"
import test from "node:test"
import { createV1TuiTransport, createV2TuiTransport } from "../src/tui-client"

type Call = Record<string, unknown>

test("v1 transport sends the legacy command payload and preserves legacy message mapping", async () => {
    const commandCalls: Call[] = []
    const messageCalls: Call[] = []
    const client = {
        session: {
            command: async (input: Call) => {
                commandCalls.push(input)
            },
            messages: async (input: Call) => {
                messageCalls.push(input)
                return {
                    data: [
                        {
                            info: { id: "msg_user", role: "user" },
                            parts: [{ type: "text", text: "hello" }],
                        },
                        {
                            info: { id: "msg_assistant", role: "assistant" },
                            parts: [{ type: "tool", tool: "read", state: { input: { filePath: "a.ts" } } }],
                        },
                    ],
                }
            },
        },
    }

    const transport = createV1TuiTransport(client)

    await transport.sendEditCommand("session-v1", "stats")
    assert.deepEqual(commandCalls, [{ sessionID: "session-v1", command: "dcp", arguments: "stats" }])

    const entries = await transport.readSessionMessages("session-v1")
    assert.deepEqual(messageCalls, [{ sessionID: "session-v1" }])
    assert.deepEqual(entries, [
        {
            id: "msg_user",
            type: "user",
            content: [{ type: "text", text: "hello" }],
        },
        {
            id: "msg_assistant",
            type: "assistant",
            content: [{ type: "tool", tool: "read", state: { input: { filePath: "a.ts" } } }],
        },
    ])
})

test("v2 transport sends the native command payload", async () => {
    const commandCalls: Call[] = []
    const client = {
        session: {
            command: async (input: Call) => {
                commandCalls.push(input)
            },
        },
    }

    const transport = createV2TuiTransport(client)

    await transport.sendEditCommand("session-v2", "compress 2 3")
    assert.deepEqual(commandCalls, [{ sessionID: "session-v2", name: "dcp", text: "compress 2 3" }])
})

test("v2 transport reads every message page in order and maps native fields", async () => {
    const listCalls: Call[] = []
    const client = {
        message: {
            list: async (input: Call) => {
                listCalls.push(input)
                if (input.cursor === undefined) {
                    return {
                        data: [
                            { id: "msg_user", type: "user", text: "user text" },
                            {
                                id: "msg_assistant",
                                type: "assistant",
                                content: [
                                    { type: "text", text: "assistant text" },
                                    { type: "tool", id: "part_tool", name: "read", state: { input: { filePath: "a.ts" } } },
                                ],
                            },
                        ],
                        cursor: { next: "cursor-2" },
                    }
                }
                if (input.cursor === "cursor-2") {
                    return {
                        data: [
                            { id: "msg_synthetic", type: "synthetic", text: "synthetic report" },
                            { id: "msg_shell", type: "shell", command: "pwd", output: "shell output" },
                        ],
                        cursor: {},
                    }
                }
                throw new Error(`unexpected cursor: ${String(input.cursor)}`)
            },
        },
    }

    const transport = createV2TuiTransport(client)
    const entries = await transport.readSessionMessages("session-v2")

    assert.deepEqual(listCalls, [
        { sessionID: "session-v2", limit: 200, order: "asc" },
        { sessionID: "session-v2", limit: 200, cursor: "cursor-2" },
    ])
    assert.deepEqual(
        entries.map((entry) => entry.id),
        ["msg_user", "msg_assistant", "msg_synthetic", "msg_shell"],
    )
    assert.deepEqual(
        entries.map((entry) => entry.type),
        ["user", "assistant", "synthetic", "shell"],
    )
    assert.equal(entries[0].text, "user text")
    assert.deepEqual(entries[1].content?.[0], { type: "text", text: "assistant text" })
    const toolPart = entries[1].content?.find(
        (part) => typeof part === "object" && part !== null && (part as { type?: string }).type === "tool",
    ) as { tool?: string } | undefined
    assert.equal(toolPart?.tool, "read")
    assert.equal(entries[2].text, "synthetic report")
    assert.equal(entries[3].output, "shell output")
})

test("v2 transport propagates message list failures", async () => {
    const failure = new Error("message list failed")
    const client = {
        message: {
            list: async () => {
                throw failure
            },
        },
    }

    const transport = createV2TuiTransport(client)

    await assert.rejects(transport.readSessionMessages("session-v2"), (error) => {
        assert.equal(error, failure)
        return true
    })
})
