#!/usr/bin/env node
//
// PTY-driven TUI capture harness for the DCP sidebar/pages.
//
// Spawns opencode inside an isolated temp project (its own opencode.json /
// tui.json / XDG dirs), drives scripted keystrokes through a pseudo-terminal
// allocated by a stdlib-only Python pty driver (scripts/tui-pty-driver.py), and
// writes both a raw ANSI capture and a renderable asciicast v2 file for each
// scenario.
//
// Usage:
//   node scripts/tui-harness.mjs                      # run all scenarios
//   node scripts/tui-harness.mjs dcp-blocks-list      # run one scenario
//   node scripts/tui-harness.mjs --list               # list scenario names
//   node scripts/tui-harness.mjs --out DIR            # output directory
//   node scripts/tui-harness.mjs --out DIR             # output directory
//   node scripts/tui-harness.mjs --keep               # keep the temp project
//
// Scenario state is always seeded from the committed neutral fixture
// scripts/fixtures/demo-pizza-bot.json, so screenshots never leak a real session.
//
// Screenshots land in ./harness-out/<scenario>.cast (asciicast v2) and
// ./harness-out/<scenario>.raw (raw ANSI). Render the cast later with agg or
// svg-term once installed.

import { mkdirSync, existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"

import {
    makeIsolatedProject,
    bootstrapSession,
    runTui,
    writeAsciicast,
    ansiToText,
    renderFrameSnapshots,
    htmlToPng,
    repoRoot,
} from "./tui-harness.mjs"
import { scenarios, findScenario, DEFAULT_WAIT_FOR } from "./tui-scenarios.mjs"

// Neutral, committed fixture so the harness never depends on a real personal
// session for demos/screenshots. Regenerate with scripts/fixtures/make-demo-fixture.mjs.
const DEMO_FIXTURE = path.join(repoRoot, "scripts", "fixtures", "demo-pizza-bot.json")

function parseArgs(argv) {
    const options = {
        out: path.join(repoRoot, "harness-out"),
        keep: false,
        list: false,
        frames: false,
        startupMs: 2500,
        settleMs: 600,
        timeoutMs: 20000,
        waitFor: DEFAULT_WAIT_FOR,
        names: [],
    }
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]
        if (arg === "--out") {
            options.out = path.resolve(argv[++i])
        } else if (arg === "--keep") {
            options.keep = true
        } else if (arg === "--frames") {
            options.frames = true
        } else if (arg === "--list") {
            options.list = true
        } else if (arg === "--startup") {
            options.startupMs = Number(argv[++i])
        } else if (arg === "--settle") {
            options.settleMs = Number(argv[++i])
        } else if (arg === "--timeout") {
            options.timeoutMs = Number(argv[++i])
        } else if (arg === "--wait-for") {
            options.waitFor = argv[++i]
        } else if (arg === "--help" || arg === "-h") {
            options.help = true
        } else if (!arg.startsWith("-")) {
            options.names.push(arg)
        }
    }
    return options
}

// The harness only ever seeds the committed neutral fixture. Real sessions are
// deliberately not supported: rendering someone's real DCP state into a demo
// screenshot could leak private content.
function loadSeedState() {
    if (!existsSync(DEMO_FIXTURE)) return null
    return { file: DEMO_FIXTURE, name: "demo-pizza-bot" }
}

