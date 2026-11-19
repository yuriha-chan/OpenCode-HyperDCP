import assert from "node:assert/strict"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const hostVersion = "@opencode/cli@2.3.2"
const hostPassword = "package-discovery"

test(
    "OpenCode 2.3.2 discovers and loads the packed server adapter through package exports",
    { timeout: 240_000 },
    async (t) => {
        const fixture = await mkdtemp(join(tmpdir(), "hyperdcp-package-discovery-"))
        let host: ChildProcess | undefined
        t.after(async () => {
            await stop(host)
            await rm(fixture, { recursive: true, force: true })
        })

        run(repoRoot, "npm", ["run", "build"])
        const packed = JSON.parse(
            run(repoRoot, "npm", ["pack", "--json", "--pack-destination", fixture]),
        ) as Array<{ filename: string }>
        const tarball = join(fixture, packed[0].filename)
        const packageName = (
            JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { name: string }
        ).name
        await writeFile(
            join(fixture, "package.json"),
            `${JSON.stringify({ name: "hyperdcp-package-discovery", private: true })}\n`,
        )
        run(fixture, "npm", ["install", "--no-save", "--no-package-lock", hostVersion, tarball], {
            ...process.env,
            npm_config_audit: "false",
            npm_config_fund: "false",
            npm_config_loglevel: "error",
            npm_config_update_notifier: "false",
        })

        const pluginDir = join(fixture, "node_modules", ...packageName.split("/"))
        const envRoot = join(fixture, "env")
        for (const directory of ["home", "tmp", "config", "data", "cache", "state"]) {
            await mkdir(join(envRoot, directory), { recursive: true })
        }
        const env = hostEnvironment(envRoot, pluginDir)
        const opencode = join(fixture, "node_modules", ".bin", "opencode")

        host = spawn(opencode, ["serve", "--stdio", "--port", "0"], {
            cwd: fixture,
            env,
            stdio: ["pipe", "pipe", "pipe"],
        })
        let stdout = ""
        let stderr = ""
        host.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
            stdout += chunk
        })
        host.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
            stderr += chunk
        })
        const url = await waitForServer(
            host,
            () => stdout,
            () => stderr,
        )

        execFileSync(opencode, ["debug", "agents", "--server", url], {
            cwd: fixture,
            env,
            stdio: ["ignore", "ignore", "pipe"],
            timeout: 30_000,
        })

        const query = new URLSearchParams({ "location[directory]": fixture }).toString()
        const authorization = `Basic ${Buffer.from(`opencode:${hostPassword}`).toString("base64")}`
        let entry: PluginEntry | undefined
        const deadline = Date.now() + 15_000
        while (Date.now() < deadline) {
            const response = await fetch(`${url}/api/plugin?${query}`, {
                headers: { authorization },
            })
            if (!response.ok) {
                throw new Error(
                    `plugin.list failed: HTTP ${response.status} ${await response.text()}`,
                )
            }
            const body = (await response.json()) as { data: PluginEntry[] }
            entry = body.data.find(
                (plugin) => plugin.source.type === "local" && plugin.source.path === pluginDir,
            )
            if (entry) break
            await delay(100)
        }

        assert.ok(entry, `host did not list the packed package.\n${relevant(stderr)}`)
        assert.equal(
            entry.state.status,
            "active",
            `host rejected the packed server adapter: ${entry.state.error ?? JSON.stringify(entry.state)}`,
        )
        assert.equal(entry.features.server, true)
        assert.equal(typeof entry.id, "string")
        assert.ok(entry.id?.length)
    },
)

interface PluginEntry {
    id?: string
    source: { type: string; path?: string }
    features: { server?: boolean }
    state: { status: "active" | "failed"; error?: string }
}

function hostEnvironment(envRoot: string, pluginDir: string) {
    const env = { ...process.env }
    for (const name of [
        "OPENCODE_CONFIG",
        "OPENCODE_CONFIG_DIR",
        "OPENCODE_CONFIG_CONTENT",
        "OPENCODE_CLI_CONFIG_CONTENT",
        "OPENCODE_PASSWORD",
    ]) {
        delete env[name]
    }
    return {
        ...env,
        HOME: join(envRoot, "home"),
        XDG_CACHE_HOME: join(envRoot, "cache"),
        XDG_CONFIG_HOME: join(envRoot, "config"),
        XDG_DATA_HOME: join(envRoot, "data"),
        XDG_STATE_HOME: join(envRoot, "state"),
        TMPDIR: join(envRoot, "tmp"),
        OPENCODE_PASSWORD: hostPassword,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: [pluginDir] }),
        OPENCODE_CONFIG_PROJECT_DISABLE: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_PRINT_LOGS: "1",
    }
}

function run(cwd: string, command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
    return execFileSync(command, args, {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000,
    })
}

async function waitForServer(host: ChildProcess, stdout: () => string, stderr: () => string) {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
        const ready = stdout()
            .split("\n")
            .find((line) => line.startsWith("{"))
        if (ready) return (JSON.parse(ready) as { url: string }).url
        if (host.exitCode !== null) {
            throw new Error(`host exited before reporting readiness.\n${relevant(stderr())}`)
        }
        await delay(100)
    }
    throw new Error(`host did not report readiness.\n${relevant(stderr())}`)
}

async function stop(host: ChildProcess | undefined) {
    if (!host || host.exitCode !== null) return
    const exited = new Promise<void>((resolve) => host.once("exit", () => resolve()))
    host.stdin?.end()
    host.kill("SIGTERM")
    await Promise.race([exited, delay(5_000).then(() => host.kill("SIGKILL"))])
    await Promise.race([exited, delay(1_000)])
}

function relevant(output: string) {
    return output
        .split("\n")
        .filter((line) =>
            /loading plugin|failed to load plugin|PluginModule|plugin\.list|host exited/.test(line),
        )
        .slice(-10)
        .join("\n")
}

function delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
