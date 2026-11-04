import "./helpers/storage-env"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import test from "node:test"
import { gunzipSync, gzipSync } from "node:zlib"
import { cloneDraft, publishDraft } from "../lib/housekeeping/state"
import { Logger } from "../lib/logger"
import { STORAGE_DIR, getSessionFilePath } from "../lib/paths"
import {
    createSessionState,
    ensureSessionInitialized,
    resetSessionState,
    type SessionState,
} from "../lib/state"
import {
    readHousekeepingDraft,
    writeHousekeepingDelta,
    writeHousekeepingDraft,
} from "../lib/state/housekeeping-draft-store"
import { saveSessionStateStrict } from "../lib/state/persistence"

interface SkillContext {
    name: string
    callId: string
    input: Record<string, unknown>
    title: string
    output: string
    metadata: Record<string, unknown>
}

const logger = new Logger(false)

function skillRecord(name: string): SkillContext {
    return {
        name,
        callId: `call-${name}`,
        input: {
            arguments: { nested: { value: name }, entries: [name] },
        },
        title: `Skill ${name}`,
        output: `output-${name}`,
        metadata: {
            nested: { name },
            entries: [{ name }],
        },
    }
}

function skillState(state: SessionState): {
    loadedSkills: SkillContext[]
    protectedSkills: SkillContext[]
} {
    return state as unknown as {
        loadedSkills: SkillContext[]
        protectedSkills: SkillContext[]
    }
}

function draftWithSkills(state: SessionState, protectedSkills: SkillContext[]): any {
    const draft = cloneDraft(state) as any
    draft.protectedSkills = structuredClone(protectedSkills)
    return draft
}

function initClient(): any {
    return {
        session: {
            get: async () => ({ data: {} }),
        },
    }
}

async function restoreSession(sessionId: string): Promise<SessionState> {
    const state = createSessionState()
    await ensureSessionInitialized(initClient(), state, sessionId, logger, [], false)
    return state
}

function snapshotPath(sessionId: string, snapshotId: string): string {
    return join(STORAGE_DIR, "housekeeping", encodeURIComponent(sessionId), `${snapshotId}.json.gz`)
}

async function writeRawSnapshot(
    sessionId: string,
    snapshotId: string,
    payload: unknown,
): Promise<void> {
    await mkdir(dirname(snapshotPath(sessionId, snapshotId)), { recursive: true })
    await writeFile(
        snapshotPath(sessionId, snapshotId),
        gzipSync(Buffer.from(JSON.stringify(payload), "utf-8")),
    )
}

async function readRawSnapshot(sessionId: string, snapshotId: string): Promise<any> {
    return JSON.parse(
        gunzipSync(await readFile(snapshotPath(sessionId, snapshotId))).toString("utf-8"),
    )
}

function persistedFixture(): Record<string, any> {
    return {
        prune: {
            tools: {},
            messages: {
                byMessageId: {},
                blocksById: {},
                activeBlockIds: [],
                activeByAnchorMessageId: {},
                nextBlockId: 1,
                nextRunId: 1,
            },
        },
        nudges: { contextLimitAnchors: [] },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
        lastUpdated: new Date(0).toISOString(),
    }
}

async function writePersistedFixture(
    sessionId: string,
    fixture: Record<string, unknown>,
): Promise<void> {
    const filePath = getSessionFilePath(sessionId)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(fixture), "utf-8")
}

test("createSessionState starts with independent empty skill lists", () => {
    const state = createSessionState()
    const skills = skillState(state)

    assert.deepEqual(skills.loadedSkills, [])
    assert.deepEqual(skills.protectedSkills, [])
    assert.notEqual(skills.loadedSkills, skills.protectedSkills)
})

test("resetSessionState clears both skill lists", () => {
    const state = createSessionState()
    const skills = skillState(state)
    skills.loadedSkills = [skillRecord("loaded")]
    skills.protectedSkills = [skillRecord("protected")]

    resetSessionState(state)

    assert.deepEqual(skillState(state).loadedSkills, [])
    assert.deepEqual(skillState(state).protectedSkills, [])
})