function printHelp() {
    console.log(`DCP TUI capture harness

Usage:
  node scripts/tui-harness.mjs [scenario...] [options]

Options:
  --list            list scenario names and exit
  --out DIR         output directory (default: <repo>/harness-out)
  --frames          record and write a frame-by-frame screen timeline per scenario
  --startup MS      wait before sending the first key (default: 2500)
  --wait-for TEXT   raw-output marker signalling readiness (default: "Ask anything")
  --settle MS       wait after each key (default: 600)
  --timeout MS      scenario budget before forced termination (default: 20000)
  --keep            keep the temp project directory
  -h, --help        show this help

Scenario names:`)
    for (const scenario of scenarios) {
        console.log(`  ${scenario.name.padEnd(22)} ${scenario.title}`)
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
        printHelp()
        return 0
    }
    if (options.list) {
        for (const scenario of scenarios) console.log(scenario.name)
        return 0
    }

    const selected = options.names.length > 0
        ? options.names.map((name) => {
            const scenario = findScenario(name)
            if (!scenario) throw new Error(`unknown scenario: ${name}`)
            return scenario
        })
        : scenarios

    mkdirSync(options.out, { recursive: true })

    const project = makeIsolatedProject("/tmp/opencode")
    let sessionId
    try {
        process.stdout.write("bootstrapping isolated session ... ")
        sessionId = bootstrapSession(project)
        console.log(sessionId)
    } catch (error) {
        console.log(`ERROR: ${error.message}`)
        if (!options.keep) project.cleanup()
        return 1
    }

    const seed = loadSeedState()
    if (seed) {
        const state = JSON.parse(readFileSync(seed.file, "utf8"))
        project.seedState(sessionId, state)
        console.log(`seeded session ${sessionId} from ${seed.file}`)
    } else {
        console.log(`missing fixture ${DEMO_FIXTURE}; scenarios run against an empty DCP state`)
    }

    const results = []
    try {
        for (const scenario of selected) {
            process.stdout.write(`running ${scenario.name} ... `)
            const captureFile = path.join(options.out, `${scenario.name}.raw`)
            let outcome
            try {
                outcome = await runTui({
                    cwd: project.dir,
                    dataHome: project.dataHome,
                    configHome: project.configHome,
                    command: "opencode",
                    commandArgs: ["--session", sessionId],
                    keys: scenario.keys,
                    steps: scenario.steps,
                    startupMs: scenario.startupMs ?? options.startupMs,
                    waitFor: scenario.waitFor ?? options.waitFor,
                    settleMs: options.settleMs,
                    timeoutMs: options.timeoutMs,
                    captureFile,
                    recordFrames: options.frames,
                })
            } catch (error) {
                console.log(`ERROR: ${error.message}`)
                results.push({ scenario: scenario.name, ok: false, error: error.message })
                continue
            }

            writeAsciicast(outcome.text, path.join(options.out, `${scenario.name}.cast`))
            if (options.frames && outcome.frames) {
                const snapshots = renderFrameSnapshots(outcome.frames)
                const timelineFile = path.join(options.out, `${scenario.name}.frames.txt`)
                const body = snapshots
                    .map((snap, index) => `===== frame ${index} @ +${(snap.dtMs / 1000).toFixed(2)}s (${snap.bytes}B)${snap.changed ? " [changed]" : ""} =====\n${snap.text}`)
                    .join("\n\n")
                writeFileSync(timelineFile, `${body}\n`)
                console.log(`frames -> ${timelineFile}`)
            }
            for (const request of outcome.pngRequests ?? []) {
                const pngPath = path.join(options.out, request.png)
                const rendered = htmlToPng(request.html, pngPath, {
                    width: request.width,
                    height: request.height,
                })
                if (rendered) {
                    console.log(`png -> ${rendered}`)
                } else {
                    console.log(`png FAILED: ${request.png} (chromium unavailable or render failed)`)
                }
            }
            const matched = scenario.capture ? outcome.text.includes(scenario.capture) : null
            const stepFailure = outcome.stepResults?.failure ?? null
            const ok = matched !== false && !stepFailure
            const status = stepFailure ? `FAILED: ${stepFailure}` : matched === false ? "no-capture" : "ok"
            console.log(status)
            results.push({
                scenario: scenario.name,
                ok,
                capture: matched,
                failure: stepFailure,
                stepResults: outcome.stepResults?.results ?? null,
                text: outcome.text,
            })
        }
    } finally {
        if (options.keep) {
            console.log(`kept temp project: ${project.dir}`)
        } else {
            project.cleanup()
        }
    }

    const failed = results.filter((result) => !result.ok)
    console.log(`\n${results.length - failed.length}/${results.length} scenarios captured`)
    for (const result of results) {
        if (result.text) {
            const summary = result.text.split("\n").filter((line) => line.trim()).slice(0, 3).join(" ⏎ ")
            if (summary) console.log(`  ${result.scenario}: ${summary}`)
        }
    }
    return failed.length === 0 ? 0 : 1
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error)
        process.exit(1)
    })

export { ansiToText, copyFileSync }
