import "./helpers/storage-env"
import assert from "node:assert/strict"
import { chmod, readFile, stat } from "node:fs/promises"
import test from "node:test"
import { tool } from "@opencode-ai/plugin"
import { getSessionFilePath, STORAGE_DIR } from "../lib/paths"
import {
    createSkillExecuteAfterHandler,
    createSkillExecuteBeforeHandler,
    createSkillToolDefinitionHandler,
    createUnloadSkillTool,
} from "../lib/skills"
import { saveSessionStateStrict, type SkillContext } from "../lib/state"
import { createHousekeepingHarness, type HousekeepingHarness } from "./helpers/housekeeping"

function skillRecord(name: string, overrides: Partial<SkillContext> = {}): SkillContext {
    return {
        name,
        callId: `call-${name}`,
        input: { name, options: { language: "ts" } },
        title: `Skill ${name}`,
        output: `output-${name}`,
        metadata: { name, nested: { value: name } },
        ...overrides,
    }
}

function nativeResult(name: string, output = `Loaded ${name}`) {
    return {
        title: `Load ${name}`,
        output,
        metadata: { name, dir: `/skills/${name}`, nested: { value: "native" } },
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

async function readPersistedSkills(
    h: HousekeepingHarness,
): Promise<{ loadedSkills: SkillContext[]; protectedSkills: SkillContext[] }> {
    const payload = JSON.parse(await readFile(getSessionFilePath(h.sessionID), "utf-8")) as {
        loadedSkills?: SkillContext[]
        protectedSkills?: SkillContext[]
    }
    return {
        loadedSkills: payload.loadedSkills ?? [],
        protectedSkills: payload.protectedSkills ?? [],
    }
}

async function withReadOnlyStorage<T>(operation: () => Promise<T>): Promise<T> {
    const originalMode = (await stat(STORAGE_DIR)).mode & 0o777
    await chmod(STORAGE_DIR, 0o555)
    try {
        return await operation()
    } finally {
        await chmod(STORAGE_DIR, originalMode)
    }
}

function definitions(h: HousekeepingHarness) {
    return {
        before: createSkillExecuteBeforeHandler(h.ctx),
        after: createSkillExecuteAfterHandler(h.ctx),
    }
}

test("skill definition handler advertises force without altering native parameters or unrelated tools", async (t) => {
    const h = await createHousekeepingHarness(t)
    const handler = createSkillToolDefinitionHandler(h.ctx)
    const parameters = { native: { marker: "zod-parameters" } }
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

    await handler({ toolID: "skill" }, output)

    assert.equal(output.description, "Load a native skill")
    assert.equal(output.parameters, parameters)
    assert.equal(output.jsonSchema.properties.name?.type, "string")
    assert.equal(output.jsonSchema.properties.force?.type, "boolean")
    assert.equal(output.jsonSchema.required.includes("name"), true)
    assert.equal(output.jsonSchema.required.includes("force"), false)

    const nativeOutput: any = { description: "Native skill", parameters }
    await handler({ toolID: "skill" }, nativeOutput)
    assert.equal(nativeOutput.parameters, parameters)
    assert.equal(nativeOutput.description, "Native skill")
    assert.equal(nativeOutput.jsonSchema.properties.name?.type, "string")
    assert.equal(nativeOutput.jsonSchema.properties.force?.type, "boolean")

    const readOutput: any = {
        description: "Read a file",
        parameters: { read: true },
        jsonSchema: { type: "object", properties: { path: { type: "string" } } },
    }
    const snapshot = structuredClone(readOutput)
    await handler({ toolID: "read" }, readOutput)
    assert.deepEqual(readOutput, snapshot)
})

test("successful native skill load publishes one owned record and survives restart", async (t) => {
    const h = await createHousekeepingHarness(t)
    const protectedRecord = skillRecord("protected")
    await seedSkills(h, [], [protectedRecord])
    const { before, after } = definitions(h)
    const args = { name: "demo" }
    const result = nativeResult("demo", "Native skill body")
    let nativeCalls = 0
    const contentRevisionBefore = h.ctx.state.contentRevision
    const revisionBefore = h.ctx.state.revision

    await before({ tool: "skill", sessionID: h.sessionID, callID: "load-demo" }, { args })
    assert.deepEqual(h.ctx.state.loadedSkills, [])
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])

    const native = async (received: any) => {
        nativeCalls += 1
        assert.deepEqual(received, args)
        return result
    }
    const returned = await native(args)
    assert.equal(nativeCalls, 1)
    await after(
        { tool: "skill", sessionID: h.sessionID, callID: "load-demo", args },
        { title: returned.title, output: returned.output, metadata: returned.metadata },
    )

    const record = h.ctx.state.loadedSkills[0]!
    assert.equal(h.ctx.state.loadedSkills.length, 1)
    assert.deepEqual(record, {
        name: "demo",
        callId: "load-demo",
        input: { name: "demo" },
        title: "Load demo",
        output: "Native skill body",
        metadata: { name: "demo", dir: "/skills/demo", nested: { value: "native" } },
    })
    assert.notEqual(record.input, args)
    assert.notEqual(record.metadata, result.metadata)
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])
    assert.equal(h.ctx.state.contentRevision, contentRevisionBefore)
    assert.ok(h.ctx.state.revision > revisionBefore)

    args.name = "mutated"
    result.metadata.nested.value = "mutated"
    assert.deepEqual(h.ctx.state.loadedSkills[0]!.input, { name: "demo" })
    assert.deepEqual(h.ctx.state.loadedSkills[0]!.metadata, {
        name: "demo",
        dir: "/skills/demo",
        nested: { value: "native" },
    })

    await h.restart()
    assert.deepEqual(h.ctx.state.loadedSkills, [record])
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])
})

