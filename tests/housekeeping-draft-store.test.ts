import "./helpers/storage-env"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fsPromises, { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { join } from "node:path"
import test from "node:test"
import { gunzipSync, gzipSync } from "node:zlib"
import { STORAGE_DIR } from "../lib/paths"
import {
    readHousekeepingCheckpoint,
    readHousekeepingDraft,
    writeHousekeepingDelta,
    writeHousekeepingDraft,
} from "../lib/state/housekeeping-draft-store"
import type { CompressionBlock, HousekeepingDraft } from "../lib/state/types"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function block(blockId: number, runId: number, anchorMessageId: string): CompressionBlock {
    return {
        blockId,
        runId,
        active: blockId === 2,
        deactivatedByUser: false,
        compressedTokens: 100 + blockId,
        summaryTokens: 20 + blockId,
        durationMs: 5 + blockId,
        mode: "range",
        topic: `Topic ${blockId}`,
        batchTopic: `Batch ${blockId}`,
        startId: `m${blockId}`,
        endId: `m${blockId + 1}`,
        anchorMessageId,
        compressMessageId: `compress-${blockId}`,
        compressCallId: `call-${blockId}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: blockId,
        deactivatedAt: undefined,
        deactivatedByBlockId: undefined,
        summary: `Summary ${blockId}`,
        summaryVersions: [`Summary ${blockId}`],
        activeVersionIndex: 1,
        pendingEditBuffer: `Staged summary ${blockId}`,
        pendingExpandedMessageIds: [`expanded-${blockId}`],
    }
}

function createDraft(): HousekeepingDraft {
    return {
        prune: {
            tools: new Map([
                ["read", 3],
                ["bash", 7],
            ]),
            messages: {
                byMessageId: new Map([
                    ["m1", { tokenCount: 12, allBlockIds: [1, 2], activeBlockIds: [2] }],
                    ["m2", { tokenCount: 4, allBlockIds: [2], activeBlockIds: [] }],
                ]),
                blocksById: new Map([
                    [1, block(1, 1, "m1")],
                    [2, block(2, 2, "m1")],
                ]),
                activeBlockIds: new Set([2]),
                activeByAnchorMessageId: new Map([["m1", 2]]),
                nextBlockId: 3,
                nextRunId: 3,
                lastSeenUserMessageId: "m2",
                activeMessageIds: ["m1", "m2"],
            },
        },
        stats: {
            pruneTokenCounter: 11,
            totalPruneTokens: 77,
        },
        memo: [
            "global note",
            {
                topic: "Parser",
                items: ["Boundary check", { topic: "Nested", items: ["Indent level"] }],
            },
        ],
        nudges: {
            contextLimitAnchors: new Set(["m1"]),
            turnNudgeAnchors: new Set(["m2"]),
            iterationNudgeAnchors: new Set(["m1", "m2"]),
        },
        protectedSkills: [],
    }
}

function draftPath(sessionId: string, snapshotId: string): string {
    return join(STORAGE_DIR, "housekeeping", encodeURIComponent(sessionId), `${snapshotId}.json.gz`)
}

function deltaPath(sessionId: string, snapshotId: string): string {
    return join(
        STORAGE_DIR,
        "housekeeping",
        encodeURIComponent(sessionId),
        `${snapshotId}.delta.json`,
    )
}

function snapshotRef(snapshotId: string): any {
    return { kind: "snapshot", snapshotId }
}

function asSnapshot(ref: { snapshotId: string }): any {
    return snapshotRef(ref.snapshotId)
}

async function readSnapshotPayload(sessionId: string, snapshotId: string): Promise<any> {
    const compressed = await readFile(draftPath(sessionId, snapshotId))
    return JSON.parse(gunzipSync(compressed).toString("utf-8"))
}

async function readDeltaEnvelope(sessionId: string, snapshotId: string): Promise<any> {
    return JSON.parse(await readFile(deltaPath(sessionId, snapshotId), "utf-8"))
}

async function writeDeltaFile(
    sessionId: string,
    snapshotId: string,
    envelope: unknown,
): Promise<void> {
    await writeFile(deltaPath(sessionId, snapshotId), JSON.stringify(envelope), "utf-8")
}

async function createDeltaFixture(sessionId: string) {
    const baseDraft = createDraft()
    const baseRef = asSnapshot(await writeHousekeepingDraft(sessionId, baseDraft))
    const changed = structuredClone(baseDraft)
    changed.stats.totalPruneTokens += 1
    changed.prune.tools.set("grep", 4)
    const deltaRef = await writeHousekeepingDelta(sessionId, baseRef, baseDraft, changed)
    return { baseDraft, baseRef, changed, deltaRef }
}

async function assertContextualRejection(
    promise: Promise<unknown>,
    sessionId: string,
    snapshotId: string,
): Promise<void> {
    await assert.rejects(promise, (error: unknown) => {
        assert.ok(error instanceof Error, "rejection must be an Error")
        assert.match(error.message, /housekeeping draft/i)
        assert.ok(
            error.message.includes(sessionId),
            `error must identify the session: ${error.message}`,
        )
        assert.ok(
            error.message.includes(snapshotId),
            `error must identify the snapshot: ${error.message}`,
        )
        return true
    })
}

test("writes a faithful snapshot at the contract path and reads it back", async () => {
    const sessionId = "ses_roundtrip"
    const draft = createDraft()

    const ref = await writeHousekeepingDraft(sessionId, draft)

    assert.match(ref.snapshotId, UUID_PATTERN)
    assert.equal(ref.kind, "snapshot")
    const compressed = await readFile(draftPath(sessionId, ref.snapshotId))
    assert.ok(compressed.length > 2)
    assert.equal(compressed[0], 0x1f)
    assert.equal(compressed[1], 0x8b)
    const persisted = JSON.parse(gunzipSync(compressed).toString("utf-8"))
    assert.equal(persisted.prune.tools.read, 3)
    assert.deepEqual(persisted.nudges.iterationNudgeAnchors, ["m1", "m2"])

    assert.deepEqual(await readHousekeepingDraft(sessionId, asSnapshot(ref)), draft)
})

test("reads return independent objects and never expose or mutate the written draft", async () => {
    const sessionId = "ses_isolation"
    const draft = createDraft()
    const ref = await writeHousekeepingDraft(sessionId, draft)

    draft.prune.tools.set("after-write", 1)
    draft.prune.messages.byMessageId.get("m1")!.tokenCount = 999
    draft.nudges.contextLimitAnchors.add("after-write")
    draft.memo!.push("after write")

    const expected = createDraft()
    const first = await readHousekeepingDraft(sessionId, asSnapshot(ref))
    assert.deepEqual(first, expected)

    first.prune.tools.set("mutated", 1)
    first.prune.messages.byMessageId.get("m1")!.tokenCount = 1
    first.nudges.contextLimitAnchors.add("mutated")
    first.memo!.push("mutated")

    const second = await readHousekeepingDraft(sessionId, asSnapshot(ref))
    assert.deepEqual(second, expected)
    assert.notEqual(first, second)
})

test("each write publishes a distinct immutable snapshot", async () => {
    const sessionId = "ses_distinct_writes"
    const draft = createDraft()
    const firstRef = await writeHousekeepingDraft(sessionId, draft)
    const firstExpected = createDraft()

    draft.prune.tools.set("read", 99)
    draft.memo![0] = "updated global note"
    const secondRef = await writeHousekeepingDraft(sessionId, draft)

    assert.notEqual(secondRef.snapshotId, firstRef.snapshotId)
    assert.deepEqual(await readHousekeepingDraft(sessionId, asSnapshot(firstRef)), firstExpected)
    const second = await readHousekeepingDraft(sessionId, asSnapshot(secondRef))
    assert.equal(second.prune.tools.get("read"), 99)
    assert.ok(second.memo?.includes("updated global note"))
})

test("references are scoped to a session directory and slash session IDs are encoded", async () => {
    const draft = createDraft()
    const firstSession = "ses_session_a"
    const secondSession = "ses_session_b"

    const firstRef = await writeHousekeepingDraft(firstSession, draft)
    const secondRef = await writeHousekeepingDraft(secondSession, draft)

    assert.notEqual(firstRef.snapshotId, secondRef.snapshotId)
    assert.deepEqual(await readHousekeepingDraft(firstSession, asSnapshot(firstRef)), draft)
    assert.deepEqual(await readHousekeepingDraft(secondSession, asSnapshot(secondRef)), draft)
    await assert.rejects(
        readHousekeepingDraft(secondSession, asSnapshot(firstRef)),
        /not found|missing/i,
    )

    const slashSession = "ses/slash/session"
    const slashRef = await writeHousekeepingDraft(slashSession, draft)
    assert.deepEqual(await readHousekeepingDraft(slashSession, asSnapshot(slashRef)), draft)
    assert.ok((await readFile(draftPath(slashSession, slashRef.snapshotId))).length > 0)
})

test("missing, malformed, and invalid snapshots fail without preventing later valid reads", async () => {
    const sessionId = "ses_bad_payloads"
    const goodRef = await writeHousekeepingDraft(sessionId, createDraft())
    const corruptRef = await writeHousekeepingDraft(sessionId, createDraft())
    const invalidRef = await writeHousekeepingDraft(sessionId, createDraft())

    await writeFile(draftPath(sessionId, corruptRef.snapshotId), gzipSync('{"prune":'))
    await writeFile(
        draftPath(sessionId, invalidRef.snapshotId),
        gzipSync(JSON.stringify({ prune: {}, nudges: {} })),
    )

    assert.deepEqual(await readHousekeepingDraft(sessionId, asSnapshot(goodRef)), createDraft())
    await assert.rejects(
        readHousekeepingDraft(sessionId, snapshotRef(crypto.randomUUID())),
        /not found|missing/i,
    )
    assert.deepEqual(await readHousekeepingDraft(sessionId, asSnapshot(goodRef)), createDraft())
    await assert.rejects(
        readHousekeepingDraft(sessionId, asSnapshot(corruptRef)),
        /malformed|parse|JSON/i,
    )
    assert.deepEqual(await readHousekeepingDraft(sessionId, asSnapshot(goodRef)), createDraft())
    await assert.rejects(readHousekeepingDraft(sessionId, asSnapshot(invalidRef)), /invalid draft/i)
    assert.deepEqual(await readHousekeepingDraft(sessionId, asSnapshot(goodRef)), createDraft())
})

test("corrupt required snapshot data fails contextually instead of defaulting", async (t) => {
    const sessionId = "ses_corrupt_required_data"
    const baseRef = await writeHousekeepingDraft(sessionId, createDraft())
    const basePayload = await readSnapshotPayload(sessionId, baseRef.snapshotId)
    assert.deepEqual(await readHousekeepingDraft(sessionId, asSnapshot(baseRef)), createDraft())

    const corruptions: { name: string; corrupt: (payload: any) => void }[] = [
        {
            name: "absent prune.tools",
            corrupt: (payload) => {
                delete payload.prune.tools
            },
        },
        {
            name: "nonrecord prune.tools",
            corrupt: (payload) => {
                payload.prune.tools = ["read"]
            },
        },
        {
            name: "empty prune.messages",
            corrupt: (payload) => {
                payload.prune.messages = {}
            },
        },
        {
            name: "null byMessageId entry",
            corrupt: (payload) => {
                payload.prune.messages.byMessageId.m1 = null
            },
        },
        {
            name: "byMessageId entry missing required fields",
            corrupt: (payload) => {
                payload.prune.messages.byMessageId.m1 = { allBlockIds: [1] }
            },
        },
        {
            name: "malformed blocksById block",
            corrupt: (payload) => {
                payload.prune.messages.blocksById["1"].summary = 123
            },
        },
        {
            name: "wrong type activeBlockIds",
            corrupt: (payload) => {
                payload.prune.messages.activeBlockIds = "2"
            },
        },
        {
            name: "wrong type byMessageId map",
            corrupt: (payload) => {
                payload.prune.messages.byMessageId = []
            },
        },
        {
            name: "wrong type activeByAnchorMessageId map",
            corrupt: (payload) => {
                payload.prune.messages.activeByAnchorMessageId = []
            },
        },
        {
            name: "wrong type nextBlockId counter",
            corrupt: (payload) => {
                payload.prune.messages.nextBlockId = "3"
            },
        },
        {
            name: "wrong type nextRunId counter",
            corrupt: (payload) => {
                payload.prune.messages.nextRunId = null
            },
        },
    ]

    for (const corruption of corruptions) {
        await t.test(corruption.name, async () => {
            const payload = structuredClone(basePayload)
            corruption.corrupt(payload)
            const snapshotId = crypto.randomUUID()
            await writeFile(draftPath(sessionId, snapshotId), gzipSync(JSON.stringify(payload)))
            await assertContextualRejection(
                readHousekeepingDraft(sessionId, snapshotRef(snapshotId)),
                sessionId,
                snapshotId,
            )
        })
    }
})

test("a read resolves exactly the requested snapshot file", async (t) => {
    const sessionId = "ses_read_boundary"
    const requestedRef = await writeHousekeepingDraft(sessionId, createDraft())
    await writeHousekeepingDraft(sessionId, createDraft())
    const expectedPath = draftPath(sessionId, requestedRef.snapshotId)

    const originalReadFile = fsPromises.readFile
    const observedPaths: string[] = []
    fsPromises.readFile = (async (path: any, ...args: any[]) => {
        observedPaths.push(String(path))
        return originalReadFile(path, ...args)
    }) as typeof fsPromises.readFile
    syncBuiltinESMExports()
    t.after(() => {
        fsPromises.readFile = originalReadFile
        syncBuiltinESMExports()
    })

    assert.deepEqual(
        await readHousekeepingDraft(sessionId, asSnapshot(requestedRef)),
        createDraft(),
    )
    assert.ok(observedPaths.length > 0)
    assert.ok(observedPaths.every((path) => path === expectedPath))
})

test("empty, dot, dotdot, and invalid references are rejected before path access", async () => {
    const draft = createDraft()

    for (const sessionId of ["", ".", ".."]) {
        await assert.rejects(writeHousekeepingDraft(sessionId, draft), /session|empty|dot|invalid/i)
        await assert.rejects(
            readHousekeepingDraft(sessionId, snapshotRef(crypto.randomUUID())),
            /session|empty|dot|invalid/i,
        )
    }

    for (const snapshotId of [
        "",
        "../escape",
        "/tmp/escape",
        "not-a-uuid",
        "00000000-0000-0000-0000-000000000000",
    ]) {
        await assert.rejects(
            readHousekeepingDraft("ses_invalid_refs", snapshotRef(snapshotId)),
            /invalid|reference|snapshot/i,
        )
    }
})

test("write failures propagate and leave no temporary files", async (t) => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
        t.skip("permission failure requires a non-root process")
        return
    }
    const sessionId = "ses_write_failure"
    const publishedRef = await writeHousekeepingDraft(sessionId, createDraft())
    const dir = join(STORAGE_DIR, "housekeeping", encodeURIComponent(sessionId))
    await chmod(dir, 0o500)
    try {
        await assert.rejects(writeHousekeepingDraft(sessionId, createDraft()), /EACCES|permission/i)
        assert.deepEqual(
            await readHousekeepingDraft(sessionId, asSnapshot(publishedRef)),
            createDraft(),
        )
        assert.deepEqual(await readdir(dir), [`${publishedRef.snapshotId}.json.gz`])
    } finally {
        await chmod(dir, 0o700)
    }
})

test("rename failures propagate, clean the temp file, and leave the target untouched", async (t) => {
    const sessionId = "ses_rename_failure"
    const publishedRef = await writeHousekeepingDraft(sessionId, createDraft())
    const snapshotId = "00000000-0000-4000-8000-000000000000"
    const originalRandomUUID = crypto.randomUUID
    crypto.randomUUID = () => snapshotId
    syncBuiltinESMExports()
    t.after(() => {
        crypto.randomUUID = originalRandomUUID
        syncBuiltinESMExports()
    })

    const dir = join(STORAGE_DIR, "housekeeping", encodeURIComponent(sessionId))
    const finalPath = draftPath(sessionId, snapshotId)
    await mkdir(finalPath, { recursive: true })
    await writeFile(join(finalPath, "occupied"), "x", "utf-8")

    try {
        await assert.rejects(
            writeHousekeepingDraft(sessionId, createDraft()),
            /EISDIR|ENOTEMPTY|rename/i,
        )
        const entries = await readdir(dir)
        assert.ok(entries.includes(`${publishedRef.snapshotId}.json.gz`))
        assert.ok(entries.includes(`${snapshotId}.json.gz`))
        assert.deepEqual(
            entries.filter((entry) => entry.endsWith(".tmp")),
            [],
        )
        assert.deepEqual(await readdir(finalPath), ["occupied"])
        assert.deepEqual(
            await readHousekeepingDraft(sessionId, asSnapshot(publishedRef)),
            createDraft(),
        )
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})

test("snapshot checkpoints expose independent base and draft objects", async () => {
    const sessionId = "ses_snapshot_checkpoint"
    const draft = createDraft()
    const baseRef = asSnapshot(await writeHousekeepingDraft(sessionId, draft))

    const checkpoint = await readHousekeepingCheckpoint(sessionId, baseRef)
    assert.deepEqual(checkpoint.baseRef, baseRef)
    assert.deepEqual(checkpoint.base, draft)
    assert.deepEqual(checkpoint.draft, draft)
    assert.notEqual(checkpoint.base, checkpoint.draft)

    checkpoint.base.prune.tools.set("mutated", 1)
    checkpoint.draft.memo!.push("mutated")
    const again = await readHousekeepingCheckpoint(sessionId, baseRef)
    assert.deepEqual(again.base, draft)
    assert.deepEqual(again.draft, draft)
})

test("cumulative deltas reconstruct each checkpoint against one immutable base", async () => {
    const sessionId = "ses_delta_reconstruction"
    const baseDraft = createDraft()
    const baseRef = asSnapshot(await writeHousekeepingDraft(sessionId, baseDraft))
    const baseId = baseRef.snapshotId

    const addition = structuredClone(baseDraft)
    addition.prune.tools.set("grep", 5)
    addition.prune.messages.byMessageId.set("m3", {
        tokenCount: 8,
        allBlockIds: [3],
        activeBlockIds: [],
    })
    addition.memo!.push({ topic: "Checkpoint", items: ["Added checkpoint note"] })
    addition.nudges.turnNudgeAnchors.add("m3")

    const deletion = structuredClone(addition)
    deletion.prune.tools.delete("bash")
    deletion.prune.messages.byMessageId.delete("m2")
    deletion.memo!.splice(deletion.memo!.length - 1, 1)
    deletion.nudges.iterationNudgeAnchors.delete("m2")

    const nullMemo = structuredClone(deletion)
    nullMemo.memo = null

    const nestedMemo = structuredClone(deletion)
    const nestedEntry = nestedMemo.memo![1]
    assert.ok(nestedEntry && typeof nestedEntry === "object")
    nestedEntry.items[1] = { topic: "Nested", items: ["Indent level", "Escaped newline"] }

    const arrayChange = structuredClone(nestedMemo)
    arrayChange.prune.messages.activeMessageIds = ["m1"]
    arrayChange.nudges.contextLimitAnchors = new Set(["m1", "m3"])
    arrayChange.prune.messages.blocksById.get(1)!.summaryVersions.push("Second version")
    arrayChange.prune.messages.blocksById.get(1)!.activeVersionIndex = 2

    const stagedBlock = structuredClone(arrayChange)
    const block2 = stagedBlock.prune.messages.blocksById.get(2)!
    block2.pendingEditBuffer = "Pending staged rewrite"
    block2.pendingExpandedMessageIds = ["expanded-2", "expanded-3"]
    block2.summary = "Updated summary"

    const temporaryChange = structuredClone(baseDraft)
    temporaryChange.prune.tools.set("read", 99)
    temporaryChange.stats.totalPruneTokens = 999
    const undo = structuredClone(baseDraft)
    const reordered = structuredClone(baseDraft)
    const readCount = reordered.prune.tools.get("read")!
    reordered.prune.tools.delete("read")
    reordered.prune.tools.set("read", readCount)

    const checkpoints = [
        { name: "addition", draft: addition },
        { name: "deletion", draft: deletion },
        { name: "null memo", draft: nullMemo },
        { name: "nested memo", draft: nestedMemo },
        { name: "array replacement", draft: arrayChange },
        { name: "staged block buffers", draft: stagedBlock },
        { name: "temporary change", draft: temporaryChange },
        { name: "undo to base", draft: undo },
        { name: "map insertion order", draft: reordered },
    ]

    const refs: any[] = []
    for (const checkpoint of checkpoints) {
        const ref = await writeHousekeepingDelta(sessionId, baseRef, baseDraft, checkpoint.draft)
        assert.equal(ref.kind, "delta", checkpoint.name)
        assert.equal(ref.baseSnapshotId, baseId, checkpoint.name)
        assert.match(ref.snapshotId, UUID_PATTERN)
        refs.push(ref)

        const loaded = await readHousekeepingCheckpoint(sessionId, ref)
        assert.deepEqual(loaded.baseRef, baseRef, checkpoint.name)
        assert.deepEqual(loaded.base, baseDraft, checkpoint.name)
        assert.deepEqual(loaded.draft, checkpoint.draft, checkpoint.name)
        assert.deepEqual(
            [...loaded.draft.prune.tools.keys()],
            [...checkpoint.draft.prune.tools.keys()],
        )
        assert.notEqual(loaded.base, loaded.draft, checkpoint.name)
        assert.deepEqual(
            await readHousekeepingDraft(sessionId, ref),
            checkpoint.draft,
            checkpoint.name,
        )
    }

    const undoEnvelope = await readDeltaEnvelope(sessionId, refs[checkpoints.length - 2].snapshotId)
    assert.deepEqual(undoEnvelope.baseSnapshotId, baseId)
    assert.deepEqual(undoEnvelope.changes, [])

    for (const [index, checkpoint] of checkpoints.entries()) {
        const loaded = await readHousekeepingCheckpoint(sessionId, refs[index])
        assert.deepEqual(loaded.draft, checkpoint.draft, checkpoint.name)
        assert.deepEqual(loaded.base, baseDraft, checkpoint.name)
    }
    assert.deepEqual(
        await readHousekeepingCheckpoint(sessionId, baseRef).then((entry) => entry.draft),
        baseDraft,
    )
})

test("deltas omit unchanged large payloads and remain substantially smaller", async () => {
    const sessionId = "ses_delta_size"
    const marker = "LARGE-PAYLOAD-MARKER"
    const large = `${marker}${"0123456789abcdef".repeat(16000)}`
    const baseDraft = createDraft()
    baseDraft.memo = ["global note", { topic: "Huge", items: [large] }]
    const baseRef = asSnapshot(await writeHousekeepingDraft(sessionId, baseDraft))

    const changed = structuredClone(baseDraft)
    changed.stats.totalPruneTokens += 1

    const deltaRef = await writeHousekeepingDelta(sessionId, baseRef, baseDraft, changed)
    const deltaContent = await readFile(deltaPath(sessionId, deltaRef.snapshotId), "utf-8")
    const envelope = JSON.parse(deltaContent)
    assert.equal(envelope.baseSnapshotId, baseRef.snapshotId)
    assert.ok(Array.isArray(envelope.changes))
    assert.ok(!deltaContent.includes(marker), "unchanged large payload must not be copied")
    assert.ok(!JSON.stringify(envelope.changes).includes(marker))

    const baseJson = gunzipSync(await readFile(draftPath(sessionId, baseRef.snapshotId))).toString(
        "utf-8",
    )
    assert.ok(Buffer.byteLength(deltaContent) * 10 < Buffer.byteLength(baseJson))

    const loaded = await readHousekeepingCheckpoint(sessionId, deltaRef)
    assert.deepEqual(loaded.draft, changed)
    assert.deepEqual(loaded.base, baseDraft)
})

test("a delta checkpoint reads exactly its base and requested delta", async (t) => {
    const sessionId = "ses_delta_read_boundary"
    const baseDraft = createDraft()
    const baseRef = asSnapshot(await writeHousekeepingDraft(sessionId, baseDraft))
    const drafts = [1, 2, 3, 4, 5].map((offset) => {
        const draft = structuredClone(baseDraft)
        draft.stats.totalPruneTokens += offset
        return draft
    })
    const refs = []
    for (const draft of drafts)
        refs.push(await writeHousekeepingDelta(sessionId, baseRef, baseDraft, draft))

    const requestedIndex = 2
    const requestedRef = refs[requestedIndex]
    const originalReadFile = fsPromises.readFile
    const observedPaths: string[] = []
    fsPromises.readFile = (async (path: any, ...args: any[]) => {
        observedPaths.push(String(path))
        return originalReadFile(path, ...args)
    }) as typeof fsPromises.readFile
    syncBuiltinESMExports()
    t.after(() => {
        fsPromises.readFile = originalReadFile
        syncBuiltinESMExports()
    })

    const checkpoint = await readHousekeepingCheckpoint(sessionId, requestedRef)
    assert.deepEqual(checkpoint.draft, drafts[requestedIndex])
    assert.deepEqual(checkpoint.base, baseDraft)
    const expectedPaths = new Set([
        draftPath(sessionId, baseRef.snapshotId),
        deltaPath(sessionId, requestedRef.snapshotId),
    ])
    assert.equal(observedPaths.length, expectedPaths.size)
    assert.deepEqual(new Set(observedPaths), expectedPaths)
})

test("checkpoint references require explicit kinds and UUID identifiers", async () => {
    const sessionId = "ses_delta_ref_validation"
    const draft = createDraft()
    const baseRef = asSnapshot(await writeHousekeepingDraft(sessionId, draft))

    const invalidRefs: unknown[] = [
        { snapshotId: crypto.randomUUID() },
        { kind: "other", snapshotId: crypto.randomUUID() },
        { kind: "delta", snapshotId: crypto.randomUUID() },
        { kind: "delta", snapshotId: crypto.randomUUID(), baseSnapshotId: "not-a-uuid" },
        { kind: "delta", snapshotId: "not-a-uuid", baseSnapshotId: crypto.randomUUID() },
        { kind: "snapshot", snapshotId: "not-a-uuid" },
        { kind: "snapshot", snapshotId: "" },
    ]
    for (const ref of invalidRefs)
        await assert.rejects(
            readHousekeepingCheckpoint(sessionId, ref as any),
            /invalid|reference|kind|base|snapshot|delta/i,
        )

    await assert.rejects(
        writeHousekeepingDelta(
            sessionId,
            {
                kind: "delta",
                snapshotId: crypto.randomUUID(),
                baseSnapshotId: baseRef.snapshotId,
            } as any,
            draft,
            draft,
        ),
        /snapshot|base|invalid|reference/i,
    )
    await assert.rejects(
        writeHousekeepingDelta(sessionId, { snapshotId: baseRef.snapshotId } as any, draft, draft),
        /snapshot|base|invalid|reference/i,
    )

    const checkpoint = await readHousekeepingCheckpoint(sessionId, baseRef)
    assert.deepEqual(checkpoint.base, draft)
    assert.deepEqual(checkpoint.draft, draft)
})

test("missing or corrupt bases and deltas fail without publishing partial checkpoints", async (t) => {
    await t.test("missing base", async () => {
        const sessionId = "ses_delta_missing_base"
        const fixture = await createDeltaFixture(sessionId)
        await rm(draftPath(sessionId, fixture.baseRef.snapshotId))
        await assert.rejects(
            readHousekeepingCheckpoint(sessionId, fixture.deltaRef),
            (error: unknown) => {
                assert.ok(error instanceof Error)
                assert.match(error.message, /base|not found|missing/i)
                assert.ok(error.message.includes(fixture.baseRef.snapshotId))
                return true
            },
        )
    })

    await t.test("corrupt base", async () => {
        const sessionId = "ses_delta_corrupt_base"
        const fixture = await createDeltaFixture(sessionId)
        await writeFile(draftPath(sessionId, fixture.baseRef.snapshotId), gzipSync('{"prune":'))
        await assert.rejects(
            readHousekeepingCheckpoint(sessionId, fixture.deltaRef),
            /malformed|invalid|parse|base|JSON/i,
        )
    })

    await t.test("missing delta", async () => {
        const sessionId = "ses_delta_missing_delta"
        const fixture = await createDeltaFixture(sessionId)
        await rm(deltaPath(sessionId, fixture.deltaRef.snapshotId))
        await assert.rejects(
            readHousekeepingCheckpoint(sessionId, fixture.deltaRef),
            (error: unknown) => {
                assert.ok(error instanceof Error)
                assert.match(error.message, /delta|not found|missing/i)
                assert.ok(error.message.includes(fixture.deltaRef.snapshotId))
                return true
            },
        )
        const baseCheckpoint = await readHousekeepingCheckpoint(sessionId, fixture.baseRef)
        assert.deepEqual(baseCheckpoint.draft, fixture.baseDraft)
    })

    await t.test("corrupt delta", async () => {
        const sessionId = "ses_delta_corrupt_delta"
        const fixture = await createDeltaFixture(sessionId)
        await writeFile(deltaPath(sessionId, fixture.deltaRef.snapshotId), '{"baseSnapshotId":')
        await assert.rejects(
            readHousekeepingCheckpoint(sessionId, fixture.deltaRef),
            /malformed|invalid|parse|delta|JSON/i,
        )
        const baseCheckpoint = await readHousekeepingCheckpoint(sessionId, fixture.baseRef)
        assert.deepEqual(baseCheckpoint.draft, fixture.baseDraft)
    })

    await t.test("delta base mismatch", async () => {
        const sessionId = "ses_delta_base_mismatch"
        const fixture = await createDeltaFixture(sessionId)
        const envelope = await readDeltaEnvelope(sessionId, fixture.deltaRef.snapshotId)
        envelope.baseSnapshotId = crypto.randomUUID()
        await writeDeltaFile(sessionId, fixture.deltaRef.snapshotId, envelope)
        await assert.rejects(
            readHousekeepingCheckpoint(sessionId, fixture.deltaRef),
            /base|mismatch|invalid|delta/i,
        )
        const baseCheckpoint = await readHousekeepingCheckpoint(sessionId, fixture.baseRef)
        assert.deepEqual(baseCheckpoint.draft, fixture.baseDraft)
    })
})

test("malformed delta change shapes are rejected", async (t) => {
    const corruptions: { name: string; changes: unknown }[] = [
        { name: "changes not an array", changes: "nope" },
        { name: "change not an object", changes: [null] },
        { name: "missing path", changes: [{ value: 1 }] },
        { name: "path not an array", changes: [{ path: "prune.tools.read", value: 1 }] },
        {
            name: "non-string path segment",
            changes: [{ path: ["prune", "tools", 4], value: 1 }],
        },
        {
            name: "both value and remove",
            changes: [{ path: ["prune", "tools", "read"], value: 1, remove: true }],
        },
        {
            name: "remove not true",
            changes: [{ path: ["prune", "tools", "read"], remove: false }],
        },
        { name: "neither value nor remove", changes: [{ path: ["prune", "tools", "read"] }] },
        { name: "empty path", changes: [{ path: [], value: 1 }] },
    ]

    for (const corruption of corruptions) {
        await t.test(corruption.name, async () => {
            const sessionId = `ses_delta_bad_shape_${corruption.name.replace(/\W+/g, "_")}`
            const fixture = await createDeltaFixture(sessionId)
            const envelope = await readDeltaEnvelope(sessionId, fixture.deltaRef.snapshotId)
            envelope.changes = corruption.changes
            await writeDeltaFile(sessionId, fixture.deltaRef.snapshotId, envelope)
            await assert.rejects(
                readHousekeepingCheckpoint(sessionId, fixture.deltaRef),
                /invalid|change|delta|path|ambiguous/i,
            )
            const baseCheckpoint = await readHousekeepingCheckpoint(sessionId, fixture.baseRef)
            assert.deepEqual(baseCheckpoint.draft, fixture.baseDraft)
            const changed = structuredClone(fixture.baseDraft)
            changed.stats.totalPruneTokens += 7
            const laterRef = await writeHousekeepingDelta(
                sessionId,
                fixture.baseRef,
                fixture.baseDraft,
                changed,
            )
            assert.deepEqual((await readHousekeepingCheckpoint(sessionId, laterRef)).draft, changed)
        })
    }
})

test("unsafe parent paths are rejected without changing prototypes", async (t) => {
    const unsafePaths = [
        ["__proto__", "polluted"],
        ["constructor", "prototype", "polluted"],
        ["prune", "tools", "__proto__", "polluted"],
        ["prune", "tools", "constructor", "prototype", "polluted"],
    ]

    for (const path of unsafePaths) {
        await t.test(path.join("."), async () => {
            const sessionId = `ses_delta_unsafe_${path.length}_${String(path.at(-2))}`
            const fixture = await createDeltaFixture(sessionId)
            const envelope = await readDeltaEnvelope(sessionId, fixture.deltaRef.snapshotId)
            envelope.changes = [{ path, value: "polluted" }]
            await writeDeltaFile(sessionId, fixture.deltaRef.snapshotId, envelope)
            await assert.rejects(
                readHousekeepingCheckpoint(sessionId, fixture.deltaRef),
                /invalid|unsafe|path|parent|prototype|change/i,
            )
            assert.equal(({} as any).polluted, undefined)
            assert.equal((Object.prototype as any).polluted, undefined)
            const baseCheckpoint = await readHousekeepingCheckpoint(sessionId, fixture.baseRef)
            assert.deepEqual(baseCheckpoint.draft, fixture.baseDraft)
        })
    }
})

test("own special JSON property names are applied safely by exact path", async () => {
    const sessionId = "ses_delta_special_keys"
    const baseDraft = createDraft()
    baseDraft.prune.tools = new Map([
        ["__proto__", 1],
        ["constructor", 2],
        ["slash/key", 3],
        ["dot.key", 4],
        ["null\0key", 5],
        ["toString", 6],
    ])
    baseDraft.prune.messages.byMessageId.set("__proto__", {
        tokenCount: 1,
        allBlockIds: [1],
        activeBlockIds: [],
    })
    const baseRef = asSnapshot(await writeHousekeepingDraft(sessionId, baseDraft))

    const changed = structuredClone(baseDraft)
    changed.prune.tools.set("__proto__", 11)
    changed.prune.tools.set("constructor", 12)
    changed.prune.tools.set("slash/key", 13)
    changed.prune.tools.set("null\0key", 15)
    changed.prune.tools.delete("dot.key")
    changed.prune.messages.byMessageId.set("__proto__", {
        tokenCount: 2,
        allBlockIds: [],
        activeBlockIds: [],
    })

    const deltaRef = await writeHousekeepingDelta(sessionId, baseRef, baseDraft, changed)
    const envelope = await readDeltaEnvelope(sessionId, deltaRef.snapshotId)
    const paths = envelope.changes.map((change: any) => change.path)
    assert.ok(
        paths.some(
            (path: string[]) =>
                path.length === 3 &&
                path[0] === "prune" &&
                path[1] === "tools" &&
                path[2] === "__proto__",
        ),
    )
    assert.ok(
        paths.some(
            (path: string[]) =>
                path.length === 3 &&
                path[0] === "prune" &&
                path[1] === "tools" &&
                path[2] === "dot.key",
        ),
    )
    assert.ok(paths.some((path: string[]) => path.includes("null\0key")))

    const checkpoint = await readHousekeepingCheckpoint(sessionId, deltaRef)
    assert.deepEqual(checkpoint.draft, changed)
    assert.deepEqual(checkpoint.base, baseDraft)
    assert.equal(checkpoint.draft.prune.tools.get("__proto__"), 11)
    assert.equal(checkpoint.draft.prune.tools.get("constructor"), 12)
    assert.equal(checkpoint.draft.prune.tools.has("dot.key"), false)
    assert.equal(checkpoint.draft.prune.tools.get("null\0key"), 15)
    assert.equal(checkpoint.draft.prune.messages.byMessageId.get("__proto__")!.tokenCount, 2)
    assert.equal(({} as any).polluted, undefined)
    assert.equal((Object.prototype as any).polluted, undefined)
})

test("delta write failures preserve prior payloads and return no successful ref", async (t) => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
        t.skip("permission failure requires a non-root process")
        return
    }
    const sessionId = "ses_delta_write_failure"
    const baseDraft = createDraft()
    const baseRef = asSnapshot(await writeHousekeepingDraft(sessionId, baseDraft))
    const firstDraft = structuredClone(baseDraft)
    firstDraft.stats.totalPruneTokens += 1
    const firstRef = await writeHousekeepingDelta(sessionId, baseRef, baseDraft, firstDraft)
    const dir = join(STORAGE_DIR, "housekeeping", encodeURIComponent(sessionId))
    const nextDraft = structuredClone(baseDraft)
    nextDraft.stats.totalPruneTokens += 2

    await chmod(dir, 0o500)
    try {
        await assert.rejects(
            writeHousekeepingDelta(sessionId, baseRef, baseDraft, nextDraft),
            /EACCES|permission/i,
        )
    } finally {
        await chmod(dir, 0o700)
    }

    assert.deepEqual((await readHousekeepingCheckpoint(sessionId, baseRef)).draft, baseDraft)
    assert.deepEqual((await readHousekeepingCheckpoint(sessionId, firstRef)).draft, firstDraft)
    const entries = await readdir(dir)
    assert.ok(entries.includes(`${baseRef.snapshotId}.json.gz`))
    assert.ok(entries.includes(`${firstRef.snapshotId}.delta.json`))
    assert.deepEqual(
        entries.filter((entry) => entry.endsWith(".tmp")),
        [],
    )
})

test("delta rename failures propagate, clean temps, and preserve prior payloads", async (t) => {
    const sessionId = "ses_delta_rename_failure"
    const baseDraft = createDraft()
    const baseRef = asSnapshot(await writeHousekeepingDraft(sessionId, baseDraft))
    const firstDraft = structuredClone(baseDraft)
    firstDraft.stats.totalPruneTokens += 1
    const firstRef = await writeHousekeepingDelta(sessionId, baseRef, baseDraft, firstDraft)

    const deltaId = "00000000-0000-4000-8000-000000000000"
    const originalRandomUUID = crypto.randomUUID
    crypto.randomUUID = () => deltaId
    syncBuiltinESMExports()
    t.after(() => {
        crypto.randomUUID = originalRandomUUID
        syncBuiltinESMExports()
    })

    const dir = join(STORAGE_DIR, "housekeeping", encodeURIComponent(sessionId))
    const finalPath = deltaPath(sessionId, deltaId)
    await mkdir(finalPath, { recursive: true })
    await writeFile(join(finalPath, "occupied"), "x", "utf-8")
    const nextDraft = structuredClone(baseDraft)
    nextDraft.stats.totalPruneTokens += 2

    try {
        await assert.rejects(
            writeHousekeepingDelta(sessionId, baseRef, baseDraft, nextDraft),
            /EISDIR|ENOTEMPTY|rename/i,
        )
        const entries = await readdir(dir)
        assert.ok(entries.includes(`${baseRef.snapshotId}.json.gz`))
        assert.ok(entries.includes(`${firstRef.snapshotId}.delta.json`))
        assert.ok(entries.includes(`${deltaId}.delta.json`))
        assert.deepEqual(
            entries.filter((entry) => entry.endsWith(".tmp")),
            [],
        )
        assert.deepEqual(await readdir(finalPath), ["occupied"])
        assert.deepEqual((await readHousekeepingCheckpoint(sessionId, baseRef)).draft, baseDraft)
        assert.deepEqual((await readHousekeepingCheckpoint(sessionId, firstRef)).draft, firstDraft)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
})
