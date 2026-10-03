import { spawn, spawnSync } from "node:child_process"
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const ptyDriverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "tui-pty-driver.py")

// 120x40 is too narrow: opencode hides the DCP sidebar slot below a width
// threshold, so screenshots come back empty. 169x47 matches a normal terminal
// and renders the sidebar.
export const DEFAULT_COLS = 169
export const DEFAULT_ROWS = 47

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

export function stripScriptHeader(raw) {
    const startMarker = /^Script started on .*\n/
    const body = raw.replace(startMarker, "")
    const endIndex = body.lastIndexOf("\nScript done on ")
    return endIndex === -1 ? body : body.slice(0, endIndex + 1)
}

// Minimal ANSI terminal screen emulator. opencode renders with absolute cursor
// positioning and no newlines, so a plain strip collapses the whole frame onto a
// single line. This replays the stream into a cols x rows grid and returns the
// visible text, which is what a screenshot should contain.
export function ansiToText(raw, { cols = DEFAULT_COLS, rows = DEFAULT_ROWS } = {}) {
    const grid = Array.from({ length: rows }, () => new Array(cols).fill(" "))
    let row = 0
    let col = 0
    const source = stripScriptHeader(raw)

    const put = (char) => {
        if (row >= 0 && row < rows && col >= 0 && col < cols) grid[row][col] = char
        col += 1
        if (col >= cols) {
            col = 0
            row += 1
            if (row >= rows) row = rows - 1
        }
    }

    let i = 0
    while (i < source.length) {
        const ch = source[i]
        if (ch === "\x1b") {
            const next = source[i + 1]
            if (next === "[") {
                const match = /^\x1b\[([0-9;?]*)([ -/]*)([@-~])/.exec(source.slice(i))
                if (!match) {
                    i += 1
                    continue
                }
                const params = match[1]
                const final = match[3]
                const nums = params.split(";").map((value) => (value === "" ? undefined : Number(value)))
                const first = nums[0] ?? 1
                switch (final) {
                    case "H":
                    case "f":
                        row = (nums[0] ?? 1) - 1
                        col = (nums[1] ?? 1) - 1
                        break
                    case "A":
                        row = Math.max(0, row - first)
                        break
                    case "B":
                        row = Math.min(rows - 1, row + first)
                        break
                    case "C":
                        col = Math.min(cols - 1, col + first)
                        break
                    case "D":
                        col = Math.max(0, col - first)
                        break
                    case "E":
                        row = Math.min(rows - 1, row + first)
                        col = 0
                        break
                    case "F":
                        row = Math.max(0, row - first)
                        col = 0
                        break
                    case "G":
                        col = first - 1
                        break
                    case "d":
                        row = first - 1
                        break
                    case "J": {
                        const mode = nums[0] ?? 0
                        if (mode === 2 || mode === 3) {
                            for (let r = 0; r < rows; r += 1) grid[r].fill(" ")
                        } else if (mode === 0) {
                            for (let c = col; c < cols; c += 1) grid[row][c] = " "
                            for (let r = row + 1; r < rows; r += 1) grid[r].fill(" ")
                        }
                        break
                    }
                    case "K": {
                        const mode = nums[0] ?? 0
                        if (mode === 0) {
                            for (let c = col; c < cols; c += 1) grid[row][c] = " "
                        } else if (mode === 1) {
                            for (let c = 0; c <= col && c < cols; c += 1) grid[row][c] = " "
                        } else if (mode === 2) {
                            grid[row].fill(" ")
                        }
                        break
                    }
                    default:
                        break
                }
                i += match[0].length
                continue
            }
            if (next === "]") {
                const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(source.slice(i))
                i += osc ? osc[0].length : 2
                continue
            }
            if (next === "P" || next === "(" || next === ")" || next === "#") {
                const seq = /^\x1b[P()#][^\x1b]*(?:\x1b\\)?/.exec(source.slice(i))
                i += seq ? seq[0].length : 3
                continue
            }
            i += 2
            continue
        }
        if (ch === "\n") {
            row = Math.min(rows - 1, row + 1)
            col = 0
            i += 1
            continue
        }
        if (ch === "\r") {
            col = 0
            i += 1
            continue
        }
        if (ch === "\b") {
            col = Math.max(0, col - 1)
            i += 1
            continue
        }
        if (ch === "\t") {
            col = Math.min(cols - 1, col + (8 - (col % 8)))
            i += 1
            continue
        }
        if (ch >= " ") {
            put(ch)
            i += 1
            continue
        }
        i += 1
    }

    return grid
        .map((line) => line.join("").replace(/\s+$/, ""))
        .join("\n")
        .replace(/\n+$/, "\n")
}

function encodeKeys(keys) {
    return keys.replace(/<([A-Za-z0-9]+)>/g, (match, name) => {
        switch (name) {
            case "Esc":
            case "Escape":
                return "\x1b"
            case "Enter":
            case "Return":
                return "\r"
            case "Tab":
                return "\t"
            case "Space":
                return " "
            case "Bksp":
            case "Backspace":
                return "\x7f"
            case "Up":
                return "\x1b[A"
            case "Down":
                return "\x1b[B"
            case "Right":
                return "\x1b[C"
            case "Left":
                return "\x1b[D"
            case "C-c":
                return "\x03"
            default:
                return match
        }
    })
}

export function makeIsolatedProject(baseDir, { pluginDir = repoRoot } = {}) {
    const dir = mkdtempSync(path.join(baseDir, "dcp-tui-harness-"))
    const dataHome = path.join(dir, "data")
    const configHome = path.join(dir, "config")
    mkdirSync(dataHome, { recursive: true })
    mkdirSync(configHome, { recursive: true })

    writeFileSync(
        path.join(dir, "opencode.json"),
        JSON.stringify({ "$schema": "https://opencode.ai/config.json", plugin: [pluginDir] }, null, 2),
    )
    writeFileSync(
        path.join(dir, "tui.json"),
        JSON.stringify({ "$schema": "https://opencode.ai/tui.json", plugin: [pluginDir] }, null, 2),
    )

    return {
        dir,
        dataHome,
        configHome,
        storageDir: path.join(dataHome, "opencode", "storage", "plugin", "dcp"),
        seedState(sessionId, state) {
            mkdirSync(this.storageDir, { recursive: true })
            const file = path.join(this.storageDir, `${sessionId}.json`)
            writeFileSync(file, JSON.stringify(state, null, 2))
            return file
        },
        cleanup() {
            rmSync(dir, { recursive: true, force: true })
        },
    }
}

export function cloneTemplateState(templatePath, sessionId) {
    const state = JSON.parse(readFileSync(templatePath, "utf8"))
    state.lastUpdated = Date.now()
    return { state, sessionId }
}

export async function runTui(options) {
    const {
        cwd,
        dataHome,
        configHome,
        keys = "",
        steps,
        cols = DEFAULT_COLS,
        rows = DEFAULT_ROWS,
        settleMs = 1200,
        startupMs = 4000,
        startupMaxMs = 30000,
        waitFor = "",
        command = "opencode",
        commandArgs = [],
        captureFile,
        timeoutMs = 60000,
        recordFrames = false,
    } = options

    const rawCapture = captureFile ? captureFile.replace(/\.cast$/, ".raw") : path.join(cwd, ".capture.raw")

    const env = {
        ...process.env,
        HOME: homedir(),
        XDG_DATA_HOME: dataHome,
        XDG_CONFIG_HOME: configHome,
        TERM: "xterm-256color",
        COLUMNS: String(cols),
        LINES: String(rows),
        FORCE_COLOR: "1",
    }

    // `script -qefc` from a non-tty shell cannot drive opencode (injected keys are
    // swallowed). A real pty.fork() master that sets TIOCSWINSZ works, so the PTY
    // is allocated by a stdlib-only Python driver instead.
    const keysFile = path.join(cwd, ".keys.txt")
    const encodedKeys = keys
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
            const [keyPart, delayPart] = line.split("|")
            return delayPart ? `${encodeKeys(keyPart.trim())}|${delayPart.trim()}` : encodeKeys(keyPart.trim())
        })
        .join("\n")
    writeFileSync(keysFile, encodedKeys)

    // Playwright-style step list. Keys are escape-encoded here; the Python driver
    // runs steps in order, honouring waitFor (against the emulated screen) and
    // screenshot assertions, and writes per-step results to the result file.
    let stepsFile = null
    let resultFile = null
    if (Array.isArray(steps) && steps.length > 0) {
        stepsFile = path.join(cwd, ".steps.json")
        const encodedSteps = steps.map((step) => {
            if (typeof step === "string") return { keys: encodeKeys(step) }
            if (step.keys !== undefined) {
                return { ...step, keys: encodeKeys(step.keys) }
            }
            return step
        })
        writeFileSync(stepsFile, JSON.stringify(encodedSteps, null, 2))
        resultFile = path.join(cwd, ".steps-result.json")
    }

    const child = spawn(
        "python3",
        [
            ptyDriverPath,
            "--cwd", cwd,
            "--capture", rawCapture,
            "--cols", String(cols),
            "--rows", String(rows),
            "--startup-ms", String(startupMs),
            "--startup-max-ms", String(startupMaxMs),
            "--wait-for", waitFor,
            "--settle-ms", String(settleMs),
            "--timeout-ms", String(timeoutMs),
            "--term", "xterm-256color",
            "--respond",
            "--keys-file", keysFile,
            ...(stepsFile ? ["--steps-file", stepsFile, "--result-file", resultFile] : []),
            "--",
            command,
            ...commandArgs,
        ],
        { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    )

    let stderr = ""
    child.stderr.on("data", (chunk) => {
        stderr += chunk.toString()
    })

    // The Python driver writes the PTY transcript to the capture FILE, not to its
    // own stdout, so the timeline has to be polled from the file rather than
    // streamed from the child. Poll fast enough to observe transient frames.
    const frames = []
    let framePoll = null
    let lastSize = 0
    if (recordFrames) {
        framePoll = setInterval(() => {
            if (!existsSync(rawCapture)) return
            let size = 0
            try {
                size = statSync(rawCapture).size
            } catch {
                return
            }
            if (size <= lastSize) return
            let chunk
            try {
                const fd = openSync(rawCapture, "r")
                const buffer = Buffer.alloc(size - lastSize)
                readSync(fd, buffer, 0, buffer.length, lastSize)
                closeSync(fd)
                chunk = buffer.toString("utf8")
            } catch {
                return
            }
            lastSize = size
            frames.push({ t: Date.now(), text: chunk })
        }, 25)
    }

    // The Python driver reads the keys file, drives the scenario and terminates
    // the child itself; Node only waits for the driver process to exit.
    const done = new Promise((resolve) => {
        child.on("exit", () => resolve())
    })

    // The driver enforces its own scenario timeout, but guard against a wedged
    // driver so the harness cannot hang forever.
    const hardStop = setTimeout(() => {
        child.kill("SIGKILL")
    }, timeoutMs + startupMs + settleMs + 15000)

    await Promise.race([done, sleep(timeoutMs + startupMs + settleMs + 20000)])
    clearTimeout(hardStop)
    if (!child.killed) child.kill("SIGKILL")

    const raw = existsSync(rawCapture) ? readFileSync(rawCapture, "utf8") : ""
    const text = ansiToText(raw)
    if (framePoll) clearInterval(framePoll)

    let stepResults = null
    if (resultFile && existsSync(resultFile)) {
        try {
            stepResults = JSON.parse(readFileSync(resultFile, "utf8"))
        } catch {
            stepResults = null
        }
    }

    return { raw, text, stderr, rawCapture, frames, stepResults }
}

export function writeAsciicast(text, outFile, { cols = DEFAULT_COLS, rows = DEFAULT_ROWS, delay = 0.2 } = {}) {
    const lines = [
        JSON.stringify({ version: 2, width: cols, height: rows, timestamp: Math.floor(Date.now() / 1000) }),
    ]
    const chunks = text.split("\n")
    chunks.forEach((chunk, index) => {
        const data = index === chunks.length - 1 ? chunk : `${chunk}\n`
        lines.push(
            JSON.stringify([
                Number((index * delay).toFixed(2)),
                "o",
                data,
            ]),
        )
    })
    writeFileSync(outFile, `${lines.join("\n")}\n`)
    return outFile
}

export function writeRawAnsi(raw, outFile) {
    writeFileSync(outFile, raw)
    return outFile
}

// Renders the incremental PTY output timeline into screen snapshots. Each entry
// is the visible screen after replaying all chunks up to and including that one,
// so palette/dialog frames that are later overwritten remain observable.
export function renderFrameSnapshots(frames, { cols = DEFAULT_COLS, rows = DEFAULT_ROWS, maxSnapshots = 400 } = {}) {
    if (!frames || frames.length === 0) return []
    const picked =
        frames.length <= maxSnapshots
            ? frames
            : Array.from({ length: maxSnapshots }, (_, k) => frames[Math.floor((k * frames.length) / maxSnapshots)])
    const base = frames[0].t
    const out = []
    let lastText = null
    for (const frame of picked) {
        const text = ansiToText(frame.text, { cols, rows })
        out.push({ dtMs: frame.t - base, bytes: frame.text.length, text, changed: text !== lastText })
        lastText = text
    }
    return out
}

export { sleep, spawnSync }
