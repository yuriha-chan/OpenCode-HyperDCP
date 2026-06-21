import assert from "node:assert/strict"
import test from "node:test"
import { truncateToolOutputs } from "../lib/messages/truncate-tools"
import type { PluginConfig } from "../lib/config"
import type { WithParts } from "../lib/state"

function buildConfig(maxToolOutputChars: number): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            minCompressTokens: 0,
            maxToolOutputChars,
            summaryBuffer: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}

function buildMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                {
                    id: "part-1",
                    messageID: "msg-1",
                    sessionID,
                    type: "tool" as const,
                    tool: "read",
                    callID: "call-1",
                    state: {
                        status: "completed" as const,
                        input: { filePath: "/f" },
                        output: "short output",
                    },
                },
            ],
        },
        {
            info: {
                id: "msg-2",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                {
                    id: "part-2",
                    messageID: "msg-2",
                    sessionID,
                    type: "tool" as const,
                    tool: "bash",
                    callID: "call-2",
                    state: {
                        status: "completed" as const,
                        input: { command: "cat" },
                        output: "A".repeat(200) + "\n" + "B".repeat(200),
                    },
                },
            ],
        },
    ]
}

test("truncateToolOutputs skips outputs under threshold", () => {
    const config = buildConfig(500)
    const messages = buildMessages("s1")
    const count = truncateToolOutputs(config, messages)
    assert.equal(count, 0)
    const parts = messages[1]?.parts || []
    const out = (parts[0] as any)?.state?.output || ""
    assert.match(out, /A+/, "short output unchanged")
})

test("truncateToolOutputs replaces output over threshold with summary", () => {
    const config = buildConfig(100)
    const messages = buildMessages("s1")
    const count = truncateToolOutputs(config, messages)
    assert.equal(count, 1)

    const parts = messages[1]?.parts || []
    const out = (parts[0] as any)?.state?.output || ""
    assert.match(out, /truncated/i, "summary should indicate truncation")
    assert.match(out, /bytes/, "should mention bytes")
    assert.match(out, /lines/, "should mention lines")
    assert.match(out, /A+/, "should include head content")
    assert.match(out, /B+/, "should include tail content")
})

test("truncateToolOutputs handles single long line", () => {
    const config = buildConfig(100)
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-1",
                role: "assistant",
                sessionID: "s1",
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                {
                    id: "part-1",
                    messageID: "msg-1",
                    sessionID: "s1",
                    type: "tool" as const,
                    tool: "bash",
                    callID: "call-1",
                    state: {
                        status: "completed" as const,
                        input: { command: "cat" },
                        output: "X".repeat(600),
                    },
                },
            ],
        },
    ]
    const count = truncateToolOutputs(config, messages)
    assert.equal(count, 1)

    const out = (messages[0]?.parts[0] as any)?.state?.output || ""
    assert.match(out, /single line/i, "should mention single line")
})

test("truncateToolOutputs skips non-completed tools", () => {
    const config = buildConfig(100)
    const messages: WithParts[] = [
        {
            info: {
                id: "msg-1",
                role: "assistant",
                sessionID: "s1",
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                {
                    id: "p1",
                    messageID: "msg-1",
                    sessionID: "s1",
                    type: "tool" as const,
                    tool: "bash",
                    callID: "call-1",
                    state: { status: "pending" as const, input: {} },
                },
                {
                    id: "p2",
                    messageID: "msg-1",
                    sessionID: "s1",
                    type: "tool" as const,
                    tool: "bash",
                    callID: "call-2",
                    state: { status: "running" as const, input: {} },
                },
            ],
        },
    ]
    const count = truncateToolOutputs(config, messages)
    assert.equal(count, 0)
})

test("truncateToolOutputs disabled when maxToolOutputChars is 0", () => {
    const config = buildConfig(0)
    const messages = buildMessages("s1")
    messages[1]!.parts[0]!.state = {
        status: "completed" as const,
        input: {},
        output: "A".repeat(1000),
    }
    const count = truncateToolOutputs(config, messages)
    assert.equal(count, 0)
})