test("duplicate native skill load rejects before invoking the native runner", async (t) => {
    const h = await createHousekeepingHarness(t)
    const loaded = skillRecord("demo")
    const protectedRecord = skillRecord("protected")
    await seedSkills(h, [loaded], [protectedRecord])
    const { before, after } = definitions(h)
    let nativeCalls = 0
    const native = async () => {
        nativeCalls += 1
        return nativeResult("demo")
    }
    const runNative = async (callID: string, args: { name: string; force?: boolean }) => {
        await before({ tool: "skill", sessionID: h.sessionID, callID }, { args })
        const result = await native()
        await after({ tool: "skill", sessionID: h.sessionID, callID, args }, result)
    }

    await assert.rejects(runNative("duplicate", { name: "demo" }), /already|loaded|force/i)
    await assert.rejects(
        runNative("duplicate-false", { name: "demo", force: false }),
        /already|loaded|force/i,
    )

    assert.equal(nativeCalls, 0)
    assert.deepEqual(h.ctx.state.loadedSkills, [loaded])
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])
    const persisted = await readPersistedSkills(h)
    assert.deepEqual(persisted.loadedSkills, [loaded])
    assert.deepEqual(persisted.protectedSkills, [protectedRecord])
})

test("forced reload removes the previous record before native execution and publishes the replacement", async (t) => {
    const h = await createHousekeepingHarness(t)
    const existing = skillRecord("demo", { output: "old output" })
    const other = skillRecord("other")
    const protectedRecord = skillRecord("protected")
    await seedSkills(h, [existing, other], [protectedRecord])
    const { before, after } = definitions(h)
    const args = { name: "demo", force: true }
    const result = nativeResult("demo", "forced output")
    let nativeCalls = 0

    await before({ tool: "skill", sessionID: h.sessionID, callID: "force-demo" }, { args })
    assert.deepEqual(h.ctx.state.loadedSkills, [other])
    const persistedBeforeNative = await readPersistedSkills(h)
    assert.deepEqual(persistedBeforeNative.loadedSkills, [other])

    const native = async () => {
        nativeCalls += 1
        assert.deepEqual(h.ctx.state.loadedSkills, [other])
        return result
    }
    const returned = await native()
    assert.equal(nativeCalls, 1)
    await after(
        { tool: "skill", sessionID: h.sessionID, callID: "force-demo", args },
        { title: returned.title, output: returned.output, metadata: returned.metadata },
    )

    assert.deepEqual(
        h.ctx.state.loadedSkills.map((record) => record.name),
        ["other", "demo"],
    )
    assert.equal(h.ctx.state.loadedSkills.filter((record) => record.name === "demo").length, 1)
    assert.equal(h.ctx.state.loadedSkills[1]!.output, "forced output")
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])

    await h.restart()
    assert.deepEqual(
        h.ctx.state.loadedSkills.map((record) => record.name),
        ["other", "demo"],
    )
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])
})

test("failed fresh native load never marks the skill loaded", async (t) => {
    const h = await createHousekeepingHarness(t)
    const protectedRecord = skillRecord("protected")
    await seedSkills(h, [], [protectedRecord])
    const { before } = definitions(h)
    let nativeCalls = 0

    await before(
        { tool: "skill", sessionID: h.sessionID, callID: "fresh-failure" },
        { args: { name: "fragile" } },
    )
    assert.deepEqual(h.ctx.state.loadedSkills, [])

    await assert.rejects(async () => {
        nativeCalls += 1
        throw new Error("native skill failed")
    }, /native skill failed/)

    assert.equal(nativeCalls, 1)
    assert.deepEqual(h.ctx.state.loadedSkills, [])
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])

    await h.restart()
    assert.deepEqual(h.ctx.state.loadedSkills, [])
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])
})

