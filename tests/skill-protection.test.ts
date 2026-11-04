import "./helpers/storage-env"
import assert from "node:assert/strict"
import { mkdir, rename, rm } from "node:fs/promises"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { getSessionFilePath } from "../lib/paths"
import { Logger } from "../lib/logger"
import { prune } from "../lib/messages/prune"
import {
    createSkillExecuteAfterHandler,
    createSkillExecuteBeforeHandler,
    createUnloadSkillTool,
} from "../lib/skills"
import {
    createSessionState,
    saveSessionStateStrict,
    type SessionState,
    type SkillContext,
    type WithParts,
} from "../lib/state"
import type { CompressionBlock } from "../lib/state/types"
import {
    createHousekeepingHarness,
    stageBlock,
    type HousekeepingHarness,
} from "./helpers/housekeeping"

const sessionID = "ses_skill_protection"

function skillRecord(name: string, overrides: Partial<SkillContext> = {}): SkillContext {
    return {
        name,
        callId: `original-${name}`,
        input: { name, options: { nested: { value: name } } },
        title: `Skill ${name}`,
        output: `output-${name}`,
        metadata: { name, nested: { value: name } },
        ...overrides,
    }
}

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: false,
            customPrompts: false,
        },
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
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
            minCompressTokens: 0,
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
    }
}

function textPart(id: string, text: string, extra: Record<string, unknown> = {}) {
    return {
        id,
        messageID: id,
        sessionID,
        type: "text" as const,
        text,
        ...extra,
    }
}

function userMessage(
    id: string,
    options: {
        empty?: boolean
        ignored?: boolean
        agent?: string
        providerID?: string
        modelID?: string
    } = {},
): WithParts {
    const parts = options.empty
        ? []
        : [textPart(`${id}-part`, `user ${id}`, options.ignored ? { ignored: true } : {})]

    return {
        info: {
            id,
            role: "user",
            sessionID,
            agent: options.agent ?? "assistant",
            model: {
                providerID: options.providerID ?? "test",
                modelID: options.modelID ?? "test",
            },
            time: { created: 1 },
        } as WithParts["info"],
        parts: parts as WithParts["parts"],
    }
}

function assistantMessage(id: string): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID,
            agent: "assistant",
            model: { providerID: "test", modelID: "test" },
            time: { created: 1 },
        } as WithParts["info"],
        parts: [textPart(`${id}-part`, `assistant ${id}`)],
    }
}

function originalSkillMessage(id: string, callID: string, name: string): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID,
            agent: "assistant",
            model: { providerID: "test", modelID: "test" },
            time: { created: 1 },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID,
                type: "tool",
                tool: "skill",
                callID,
                state: {
                    status: "completed",
                    input: { name },
                    output: `native-${name}`,
                    title: `Native ${name}`,
                    metadata: { native: true, name },
                    time: { start: 3, end: 4 },
                },
            } as WithParts["parts"][number],
        ],
    }
}

function makeBlock(overrides: Partial<CompressionBlock>): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: 0,
        durationMs: 0,
        topic: "test",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "anchor",
        compressMessageId: "origin",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "summary",
        summaryVersions: [],
        activeVersionIndex: 1,
        ...overrides,
    }
}

function addSummary(
    state: SessionState,
    blockId: number,
    anchorMessageId: string,
    summary: string,
): void {
    state.prune.messages.blocksById.set(blockId, makeBlock({ blockId, anchorMessageId, summary }))
    state.prune.messages.activeByAnchorMessageId.set(anchorMessageId, blockId)
    state.prune.messages.activeBlockIds.add(blockId)
}

