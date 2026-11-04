import * as fs from "fs/promises"
import { randomUUID } from "crypto"
import { gzip, gunzip } from "zlib"
import { promisify } from "util"
import { join } from "path"
import { STORAGE_DIR } from "../paths"
import type {
    HousekeepingDeltaRef,
    HousekeepingDraft,
    HousekeepingDraftRef,
    HousekeepingSnapshotRef,
} from "./types"
import {
    isRecord,
    restoreHousekeepingDraft,
    serializeHousekeepingDraft,
    validateHousekeepingDraftPayload,
} from "./housekeeping-draft-codec"
import { applyDeltaChanges, diffJsonValues, type DeltaEnvelope } from "./housekeeping-draft-delta"

const HOUSEKEEPING_DIR = join(STORAGE_DIR, "housekeeping")
const SNAPSHOT_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

export interface HousekeepingCheckpoint {
    baseRef: HousekeepingSnapshotRef
    base: HousekeepingDraft
    draft: HousekeepingDraft
}

function sessionDirectory(sessionId: string): string {
    if (typeof sessionId !== "string" || sessionId.length === 0)
        throw new Error("Housekeeping draft session ID must not be empty.")
    if (sessionId === "." || sessionId === "..")
        throw new Error("Housekeeping draft session ID must not contain dot or dotdot components.")
    return join(HOUSEKEEPING_DIR, encodeURIComponent(sessionId))
}

export function isHousekeepingRefId(value: unknown): value is string {
    return typeof value === "string" && SNAPSHOT_ID_PATTERN.test(value)
}

function snapshotRefFrom(ref: unknown): HousekeepingSnapshotRef {
    if (!isRecord(ref) || ref.kind !== "snapshot" || !isHousekeepingRefId(ref.snapshotId))
        throw new Error(
            "Invalid housekeeping draft base reference: a snapshot reference is required.",
        )
    return { kind: "snapshot", snapshotId: ref.snapshotId }
}

function checkpointRefFrom(ref: unknown): HousekeepingDraftRef {
    if (!isRecord(ref) || typeof ref.kind !== "string")
        throw new Error("Invalid housekeeping draft reference: missing reference kind.")
    if (ref.kind === "snapshot") {
        if (!isHousekeepingRefId(ref.snapshotId))
            throw new Error("Invalid housekeeping draft snapshot reference.")
        return { kind: "snapshot", snapshotId: ref.snapshotId }
    }
    if (ref.kind === "delta") {
        if (!isHousekeepingRefId(ref.snapshotId) || !isHousekeepingRefId(ref.baseSnapshotId))
            throw new Error("Invalid housekeeping draft delta reference.")
        return {
            kind: "delta",
            snapshotId: ref.snapshotId,
            baseSnapshotId: ref.baseSnapshotId,
        }
    }
    throw new Error(`Invalid housekeeping draft reference kind ${JSON.stringify(ref.kind)}.`)
}

function snapshotPath(sessionId: string, snapshotId: string): string {
    return join(sessionDirectory(sessionId), `${snapshotId}.json.gz`)
}

function deltaPath(sessionId: string, snapshotId: string): string {
    return join(sessionDirectory(sessionId), `${snapshotId}.delta.json`)
}

function hasCode(error: unknown, code: string): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === code
    )
}

async function writeAtomicFile(finalPath: string, data: string | Buffer): Promise<void> {
    const temporaryPath = `${finalPath}.${randomUUID()}.tmp`
    try {
        await fs.writeFile(temporaryPath, data)
        await fs.rename(temporaryPath, finalPath)
    } catch (error) {
        try {
            await fs.rm(temporaryPath, { force: true })
        } catch (cleanupError) {
            if (error instanceof Error && cleanupError instanceof Error && !error.cause)
                error.cause = cleanupError
        }
        throw error
    }
}

async function readPayloadFile(
    filePath: string,
    missingMessage: string,
    failedMessage: string,
): Promise<Buffer> {
    try {
        return await fs.readFile(filePath)
    } catch (error) {
        if (hasCode(error, "ENOENT")) throw new Error(missingMessage, { cause: error })
        throw new Error(failedMessage, { cause: error })
    }
}

async function readSnapshotPayload(sessionId: string, snapshotId: string): Promise<unknown> {
    const filePath = snapshotPath(sessionId, snapshotId)
    const content = await readPayloadFile(
        filePath,
        `Housekeeping draft snapshot ${snapshotId} for session ${sessionId} was not found.`,
        `Failed to read housekeeping draft snapshot ${snapshotId} for session ${sessionId}.`,
    )

    let decompressed: string
    try {
        decompressed = (await gunzipAsync(content)).toString("utf-8")
    } catch (error) {
        throw new Error(
            `Malformed compressed JSON in housekeeping draft snapshot ${snapshotId} for session ${sessionId}.`,
            { cause: error },
        )
    }

    try {
        return JSON.parse(decompressed)
    } catch (error) {
        throw new Error(
            `Malformed JSON in housekeeping draft snapshot ${snapshotId} for session ${sessionId}.`,
            { cause: error },
        )
    }
}

