import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { runEditor } from "../src/editor"

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
        resolve = done
    })
    return { promise, resolve }
}

test("editor waits for terminal suspension and restoration around saving the file", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "dcp-editor-"))
    t.after(() => rm(root, { recursive: true, force: true }))
    const script = join(root, "editor.cjs")
    const file = join(root, "memo.md")
    await writeFile(script, "require('node:fs').writeFileSync(process.argv[2], 'Saved content')")
    await writeFile(file, "Original")
    const suspended = deferred()
    const resuming = deferred()
    const restored = deferred()
    let finished = false
    const result = runEditor(
        {
            suspendRenderer: () => suspended.promise,
            resumeRenderer: () => {
                resuming.resolve()
                return restored.promise
            },
        },
        `${process.execPath} ${script}`,
        file,
    ).then(() => {
        finished = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(await readFile(file, "utf8"), "Original")
    assert.equal(finished, false)
    suspended.resolve()
    await resuming.promise
    assert.equal(await readFile(file, "utf8"), "Saved content")
    assert.equal(finished, false)
    restored.resolve()
    await result
    assert.equal(finished, true)
})

test("editor failure restores the terminal and rejects instead of submitting the file", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "dcp-editor-failure-"))
    t.after(() => rm(root, { recursive: true, force: true }))
    const script = join(root, "editor.cjs")
    await writeFile(script, "process.exit(7)")
    const events: string[] = []
    await assert.rejects(
        runEditor(
            {
                suspendRenderer: () => {
                    events.push("suspend")
                },
                resumeRenderer: async () => {
                    events.push("resume")
                },
            },
            `${process.execPath} ${script}`,
            join(root, "memo.md"),
        ),
        /code 7/,
    )
    assert.deepEqual(events, ["suspend", "resume"])
})

test("editor spawn failure still restores the terminal", async () => {
    let resumed = false
    await assert.rejects(
        runEditor(
            {
                suspendRenderer() {},
                resumeRenderer() {
                    resumed = true
                },
            },
            "/nonexistent-dcp-editor/executable",
            "/unused",
        ),
        { code: "ENOENT" },
    )
    assert.equal(resumed, true)
})