test("independently different loaded and protected records survive restart", async () => {
    const sessionId = `ses_skill_persist_${randomUUID()}`
    const state = createSessionState()
    state.sessionId = sessionId
    const skills = skillState(state)
    skills.loadedSkills = [skillRecord("loaded-one"), skillRecord("loaded-two")]
    skills.protectedSkills = [skillRecord("protected-one")]

    await saveSessionStateStrict(state, logger)
    const reloaded = await restoreSession(sessionId)

    assert.deepEqual(skillState(reloaded).loadedSkills, skills.loadedSkills)
    assert.deepEqual(skillState(reloaded).protectedSkills, skills.protectedSkills)
    assert.equal(skillState(reloaded).loadedSkills[0]?.name, "loaded-one")
    assert.equal(skillState(reloaded).protectedSkills[0]?.name, "protected-one")
})

test("each absent persisted skill list starts empty instead of being backfilled", async (t) => {
    const loaded = skillRecord("historical-loaded")
    const protectedSkill = skillRecord("historical-protected")
    const cases: Array<{
        name: string
        patch: (fixture: Record<string, any>) => void
        loaded: SkillContext[]
        protected: SkillContext[]
    }> = [
        {
            name: "both lists absent",
            patch: () => {},
            loaded: [],
            protected: [],
        },
        {
            name: "only loaded list present",
            patch: (fixture) => {
                fixture.loadedSkills = [loaded]
            },
            loaded: [loaded],
            protected: [],
        },
        {
            name: "only protected list present",
            patch: (fixture) => {
                fixture.protectedSkills = [protectedSkill]
            },
            loaded: [],
            protected: [protectedSkill],
        },
    ]

    for (const entry of cases) {
        await t.test(entry.name, async () => {
            const sessionId = `ses_skill_absent_${randomUUID()}`
            const fixture = persistedFixture()
            entry.patch(fixture)
            await writePersistedFixture(sessionId, fixture)

            const restored = await restoreSession(sessionId)

            assert.deepEqual(skillState(restored).loadedSkills, entry.loaded)
            assert.deepEqual(skillState(restored).protectedSkills, entry.protected)
        })
    }
})

test("cloneDraft deep-clones protected records and carries no loaded status", () => {
    const state = createSessionState()
    const skills = skillState(state)
    const protectedRecord = skillRecord("protected")
    skills.loadedSkills = [skillRecord("loaded")]
    skills.protectedSkills = [protectedRecord]

    const draft = cloneDraft(state) as any

    assert.deepEqual(draft.protectedSkills, [protectedRecord])
    assert.notEqual(draft.protectedSkills, skills.protectedSkills)
    assert.notEqual(draft.protectedSkills[0], protectedRecord)
    assert.notEqual(draft.protectedSkills[0].input, protectedRecord.input)
    assert.notEqual(draft.protectedSkills[0].metadata, protectedRecord.metadata)
    assert.equal(Object.hasOwn(draft, "loadedSkills"), false)

    protectedRecord.input.arguments = { nested: { value: "mutated" } }
    protectedRecord.metadata.nested = { name: "mutated" }
    skills.protectedSkills.push(skillRecord("later"))

    assert.equal(draft.protectedSkills.length, 1)
    assert.deepEqual(draft.protectedSkills[0].input, {
        arguments: { nested: { value: "protected" }, entries: ["protected"] },
    })
    assert.deepEqual(draft.protectedSkills[0].metadata, {
        nested: { name: "protected" },
        entries: [{ name: "protected" }],
    })
})