test("failed forced native load leaves the skill unloaded in memory and on disk", async (t) => {
    const h = await createHousekeepingHarness(t)
    const existing = skillRecord("demo", { output: "old output" })
    const other = skillRecord("other")
    const protectedRecord = skillRecord("protected")
    await seedSkills(h, [existing, other], [protectedRecord])
    const { before } = definitions(h)
    const args = { name: "demo", force: true }
    let nativeCalls = 0

    await before({ tool: "skill", sessionID: h.sessionID, callID: "force-failure" }, { args })
    assert.deepEqual(h.ctx.state.loadedSkills, [other])
    const persistedBeforeNative = await readPersistedSkills(h)
    assert.deepEqual(persistedBeforeNative.loadedSkills, [other])

    await assert.rejects(async () => {
        nativeCalls += 1
        throw new Error("native skill failed")
    }, /native skill failed/)

    assert.equal(nativeCalls, 1)
    assert.deepEqual(h.ctx.state.loadedSkills, [other])
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])

    await h.restart()
    assert.deepEqual(h.ctx.state.loadedSkills, [other])
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])
})

test("after validates returned output structurally and does not infer failure from text", async (t) => {
    const h = await createHousekeepingHarness(t)
    const protectedRecord = skillRecord("protected")
    await seedSkills(h, [], [protectedRecord])
    const { after } = definitions(h)
    const args = { name: "demo" }
    const input = { tool: "skill", sessionID: h.sessionID, callID: "after-shape", args }
    const invalidOutputs: any[] = [
        { title: "Load demo", output: 1, metadata: {} },
        { title: 1, output: "body", metadata: {} },
        { title: "Load demo", output: "body", metadata: null },
        { title: "Load demo", output: "body", metadata: [] },
    ]

    for (const output of invalidOutputs) {
        await assert.rejects(after(input, output), /output|title|metadata|invalid|structure/i)
        assert.deepEqual(h.ctx.state.loadedSkills, [])
    }

    const valid = {
        title: "Load demo",
        output: "Error: failed to parse the skill body",
        metadata: { name: "demo", dir: "/skills/demo" },
    }
    await after(input, valid)

    assert.equal(h.ctx.state.loadedSkills.length, 1)
    assert.equal(h.ctx.state.loadedSkills[0]!.output, valid.output)
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])
})

test("after replaces an existing loaded name at its ordered position with owned data", async (t) => {
    const h = await createHousekeepingHarness(t)
    const first = skillRecord("first")
    const second = skillRecord("second", { output: "old second" })
    const third = skillRecord("third")
    const protectedRecord = skillRecord("protected")
    await seedSkills(h, [first, second, third], [protectedRecord])
    const { after } = definitions(h)
    const args = { name: "second" }
    const result = nativeResult("second", "replacement")
    const input = { tool: "skill", sessionID: h.sessionID, callID: "replace-second", args }

    await after(input, {
        title: result.title,
        output: result.output,
        metadata: result.metadata,
    })

    assert.deepEqual(
        h.ctx.state.loadedSkills.map((record) => record.name),
        ["first", "second", "third"],
    )
    assert.deepEqual(h.ctx.state.loadedSkills[0], first)
    assert.deepEqual(h.ctx.state.loadedSkills[2], third)
    const replacement = h.ctx.state.loadedSkills[1]!
    assert.equal(replacement.output, "replacement")
    assert.equal(replacement.callId, "replace-second")
    assert.notEqual(replacement.input, args)
    assert.notEqual(replacement.metadata, result.metadata)
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])

    args.name = "mutated"
    result.metadata.nested.value = "mutated"
    assert.deepEqual(h.ctx.state.loadedSkills[1]!.input, { name: "second" })
    assert.deepEqual(h.ctx.state.loadedSkills[1]!.metadata, {
        name: "second",
        dir: "/skills/second",
        nested: { value: "native" },
    })
})