async function readDeltaEnvelope(sessionId: string, deltaId: string): Promise<unknown> {
    const filePath = deltaPath(sessionId, deltaId)
    const content = await readPayloadFile(
        filePath,
        `Housekeeping draft delta ${deltaId} for session ${sessionId} was not found.`,
        `Failed to read housekeeping draft delta ${deltaId} for session ${sessionId}.`,
    )
    try {
        return JSON.parse(content.toString("utf-8"))
    } catch (error) {
        throw new Error(
            `Malformed JSON in housekeeping draft delta ${deltaId} for session ${sessionId}.`,
            { cause: error },
        )
    }
}

function restorePayload(value: unknown, invalidMessage: string): HousekeepingDraft {
    let draft: HousekeepingDraft | null
    try {
        validateHousekeepingDraftPayload(value)
        draft = restoreHousekeepingDraft(value)
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`${invalidMessage} ${detail}`, { cause: error })
    }
    if (!draft) throw new Error(`${invalidMessage} draft payload is invalid.`)
    return draft
}

export async function writeHousekeepingDraft(
    sessionId: string,
    draft: HousekeepingDraft,
): Promise<HousekeepingSnapshotRef> {
    const directory = sessionDirectory(sessionId)
    const snapshotId = randomUUID()
    const finalPath = join(directory, `${snapshotId}.json.gz`)
    const serialized = serializeHousekeepingDraft(draft)
    const compressed = await gzipAsync(Buffer.from(JSON.stringify(serialized), "utf-8"))

    await fs.mkdir(directory, { recursive: true })
    await writeAtomicFile(finalPath, compressed)

    return { kind: "snapshot", snapshotId }
}

export async function writeHousekeepingDelta(
    sessionId: string,
    baseRef: HousekeepingSnapshotRef,
    baseDraft: HousekeepingDraft,
    draft: HousekeepingDraft,
): Promise<HousekeepingDeltaRef> {
    const snapshot = snapshotRefFrom(baseRef)
    const directory = sessionDirectory(sessionId)
    const deltaId = randomUUID()
    const finalPath = join(directory, `${deltaId}.delta.json`)
    const envelope: DeltaEnvelope = {
        baseSnapshotId: snapshot.snapshotId,
        changes: diffJsonValues(
            serializeHousekeepingDraft(baseDraft),
            serializeHousekeepingDraft(draft),
        ),
    }

    await fs.mkdir(directory, { recursive: true })
    await writeAtomicFile(finalPath, JSON.stringify(envelope))

    return {
        kind: "delta",
        snapshotId: deltaId,
        baseSnapshotId: snapshot.snapshotId,
    }
}

export async function readHousekeepingCheckpoint(
    sessionId: string,
    ref: HousekeepingDraftRef,
): Promise<HousekeepingCheckpoint> {
    const checkpoint = checkpointRefFrom(ref)
    if (checkpoint.kind === "snapshot") {
        const payload = await readSnapshotPayload(sessionId, checkpoint.snapshotId)
        const invalidMessage = `Invalid draft payload in housekeeping draft snapshot ${checkpoint.snapshotId} for session ${sessionId}.`
        const base = restorePayload(payload, invalidMessage)
        const draft = structuredClone(base)
        return { baseRef: { ...checkpoint }, base, draft }
    }

    const basePayload = await readSnapshotPayload(sessionId, checkpoint.baseSnapshotId)
    const envelope = await readDeltaEnvelope(sessionId, checkpoint.snapshotId)
    if (!isRecord(envelope) || typeof envelope.baseSnapshotId !== "string")
        throw new Error(
            `Invalid housekeeping draft delta ${checkpoint.snapshotId} for session ${sessionId}: envelope is malformed.`,
        )
    if (envelope.baseSnapshotId !== checkpoint.baseSnapshotId)
        throw new Error(
            `Invalid housekeeping draft delta ${checkpoint.snapshotId} for session ${sessionId}: base snapshot ${envelope.baseSnapshotId} does not match ${checkpoint.baseSnapshotId}.`,
        )

    const baseInvalidMessage = `Invalid draft payload in housekeeping draft snapshot ${checkpoint.baseSnapshotId} for session ${sessionId}.`
    const deltaInvalidMessage = `Invalid draft payload in housekeeping draft delta ${checkpoint.snapshotId} for session ${sessionId}.`
    const base = restorePayload(basePayload, baseInvalidMessage)

    let draftPayload: unknown
    try {
        draftPayload = applyDeltaChanges(basePayload, envelope.changes)
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(
            `Invalid housekeeping draft delta ${checkpoint.snapshotId} for session ${sessionId}: ${detail}`,
            { cause: error },
        )
    }
    const draft = restorePayload(draftPayload, deltaInvalidMessage)

    return {
        baseRef: { kind: "snapshot", snapshotId: checkpoint.baseSnapshotId },
        base,
        draft,
    }
}

export async function readHousekeepingDraft(
    sessionId: string,
    ref: HousekeepingDraftRef,
): Promise<HousekeepingDraft> {
    const checkpoint = await readHousekeepingCheckpoint(sessionId, ref)
    return checkpoint.draft
}