test("publishDraft replaces protected skills without changing loaded status", () => {
    const state = createSessionState()
    const skills = skillState(state)
    const loadedRecord = skillRecord("loaded")
    skills.loadedSkills = [loadedRecord]
    skills.protectedSkills = [skillRecord("old-protected")]

    const draft = draftWithSkills(state, [skillRecord("new-protected")])
    publishDraft(state, draft)

    assert.deepEqual(skillState(state).loadedSkills, [loadedRecord])
    assert.equal(skillState(state).loadedSkills[0], loadedRecord)
    assert.deepEqual(skillState(state).protectedSkills, [skillRecord("new-protected")])
    assert.notEqual(skillState(state).protectedSkills, draft.protectedSkills)
    assert.notEqual(skillState(state).protectedSkills[0], draft.protectedSkills[0])
    assert.notEqual(skillState(state).protectedSkills[0].input, draft.protectedSkills[0].input)

    draft.protectedSkills[0].input.arguments = { nested: { value: "mutated" } }
    draft.protectedSkills[0].metadata.nested = { name: "mutated" }
    draft.protectedSkills.push(skillRecord("later"))

    assert.deepEqual(skillState(state).protectedSkills, [skillRecord("new-protected")])
})

test("draft snapshots and deltas preserve protected skills and omit loaded status", async () => {
    const sessionId = `ses_skill_draft_${randomUUID()}`
    const state = createSessionState()
    const protectedOne = skillRecord("protected-one")
    const protectedTwo = skillRecord("protected-two")
    skillState(state).loadedSkills = [skillRecord("loaded")]
    skillState(state).protectedSkills = [protectedOne]

    const base = draftWithSkills(state, [protectedOne])
    const baseRef = await writeHousekeepingDraft(sessionId, base)
    const baseRead = (await readHousekeepingDraft(sessionId, baseRef)) as any

    assert.deepEqual(baseRead.protectedSkills, [protectedOne])
    assert.equal(Object.hasOwn(baseRead, "loadedSkills"), false)

    base.protectedSkills[0].input.arguments = { nested: { value: "mutated-base" } }
    base.protectedSkills.push(skillRecord("mutated-base"))
    const baseReread = (await readHousekeepingDraft(sessionId, baseRef)) as any
    assert.deepEqual(baseReread.protectedSkills, [protectedOne])

    const changed = draftWithSkills(state, [protectedOne, protectedTwo])
    const deltaRef = await writeHousekeepingDelta(sessionId, baseRef, baseReread, changed)
    assert.equal(deltaRef.kind, "delta")
    const deltaRead = (await readHousekeepingDraft(sessionId, deltaRef)) as any

    assert.deepEqual(deltaRead.protectedSkills, [protectedOne, protectedTwo])
    assert.equal(Object.hasOwn(deltaRead, "loadedSkills"), false)

    changed.protectedSkills[0].input.arguments = { nested: { value: "mutated-delta" } }
    changed.protectedSkills[1].metadata.nested = { name: "mutated-delta" }
    changed.protectedSkills.push(skillRecord("mutated-delta"))
    const deltaReread = (await readHousekeepingDraft(sessionId, deltaRef)) as any
    assert.deepEqual(deltaReread.protectedSkills, [protectedOne, protectedTwo])
})

test("an older draft snapshot without protectedSkills restores the list as empty", async () => {
    const sessionId = `ses_skill_legacy_draft_${randomUUID()}`
    const state = createSessionState()
    state.sessionId = sessionId
    skillState(state).protectedSkills = [skillRecord("protected")]

    const ref = await writeHousekeepingDraft(
        sessionId,
        draftWithSkills(state, [skillRecord("protected")]),
    )
    const oldPayload = await readRawSnapshot(sessionId, ref.snapshotId)
    delete oldPayload.protectedSkills
    const oldSnapshotId = randomUUID()
    await writeRawSnapshot(sessionId, oldSnapshotId, oldPayload)
    const originalBytes = await readFile(snapshotPath(sessionId, oldSnapshotId))

    const restored = (await readHousekeepingDraft(sessionId, {
        kind: "snapshot",
        snapshotId: oldSnapshotId,
    } as any)) as any

    assert.deepEqual(restored.protectedSkills, [])
    assert.equal(Object.hasOwn(restored, "loadedSkills"), false)
    assert.deepEqual(await readFile(snapshotPath(sessionId, oldSnapshotId)), originalBytes)
})