function markPruned(state: SessionState, messageId: string): void {
    state.prune.messages.byMessageId.set(messageId, {
        tokenCount: 1,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
}

function runPrune(state: SessionState, messages: WithParts[]): void {
    prune(state, new Logger(false), buildConfig(), messages)
}

type ToolPart = Extract<WithParts["parts"][number], { type: "tool" }>

function skillParts(messages: WithParts[]): ToolPart[] {
    return messages.flatMap((message) =>
        message.parts.filter(
            (part): part is ToolPart => part.type === "tool" && part.tool === "skill",
        ),
    )
}

function skillNames(parts: ToolPart[]): unknown[] {
    return parts.map((part) =>
        part.state.status === "completed" ? part.state.input.name : undefined,
    )
}

function textSyntheticMessages(messages: WithParts[], text: string): WithParts[] {
    return messages.filter((message) =>
        message.parts.some((part) => part.type === "text" && part.text === text),
    )
}

function skillHandlers(h: HousekeepingHarness) {
    return {
        before: createSkillExecuteBeforeHandler(h.ctx),
        after: createSkillExecuteAfterHandler(h.ctx),
    }
}

function executionContext(h: HousekeepingHarness, callID: string) {
    return {
        sessionID: h.sessionID,
        messageID: `message-${callID}`,
        callID,
        agent: "assistant",
        directory: h.root,
        worktree: h.root,
        abort: new AbortController().signal,
        ask: async () => {},
        metadata(_input: unknown) {},
    }
}

async function seedSkills(
    h: HousekeepingHarness,
    loadedSkills: SkillContext[],
    protectedSkills: SkillContext[],
): Promise<void> {
    h.ctx.state.loadedSkills = structuredClone(loadedSkills)
    h.ctx.state.protectedSkills = structuredClone(protectedSkills)
    await saveSessionStateStrict(h.ctx.state, h.ctx.logger)
}

async function loadSkill(h: HousekeepingHarness, name: string, callID: string): Promise<void> {
    const { before, after } = skillHandlers(h)
    const args = { name }
    const result = {
        title: `Loaded ${name}`,
        output: `native output ${name}`,
        metadata: { name, nested: { value: name } },
    }
    await before({ tool: "skill", sessionID: h.sessionID, callID }, { args })
    await after(
        { tool: "skill", sessionID: h.sessionID, callID, args },
        { title: result.title, output: result.output, metadata: result.metadata },
    )
}

async function unloadSkill(h: HousekeepingHarness, name: string, callID: string): Promise<void> {
    await createUnloadSkillTool(h.ctx).execute({ name } as any, executionContext(h, callID) as any)
}

function injectedSkillParts(messages: WithParts[]): ToolPart[] {
    return skillParts(messages)
}

function injectedSkillNames(messages: WithParts[]): unknown[] {
    return skillNames(injectedSkillParts(messages))
}

test("prune injects only protected skills, in order, when no summary or memo exists", () => {
    const state = createSessionState()
    state.loadedSkills = [skillRecord("loaded-only")]
    state.protectedSkills = [skillRecord("beta"), skillRecord("alpha")]
    const messages: WithParts[] = [userMessage("user-1"), assistantMessage("assistant-1")]

    runPrune(state, messages)

    const injected = injectedSkillParts(messages)
    assert.deepEqual(skillNames(injected), ["beta", "alpha"])
    assert.deepEqual(
        messages.slice(0, 2).flatMap((message) => message.parts),
        injected,
    )
    assert.equal(
        injected.some(
            (part) => part.state.status === "completed" && part.state.input.name === "loaded-only",
        ),
        false,
    )
})

test("prune places protected skill messages after the final active summary and memo", () => {
    const state = createSessionState()
    state.memo = ["Remember skills"]
    state.protectedSkills = [skillRecord("alpha"), skillRecord("beta")]
    const messages: WithParts[] = [
        userMessage("user-1"),
        assistantMessage("assistant-1"),
        assistantMessage("anchor-1"),
        userMessage("user-2"),
        assistantMessage("assistant-2"),
        assistantMessage("anchor-2"),
    ]
    addSummary(state, 1, "anchor-1", "first summary")
    addSummary(state, 2, "anchor-2", "second summary")
    markPruned(state, "anchor-1")
    markPruned(state, "anchor-2")

    runPrune(state, messages)

    const finalSummary = textSyntheticMessages(messages, "second summary")[0]!
    const memo = textSyntheticMessages(messages, "[Memo]\nRemember skills")[0]!
    const injected = injectedSkillParts(messages)
    assert.deepEqual(skillNames(injected), ["alpha", "beta"])
    assert.ok(messages.indexOf(finalSummary) < messages.indexOf(memo))
    const firstIndex = messages.findIndex((message) =>
        message.parts.some((part) => part === injected[0]),
    )
    const secondIndex = messages.findIndex((message) =>
        message.parts.some((part) => part === injected[1]),
    )
    assert.equal(firstIndex, messages.indexOf(memo) + 1)
    assert.equal(secondIndex, messages.indexOf(memo) + 2)
})

test("prune places protected skill messages after the final summary without a memo", () => {
    const state = createSessionState()
    state.protectedSkills = [skillRecord("alpha")]
    const messages: WithParts[] = [
        userMessage("user-1"),
        assistantMessage("anchor-1"),
        assistantMessage("assistant-1"),
    ]
    addSummary(state, 1, "anchor-1", "only summary")
    markPruned(state, "anchor-1")

    runPrune(state, messages)

    const finalSummary = textSyntheticMessages(messages, "only summary")[0]!
    const injected = injectedSkillParts(messages)
    assert.deepEqual(skillNames(injected), ["alpha"])
    assert.equal(
        messages.findIndex((message) => message.parts.some((part) => part === injected[0])),
        messages.indexOf(finalSummary) + 1,
    )
})

test("prune does not inject protected skills without an eligible user message", () => {
    const cases: Array<{ name: string; messages: WithParts[] }> = [
        { name: "no user", messages: [assistantMessage("assistant-1")] },
        {
            name: "ignored user",
            messages: [userMessage("user-ignored", { ignored: true }), assistantMessage("a-1")],
        },
        {
            name: "empty user",
            messages: [userMessage("user-empty", { empty: true }), assistantMessage("a-2")],
        },
    ]

    for (const entry of cases) {
        const state = createSessionState()
        state.protectedSkills = [skillRecord("alpha")]
        const ids = entry.messages.map((message) => message.info.id)

        runPrune(state, entry.messages)

        assert.equal(injectedSkillParts(entry.messages).length, 0, entry.name)
        assert.deepEqual(
            entry.messages.map((message) => message.info.id),
            ids,
            entry.name,
        )
    }
})

test("synthetic skill messages use stable identities and owned SDK assistant tool content", () => {
    const state = createSessionState()
    const alpha = skillRecord("alpha")
    const beta = skillRecord("beta", {
        input: { name: "beta", options: { nested: { value: "beta-argument" } } },
        metadata: { name: "beta", nested: { value: "beta-metadata" } },
    })
    state.protectedSkills = [alpha, beta]
    state.loadedSkills = [skillRecord("unrelated-loaded")]
    const originalCallID = "original-skill-call"
    const raw: WithParts[] = [
        userMessage("user-old", {
            agent: "old-agent",
            providerID: "old-provider",
            modelID: "old-model",
        }),
        assistantMessage("assistant-old"),
        userMessage("user-latest", {
            agent: "latest-agent",
            providerID: "latest-provider",
            modelID: "latest-model",
        }),
        assistantMessage("assistant-latest"),
        originalSkillMessage("original-skill", originalCallID, "raw"),
    ]
    const protectedSnapshot = structuredClone(state.protectedSkills)
    const originalSnapshot = structuredClone(raw[4]!)

    const first = structuredClone(raw)
    runPrune(state, first)
    const firstInjected = injectedSkillParts(first).filter((part) => part.callID !== originalCallID)

    const second = structuredClone(raw)
    runPrune(state, second)
    const secondInjected = injectedSkillParts(second).filter(
        (part) => part.callID !== originalCallID,
    )

    assert.deepEqual(state.protectedSkills, protectedSnapshot)
    assert.equal(firstInjected.length, 2)
    assert.equal(secondInjected.length, 2)
    assert.deepEqual(skillNames(firstInjected), ["alpha", "beta"])

    for (const [index, part] of firstInjected.entries()) {
        const twin = secondInjected[index]!
        const message = first.find((entry) => entry.parts.some((candidate) => candidate === part))!
        const twinMessage = second.find((entry) =>
            entry.parts.some((candidate) => candidate === twin),
        )!
        const info = message.info as any
        const twinInfo = twinMessage.info as any
        const stateRecord = protectedSnapshot[index]!

        assert.equal(info.role, "assistant")
        assert.equal(info.parentID, "user-latest")
        assert.equal(info.providerID, "latest-provider")
        assert.equal(info.modelID, "latest-model")
        assert.equal(info.mode, "latest-agent")
        assert.equal(info.agent, "latest-agent")
        assert.deepEqual(info.path, { cwd: "", root: "" })
        assert.equal(info.cost, 0)
        assert.deepEqual(info.tokens, {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
        })
        assert.equal(info.id, twinInfo.id)
        assert.equal(typeof info.time.created, "number")
        assert.equal(info.time.created, twinInfo.time.created)

        assert.equal(message.parts.length, 1)
        assert.equal(part.id, twin.id)
        assert.equal(part.callID, twin.callID)
        assert.equal(part.callID === originalCallID, false)
        assert.equal(part.messageID, info.id)
        assert.equal(part.sessionID, "ses_skill_protection")
        assert.equal(part.tool, "skill")
        assert.equal(part.state.status, "completed")
        if (part.state.status === "completed" && twin.state.status === "completed") {
            assert.equal(part.state.time.start, twin.state.time.start)
            assert.equal(part.state.time.end, twin.state.time.end)
            assert.deepEqual(part.state.input, stateRecord.input)
            assert.deepEqual(part.state.output, stateRecord.output)
            assert.deepEqual(part.state.title, stateRecord.title)
            assert.deepEqual(part.state.metadata, stateRecord.metadata)
            assert.notEqual(part.state.input, stateRecord.input)
            assert.notEqual(part.state.metadata, stateRecord.metadata)
        }
    }

    assert.notEqual(firstInjected[0]!.callID, firstInjected[1]!.callID)
    assert.deepEqual(
        first.find((entry) => entry.info.id === "original-skill"),
        originalSnapshot,
    )
    assert.equal(
        first
            .flatMap((entry) => entry.parts)
            .some((part) => part.type === "tool" && part.callID === originalCallID),
        true,
    )

    const renderedBeforeMutation = structuredClone(firstInjected[0]!)
    state.protectedSkills[0]!.input.options = { nested: { value: "mutated" } }
    state.protectedSkills[0]!.metadata.nested = { value: "mutated" }
    assert.deepEqual(firstInjected[0], renderedBeforeMutation)
})

test("entry guidance lists loaded skill names and explicitly lists none", async (t) => {
    const withSkills = await createHousekeepingHarness(t)
    await seedSkills(withSkills, [skillRecord("alpha"), skillRecord("beta")], [])
    const guidance = await withSkills.enter()
    assert.match(guidance, /loaded\s+skills?/i)
    assert.match(guidance, /alpha/)
    assert.match(guidance, /beta/)
    await withSkills.leave({ force: true })

    const withoutSkills = await createHousekeepingHarness(t)
    const emptyGuidance = await withoutSkills.enter()
    assert.match(
        emptyGuidance,
        /loaded\s+skills?[^\n]*(?:none|no\b)|(?:none|no)\s+loaded\s+skills?/i,
    )
    await withoutSkills.leave({ force: true })
})

test("entry retry retains its saved loaded-skill guidance", async (t) => {
    const h = await createHousekeepingHarness(t)
    await seedSkills(h, [skillRecord("alpha")], [])
    const identity = { messageID: "entry-message", callID: "entry-retry" }

    const first = await h.run("enter_housekeeping", {}, identity)
    assert.match(first, /alpha/)

    await seedSkills(h, [skillRecord("beta")], h.ctx.state.protectedSkills)
    const retry = await h.run("enter_housekeeping", {}, identity)

    assert.equal(retry, first)
    assert.doesNotMatch(retry, /\bbeta\b/)
    await h.leave({ force: true })
})

test("skill changes during housekeeping are immediate while protected injection stays frozen until leave", async (t) => {
    const h = await createHousekeepingHarness(t)
    const committed = skillRecord("alpha", { output: "committed alpha output" })
    await seedSkills(h, [skillRecord("alpha")], [committed])

    await h.enter()
    await loadSkill(h, "beta", "load-beta")
    await unloadSkill(h, "alpha", "unload-alpha")

    assert.deepEqual(
        h.ctx.state.loadedSkills.map((record) => record.name),
        ["beta"],
    )
    assert.deepEqual(
        h.ctx.state.protectedSkills.map((record) => record.name),
        ["alpha"],
    )
    const during = await h.render()
    assert.deepEqual(injectedSkillNames(during), ["alpha"])

    await assert.rejects(h.leave(), /No compression|force=true|qualifying/i)
    await h.leave({ force: true })

    assert.deepEqual(h.ctx.state.protectedSkills, h.ctx.state.loadedSkills)
    assert.notEqual(h.ctx.state.protectedSkills, h.ctx.state.loadedSkills)
    assert.notEqual(h.ctx.state.protectedSkills[0], h.ctx.state.loadedSkills[0])
    assert.notEqual(h.ctx.state.protectedSkills[0]!.input, h.ctx.state.loadedSkills[0]!.input)
    assert.notEqual(h.ctx.state.protectedSkills[0]!.metadata, h.ctx.state.loadedSkills[0]!.metadata)

    const after = await h.render()
    assert.deepEqual(injectedSkillNames(after), ["beta"])

    h.ctx.state.loadedSkills[0]!.input.options = { nested: { value: "mutated" } }
    h.ctx.state.loadedSkills[0]!.metadata.nested = { value: "mutated" }
    assert.equal(h.ctx.state.protectedSkills[0]!.output, "native output beta")

    await h.restart()
    assert.deepEqual(
        h.ctx.state.loadedSkills.map((record) => record.name),
        ["beta"],
    )
    assert.deepEqual(
        h.ctx.state.protectedSkills.map((record) => record.name),
        ["beta"],
    )
})

test("successful leave publishes loaded skills as protected context and persists it", async (t) => {
    const h = await createHousekeepingHarness(t)
    await seedSkills(h, [skillRecord("alpha")], [])

    await h.enter()
    await stageBlock(h, "Skills summary.")
    await loadSkill(h, "beta", "load-beta")
    await h.leave()

    assert.deepEqual(
        h.ctx.state.protectedSkills.map((record) => record.name),
        ["alpha", "beta"],
    )
    const injected = await h.render()
    assert.deepEqual(injectedSkillNames(injected), ["alpha", "beta"])

    await h.restart()
    assert.deepEqual(
        h.ctx.state.protectedSkills.map((record) => record.name),
        ["alpha", "beta"],
    )
    assert.deepEqual(injectedSkillNames(await h.render()), ["alpha", "beta"])
})

test("failed leave publication preserves protected and loaded skill lists", async (t) => {
    const h = await createHousekeepingHarness(t)
    await seedSkills(h, [skillRecord("alpha")], [skillRecord("committed")])
    await h.enter()
    await stageBlock(h, "Skills summary.")
    await loadSkill(h, "beta", "load-beta")

    const file = getSessionFilePath(h.sessionID)
    const backup = `${file}.skill-protection-backup`
    await rename(file, backup)
    await mkdir(file)
    try {
        await assert.rejects(h.leave(), /persist|write|directory|EISDIR|EEXIST|rename/i)
        assert.deepEqual(
            h.ctx.state.loadedSkills.map((record) => record.name),
            ["alpha", "beta"],
        )
        assert.deepEqual(
            h.ctx.state.protectedSkills.map((record) => record.name),
            ["committed"],
        )
        assert.deepEqual(injectedSkillNames(await h.render()), ["committed"])
    } finally {
        await rm(file, { recursive: true, force: true })
        await rename(backup, file)
    }

    await h.leave()
    assert.deepEqual(
        h.ctx.state.protectedSkills.map((record) => record.name),
        ["alpha", "beta"],
    )
    await h.restart()
    assert.deepEqual(
        h.ctx.state.protectedSkills.map((record) => record.name),
        ["alpha", "beta"],
    )
})

test("mid-housekeeping cut rolls protected skills back without rolling loaded skills back", async (t) => {
    const h = await createHousekeepingHarness(t)
    await seedSkills(h, [], [])

    await h.run("enter_housekeeping", {}, { callID: "first-enter" })
    await loadSkill(h, "alpha", "load-alpha")
    await h.run("leave_housekeeping", { force: true }, { callID: "first-leave" })

    await h.run("enter_housekeeping", {}, { callID: "second-enter" })
    await loadSkill(h, "beta", "load-beta")
    await h.run("leave_housekeeping", { force: true }, { callID: "second-leave" })
    const completed = structuredClone(h.history)

    assert.deepEqual(
        h.ctx.state.protectedSkills.map((record) => record.name),
        ["alpha", "beta"],
    )
    h.setHistory(
        completed.map((message) => ({
            ...message,
            parts: message.parts.filter(
                (part) => part.type !== "tool" || part.callID !== "second-leave",
            ),
        })),
    )

    const reverted = await h.render()

    assert.deepEqual(
        h.ctx.state.protectedSkills.map((record) => record.name),
        ["alpha"],
    )
    assert.deepEqual(
        h.ctx.state.loadedSkills.map((record) => record.name),
        ["alpha", "beta"],
    )
    assert.deepEqual(injectedSkillNames(reverted), ["alpha"])

    h.setHistory(completed)
    const restored = await h.render()
    assert.deepEqual(
        h.ctx.state.protectedSkills.map((record) => record.name),
        ["alpha", "beta"],
    )
    assert.deepEqual(
        h.ctx.state.loadedSkills.map((record) => record.name),
        ["alpha", "beta"],
    )
    assert.deepEqual(injectedSkillNames(restored), ["alpha", "beta"])
})

test("before-entry cut rolls protected skills back and restoration republishes without loaded rollback", async (t) => {
    const h = await createHousekeepingHarness(t)
    await seedSkills(h, [], [])

    await h.run("enter_housekeeping", {}, { callID: "first-enter" })
    await loadSkill(h, "alpha", "load-alpha")
    await h.run("leave_housekeeping", { force: true }, { callID: "first-leave" })

    await h.run("enter_housekeeping", {}, { callID: "second-enter" })
    await loadSkill(h, "beta", "load-beta")
    await h.run("leave_housekeeping", { force: true }, { callID: "second-leave" })
    const completed = structuredClone(h.history)

    h.setHistory(
        completed.map((message) => ({
            ...message,
            parts: message.parts.filter(
                (part) =>
                    part.type !== "tool" ||
                    (part.callID !== "second-enter" && part.callID !== "second-leave"),
            ),
        })),
    )
    const reverted = await h.render()

    assert.deepEqual(
        h.ctx.state.protectedSkills.map((record) => record.name),
        ["alpha"],
    )
    assert.deepEqual(
        h.ctx.state.loadedSkills.map((record) => record.name),
        ["alpha", "beta"],
    )
    assert.deepEqual(injectedSkillNames(reverted), ["alpha"])

    h.setHistory(completed)
    const restored = await h.render()
    assert.deepEqual(
        h.ctx.state.protectedSkills.map((record) => record.name),
        ["alpha", "beta"],
    )
    assert.deepEqual(
        h.ctx.state.loadedSkills.map((record) => record.name),
        ["alpha", "beta"],
    )
    assert.deepEqual(injectedSkillNames(restored), ["alpha", "beta"])
})

test("conditional delta merge preserves unrelated protected skill changes", async (t) => {
    const h = await createHousekeepingHarness(t)
    await seedSkills(h, [], [])

    await h.run("enter_housekeeping", {}, { callID: "first-enter" })
    await loadSkill(h, "alpha", "load-alpha")
    await h.run("leave_housekeeping", { force: true }, { callID: "first-leave" })

    await h.run("enter_housekeeping", {}, { callID: "second-enter" })
    await loadSkill(h, "beta", "load-beta")
    await h.run("leave_housekeeping", { force: true }, { callID: "second-leave" })
    const completed = structuredClone(h.history)

    h.setHistory(
        completed.map((message) => ({
            ...message,
            parts: message.parts.filter(
                (part) => part.type !== "tool" || part.callID !== "first-leave",
            ),
        })),
    )
    const reverted = await h.render()

    assert.deepEqual(
        h.ctx.state.protectedSkills.map((record) => record.name),
        ["alpha", "beta"],
    )
    assert.deepEqual(
        h.ctx.state.loadedSkills.map((record) => record.name),
        ["alpha", "beta"],
    )
    assert.deepEqual(injectedSkillNames(reverted), ["alpha", "beta"])

    h.setHistory(completed)
    const restored = await h.render()
    assert.deepEqual(
        h.ctx.state.protectedSkills.map((record) => record.name),
        ["alpha", "beta"],
    )
    assert.deepEqual(
        h.ctx.state.loadedSkills.map((record) => record.name),
        ["alpha", "beta"],
    )
    assert.deepEqual(injectedSkillNames(restored), ["alpha", "beta"])
})