test("overlapping native loads do not reserve names and publish in completion order", async (t) => {
    const h = await createHousekeepingHarness(t)
    const protectedRecord = skillRecord("protected")
    await seedSkills(h, [], [protectedRecord])
    const { before, after } = definitions(h)
    const firstArgs = { name: "alpha" }
    const secondArgs = { name: "beta" }

    await before(
        { tool: "skill", sessionID: h.sessionID, callID: "alpha-first" },
        { args: firstArgs },
    )
    await before(
        { tool: "skill", sessionID: h.sessionID, callID: "alpha-overlap" },
        { args: firstArgs },
    )
    await before({ tool: "skill", sessionID: h.sessionID, callID: "beta" }, { args: secondArgs })
    assert.deepEqual(h.ctx.state.loadedSkills, [])

    const beta = nativeResult("beta", "beta output")
    await after(
        { tool: "skill", sessionID: h.sessionID, callID: "beta", args: secondArgs },
        { title: beta.title, output: beta.output, metadata: beta.metadata },
    )
    const alpha = nativeResult("alpha", "alpha first")
    await after(
        { tool: "skill", sessionID: h.sessionID, callID: "alpha-first", args: firstArgs },
        { title: alpha.title, output: alpha.output, metadata: alpha.metadata },
    )
    const alphaAgain = nativeResult("alpha", "alpha overlap")
    await after(
        { tool: "skill", sessionID: h.sessionID, callID: "alpha-overlap", args: firstArgs },
        { title: alphaAgain.title, output: alphaAgain.output, metadata: alphaAgain.metadata },
    )

    assert.deepEqual(
        h.ctx.state.loadedSkills.map((record) => record.name),
        ["beta", "alpha"],
    )
    assert.equal(h.ctx.state.loadedSkills[1]!.callId, "alpha-overlap")
    assert.equal(h.ctx.state.loadedSkills[1]!.output, "alpha overlap")
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])
})

test("non-skill hooks pass through without touching skill state", async (t) => {
    const h = await createHousekeepingHarness(t)
    const loaded = skillRecord("demo")
    const protectedRecord = skillRecord("protected")
    await seedSkills(h, [loaded], [protectedRecord])
    const { before, after } = definitions(h)

    await before({ tool: "read", sessionID: h.sessionID, callID: "read" }, { args: { path: "a" } })
    await after(
        { tool: "read", sessionID: h.sessionID, callID: "read", args: { path: "a" } },
        { title: "read", output: "contents", metadata: { path: "a" } },
    )

    assert.deepEqual(h.ctx.state.loadedSkills, [loaded])
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])
})

test("native skill arguments require a non-empty string name and boolean force", async (t) => {
    const h = await createHousekeepingHarness(t)
    const protectedRecord = skillRecord("protected")
    await seedSkills(h, [], [protectedRecord])
    const { before } = definitions(h)
    const invalidArgs = [
        {},
        { name: 1 },
        { name: "" },
        { name: "demo", force: "yes" },
        { name: "demo", force: 1 },
    ]

    for (const [index, args] of invalidArgs.entries()) {
        await assert.rejects(
            before({ tool: "skill", sessionID: h.sessionID, callID: `invalid-${index}` }, { args }),
            /name|force|invalid|string|boolean/i,
        )
        assert.deepEqual(h.ctx.state.loadedSkills, [])
    }
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])
})

test("unload tool schema requires a string name", async (t) => {
    const h = await createHousekeepingHarness(t)
    const unload = createUnloadSkillTool(h.ctx)
    const schema = tool.schema.object(unload.args)

    assert.equal(typeof unload.execute, "function")
    assert.equal(schema.safeParse({ name: "demo" }).success, true)
    assert.equal(schema.safeParse({}).success, false)
    assert.equal(schema.safeParse({ name: 1 }).success, false)
})

test("unload removes only the named loaded skill and persists the change", async (t) => {
    const h = await createHousekeepingHarness(t)
    const demo = skillRecord("demo")
    const other = skillRecord("other")
    const protectedRecord = skillRecord("protected")
    await seedSkills(h, [demo, other], [protectedRecord])
    const unload = createUnloadSkillTool(h.ctx)
    const contentRevisionBefore = h.ctx.state.contentRevision
    const revisionBefore = h.ctx.state.revision

    const status = await unload.execute(
        { name: "demo" } as any,
        executionContext(h, "unload-demo") as any,
    )

    assert.equal(typeof status, "string")
    assert.ok(status.length > 0)
    assert.deepEqual(h.ctx.state.loadedSkills, [other])
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])
    assert.equal(h.ctx.state.contentRevision, contentRevisionBefore)
    assert.ok(h.ctx.state.revision > revisionBefore)

    const persisted = await readPersistedSkills(h)
    assert.deepEqual(persisted.loadedSkills, [other])
    assert.deepEqual(persisted.protectedSkills, [protectedRecord])

    await h.restart()
    assert.deepEqual(h.ctx.state.loadedSkills, [other])
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])
})

