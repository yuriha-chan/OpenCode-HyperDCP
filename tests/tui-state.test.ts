import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDcpStateReader } from "../src/tui-state"

let tempFileCounter = 0

test("loaded skills show current protection status and refresh without listing protected-only entries", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "dcp-tui-skills-"))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const file = join(dir, "session.json")
    const read = createDcpStateReader(() => file)
    const loadedSkills = [
        { name: "parser", title: "Parser guidance" },
        { name: "review", title: "Review guidance" },
    ]
    writeAtomic(
        file,
        JSON.stringify({ loadedSkills, protectedSkills: [{ name: "review" }, { name: "old" }] }),
    )
    assert.deepEqual((await read("session")).skills, [
        { name: "parser", title: "Parser guidance", status: "in context" },
        { name: "review", title: "Review guidance", status: "injected" },
    ])
    writeAtomic(
        file,
        JSON.stringify({ loadedSkills: [loadedSkills[0]], protectedSkills: [{ name: "parser" }] }),
    )
    assert.deepEqual((await read("session")).skills, [
        { name: "parser", title: "Parser guidance", status: "injected" },
    ])
    writeAtomic(file, "{}")
    assert.deepEqual((await read("session")).skills, [])
})

function writeAtomic(path: string, contents: string): void {
    tempFileCounter += 1
    const tempPath = `${path}.${tempFileCounter}.tmp`
    writeFileSync(tempPath, contents)
    renameSync(tempPath, path)
}

function mainFile(
    topic: string,
    memo: string,
    extra: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        prune: {
            messages: {
                blocksById: {
                    1: {
                        blockId: 1,
                        active: true,
                        activeVersionIndex: 1,
                        topic,
                        summary: topic,
                        summaryVersions: [],
                        startId: "m1",
                        endId: "m1",
                        compressedTokens: 10,
                        durationMs: 0,
                        deactivatedByUser: false,
                        parentBlockIds: [],
                        includedBlockIds: [],
                    },
                },
                byMessageId: {},
            },
        },
        messageIds: { byRawId: {} },
        memo,
        stats: {
            totalPruneTokens: 0,
            totalMessagesPruned: 0,
            totalToolsPruned: 0,
            compressionRatio: 0,
        },
        ...extra,
    }
}

test("state reader projects committed blocks, refs, memo and stats and reuses the object for an unchanged stamp", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "dcp-tui-state-"))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const file = join(dir, "session.json")
    writeFileSync(
        file,
        JSON.stringify({
            prune: {
                messages: {
                    blocksById: {
                        1: {
                            blockId: 1,
                            active: true,
                            activeVersionIndex: 2,
                            topic: "first topic",
                            batchTopic: "batch",
                            mode: "compress",
                            compressedTokens: 120,
                            summary: "base summary",
                            summaryVersions: ["version-two-text", "version-three"],
                            startId: "m2",
                            endId: "m1",
                            durationMs: 42,
                            deactivatedByUser: false,
                            parentBlockIds: [0],
                            includedBlockIds: [3],
                        },
                        2: {
                            blockId: 2,
                            summary: "fallback",
                        },
                    },
                    byMessageId: {
                        m2: { tokenCount: 33, activeBlockIds: [1] },
                        m3: { tokenCount: 7, activeBlockIds: [2] },
                    },
                },
            },
            messageIds: { byRawId: { m2: "R2", m1: "R1" } },
            memo: ["line one", { topic: "Topic", items: ["line two"] }],
            stats: {
                totalPruneTokens: 500,
                totalMessagesPruned: 6,
                totalToolsPruned: 4,
                compressionRatio: 0.42,
            },
        }),
    )

    const reader = createDcpStateReader(() => file)
    const state = await reader("session")

    assert.deepEqual(state, {
        skills: [],
        blocks: [
            {
                blockId: 1,
                active: true,
                activeVersionIndex: 2,
                topic: "first topic",
                batchTopic: "batch",
                mode: "compress",
                compressedTokens: 120,
                summaryTokens: 4,
                startId: "m2",
                endId: "m1",
                durationMs: 42,
                deactivatedByUser: false,
                parentBlockIds: [0],
                includedBlockIds: [3],
                versions: ["base summary", "version-two-text", "version-three"],
            },
            {
                blockId: 2,
                active: false,
                activeVersionIndex: 1,
                topic: "",
                compressedTokens: 0,
                summaryTokens: 2,
                startId: "",
                endId: "",
                durationMs: 0,
                deactivatedByUser: false,
                parentBlockIds: [],
                includedBlockIds: [],
                versions: ["fallback"],
            },
        ],
        trackedMessages: [
            { rawId: "m2", ref: "R2", tokenCount: 33, activeBlockIds: [1] },
            { rawId: "m1", ref: "R1", tokenCount: 0, activeBlockIds: [] },
            { rawId: "m3", ref: "?", tokenCount: 7, activeBlockIds: [2] },
        ],
        memo: "line one\n# Topic\nline two",
        stats: {
            totalPruneTokens: 500,
            totalMessagesPruned: 6,
            totalToolsPruned: 4,
            compressionRatio: 0.42,
        },
    })

    const again = await reader("session")
    assert.strictEqual(again, state)
})

test("state reader republishes committed sections on atomic replacement, ignores draft-only writes, and survives missing or malformed files", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "dcp-tui-state-"))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const file = join(dir, "session.json")
    const reader = createDcpStateReader(() => file)

    const initial = await reader("session")
    assert.deepEqual(initial, {
        blocks: [],
        trackedMessages: [],
        memo: null,
        stats: null,
        skills: [],
    })

    writeAtomic(file, JSON.stringify(mainFile("committed-1", "memo-1")))
    const first = await reader("session")
    assert.equal(first.blocks[0].topic, "committed-1")
    assert.equal(first.memo, "memo-1")

    writeAtomic(
        file,
        JSON.stringify(
            mainFile("committed-1", "memo-1", { draft: { topic: "uncommitted draft" } }),
        ),
    )
    const draftOnly = await reader("session")
    assert.deepEqual(draftOnly, first)

    writeAtomic(file, JSON.stringify(mainFile("committed-2", "memo-2")))
    const changed = await reader("session")
    assert.equal(changed.blocks[0].topic, "committed-2")
    assert.equal(changed.memo, "memo-2")

    writeAtomic(file, "{not valid json")
    await assert.rejects(reader("session"))

    rmSync(file)
    const afterMissing = await reader("session")
    assert.equal(afterMissing.blocks[0].topic, "committed-2")
    assert.equal(afterMissing.memo, "memo-2")

    writeAtomic(file, JSON.stringify(mainFile("committed-3", "memo-3")))
    const corrected = await reader("session")
    assert.equal(corrected.blocks[0].topic, "committed-3")
    assert.equal(corrected.memo, "memo-3")
})
