import "./helpers/storage-env"
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import server from "../index"
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