test("unload of an unloaded skill rejects without changing state", async (t) => {
    const h = await createHousekeepingHarness(t)
    const demo = skillRecord("demo")
    const protectedRecord = skillRecord("protected")
    await seedSkills(h, [demo], [protectedRecord])
    const unload = createUnloadSkillTool(h.ctx)
    const revisionBefore = h.ctx.state.revision

    await assert.rejects(
        unload.execute({ name: "missing" } as any, executionContext(h, "unload-missing") as any),
        /not loaded|missing|unload|found/i,
    )

    assert.deepEqual(h.ctx.state.loadedSkills, [demo])
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])
    assert.equal(h.ctx.state.revision, revisionBefore)

    await h.restart()
    assert.deepEqual(h.ctx.state.loadedSkills, [demo])
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])
})

test("strict-save failure does not publish a native load", async (t) => {
    const h = await createHousekeepingHarness(t)
    const protectedRecord = skillRecord("protected")
    await seedSkills(h, [], [protectedRecord])
    const { after } = definitions(h)
    const args = { name: "demo" }
    const result = nativeResult("demo")

    await withReadOnlyStorage(async () => {
        await assert.rejects(
            after(
                { tool: "skill", sessionID: h.sessionID, callID: "save-failure", args },
                { title: result.title, output: result.output, metadata: result.metadata },
            ),
            /EACCES|permission|denied|save|read-only/i,
        )
    })

    assert.deepEqual(h.ctx.state.loadedSkills, [])
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])

    await h.restart()
    assert.deepEqual(h.ctx.state.loadedSkills, [])
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])
})

test("strict-save failure does not publish an unload", async (t) => {
    const h = await createHousekeepingHarness(t)
    const demo = skillRecord("demo")
    const protectedRecord = skillRecord("protected")
    await seedSkills(h, [demo], [protectedRecord])
    const unload = createUnloadSkillTool(h.ctx)

    await withReadOnlyStorage(async () => {
        await assert.rejects(
            unload.execute({ name: "demo" } as any, executionContext(h, "unload-failure") as any),
            /EACCES|permission|denied|save|read-only/i,
        )
    })

    assert.deepEqual(h.ctx.state.loadedSkills, [demo])
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])

    await h.restart()
    assert.deepEqual(h.ctx.state.loadedSkills, [demo])
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])
})

test("strict-save failure during forced removal keeps the previous loaded record", async (t) => {
    const h = await createHousekeepingHarness(t)
    const demo = skillRecord("demo")
    const protectedRecord = skillRecord("protected")
    await seedSkills(h, [demo], [protectedRecord])
    const { before } = definitions(h)
    let nativeCalls = 0

    await withReadOnlyStorage(async () => {
        await assert.rejects(
            before(
                { tool: "skill", sessionID: h.sessionID, callID: "force-save-failure" },
                { args: { name: "demo", force: true } },
            ),
            /EACCES|permission|denied|save|read-only/i,
        )
    })

    assert.equal(nativeCalls, 0)
    assert.deepEqual(h.ctx.state.loadedSkills, [demo])
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])

    await h.restart()
    assert.deepEqual(h.ctx.state.loadedSkills, [demo])
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])
})

test("housekeeping guard permits native skill and unload_skill including functions prefix", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.enter()

    for (const name of ["skill", "unload_skill", "functions.skill", "functions.unload_skill"]) {
        await h.guard(name, { name: "demo" })
    }

    await h.leave({ force: true })
    h.assertSessionReads()
})

test("unload is callable during housekeeping without counting as qualifying leave work", async (t) => {
    const h = await createHousekeepingHarness(t)
    const demo = skillRecord("demo")
    const protectedRecord = skillRecord("protected")
    h.ctx.state.loadedSkills = [demo]
    h.ctx.state.protectedSkills = [protectedRecord]
    await saveSessionStateStrict(h.ctx.state, h.ctx.logger)
    await h.enter()
    assert.deepEqual(h.ctx.state.loadedSkills, [demo])

    const unload = createUnloadSkillTool(h.ctx)
    const status = await unload.execute(
        { name: "demo" } as any,
        executionContext(h, "housekeeping-unload") as any,
    )

    assert.equal(typeof status, "string")
    assert.deepEqual(h.ctx.state.loadedSkills, [])
    assert.deepEqual(h.ctx.state.protectedSkills, [protectedRecord])

    await assert.rejects(h.leave(), /No compression|force=true|qualifying/i)
    await h.leave({ force: true })
    h.assertSessionReads()
})