test("corrupt present protectedSkills in a draft snapshot rejects instead of defaulting", async (t) => {
    const sessionId = `ses_skill_corrupt_draft_${randomUUID()}`
    const state = createSessionState()
    state.sessionId = sessionId
    const valid = skillRecord("protected")
    const ref = await writeHousekeepingDraft(sessionId, draftWithSkills(state, [valid]))
    const basePayload = await readRawSnapshot(sessionId, ref.snapshotId)

    const corruptions: Array<{ name: string; corrupt: (payload: any) => void }> = [
        {
            name: "list is not an array",
            corrupt: (payload) => {
                payload.protectedSkills = "protected"
            },
        },
        {
            name: "entry is null",
            corrupt: (payload) => {
                payload.protectedSkills = [null]
            },
        },
        {
            name: "record is missing required fields",
            corrupt: (payload) => {
                payload.protectedSkills = [{ name: "protected" }]
            },
        },
        {
            name: "record name is not a string",
            corrupt: (payload) => {
                payload.protectedSkills = [{ ...valid, name: 1 }]
            },
        },
        {
            name: "record input is not an object",
            corrupt: (payload) => {
                payload.protectedSkills = [{ ...valid, input: "arguments" }]
            },
        },
        {
            name: "record metadata is not an object",
            corrupt: (payload) => {
                payload.protectedSkills = [{ ...valid, metadata: [] }]
            },
        },
        {
            name: "record output is not a string",
            corrupt: (payload) => {
                payload.protectedSkills = [{ ...valid, output: { text: "output" } }]
            },
        },
    ]

    for (const corruption of corruptions) {
        await t.test(corruption.name, async () => {
            const payload = structuredClone(basePayload)
            corruption.corrupt(payload)
            const snapshotId = randomUUID()
            await writeRawSnapshot(sessionId, snapshotId, payload)

            await assert.rejects(
                readHousekeepingDraft(sessionId, { kind: "snapshot", snapshotId } as any),
                (error: unknown) => {
                    assert.ok(error instanceof Error)
                    assert.match(error.message, /skill|protected|invalid|draft/i)
                    return true
                },
            )
        })
    }
})

test("corrupt present skill lists or records in persisted state reject restore", async (t) => {
    const valid = skillRecord("persisted")
    const corruptions: Array<{ name: string; patch: (fixture: Record<string, any>) => void }> = [
        {
            name: "loadedSkills is not an array",
            patch: (fixture) => {
                fixture.loadedSkills = { name: "loaded" }
            },
        },
        {
            name: "protectedSkills is not an array",
            patch: (fixture) => {
                fixture.protectedSkills = "protected"
            },
        },
        {
            name: "loadedSkills entry is null",
            patch: (fixture) => {
                fixture.loadedSkills = [null]
            },
        },
        {
            name: "loadedSkills record is missing required fields",
            patch: (fixture) => {
                fixture.loadedSkills = [{ name: "loaded" }]
            },
        },
        {
            name: "protectedSkills record name is not a string",
            patch: (fixture) => {
                fixture.protectedSkills = [{ ...valid, name: 1 }]
            },
        },
        {
            name: "protectedSkills record input is not an object",
            patch: (fixture) => {
                fixture.protectedSkills = [{ ...valid, input: "arguments" }]
            },
        },
        {
            name: "protectedSkills record metadata is not an object",
            patch: (fixture) => {
                fixture.protectedSkills = [{ ...valid, metadata: [] }]
            },
        },
    ]

    for (const corruption of corruptions) {
        await t.test(corruption.name, async () => {
            const sessionId = `ses_skill_corrupt_state_${randomUUID()}`
            const fixture = persistedFixture()
            corruption.patch(fixture)
            await writePersistedFixture(sessionId, fixture)

            await assert.rejects(restoreSession(sessionId), (error: unknown) => {
                assert.ok(error instanceof Error)
                assert.match(error.message, /skill|protected|loaded|invalid|state|metadata/i)
                return true
            })
        })
    }
})
