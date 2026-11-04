import "./helpers/storage-env"
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import server from "../index"
import { getSessionFilePath } from "../lib/paths"
import type { SkillContext } from "../lib/state"
import { createHousekeepingHarness } from "./helpers/housekeeping"
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
