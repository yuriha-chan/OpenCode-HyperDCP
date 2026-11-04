import assert from "node:assert/strict"
import test from "node:test"
import { projectHousekeepingHistory } from "../lib/housekeeping/history"
import type { HousekeepingOperation, HousekeepingTransaction, WithParts } from "../lib/state"

type Part = WithParts["parts"][number]
type Edit = { output: string; title: string }

const sessionID = "ses_housekeeping_history"
const EMPTY_ENTRY_PLACEHOLDER = "details truncated."
const ENTRY_TITLE = "Housekeeping entry"
const LEAVE_TITLE = "Housekeeping receipt"

function textPart(
    messageID: string,
    id: string,
    text: string,
    extra: Record<string, unknown> = {},
): Part {
    return {
        id,
        messageID,
        sessionID,
        type: "text",
        text,
        ...extra,
    } as unknown as Part
}

function toolPart(
    messageID: string,
    id: string,
    callID: string,
    options: {
        tool?: string
        status?: "pending" | "running" | "completed" | "error"
        output?: string
        title?: string
    } = {},
): Part {
    const status = options.status ?? "completed"
    const state =
        status === "completed"
            ? {
                  status,
                  input: {},
                  output: options.output ?? `raw-output-${id}`,
                  title: options.title ?? `raw-title-${id}`,
                  metadata: {},
                  time: { start: 1, end: 2 },
              }
            : status === "error"
              ? { status, input: {}, error: "raw-error", time: { start: 1, end: 2 } }
              : { status, input: {}, time: { start: 1 } }
    return {
        id,
        messageID,
        sessionID,
        type: "tool",
        tool: options.tool ?? "enter_housekeeping",
        callID,
        state,
    } as unknown as Part
}

function message(id: string, parts: Part[]): WithParts {
    return {
        info: {
            id,
            sessionID,
            role: "assistant",
            agent: "assistant",
            model: { providerID: "test", modelID: "test" },
            time: { created: 1 },
        } as WithParts["info"],
        parts,
    }
}

function operation(
    messageId: string,
    partId: string | null,
    callId: string,
    tool = "read",
): HousekeepingOperation {
    return { messageId, partId, callId, tool, input: {}, result: "ok" }
}

function snapshotRef(snapshotId: string): HousekeepingTransaction["baseRef"] {
    return { kind: "snapshot", snapshotId }
}

function transaction(overrides: Partial<HousekeepingTransaction> = {}): HousekeepingTransaction {
    return {
        id: "transaction-1",
        sessionId: sessionID,
        entryMessageId: "missing-entry",
        entryPartId: null,
        entryCallId: "missing-entry-call",
        entryCreatedAt: 1,
        sourceParts: [],
        baseRevision: 0,
        baseRef: snapshotRef("base-snapshot"),
        draftRef: snapshotRef("draft-snapshot"),
        operations: {},
        operationResults: {},
        operationRecords: [],
        operationOrder: [],
        operationDraftRefs: {},
        ...overrides,
    }
}

function completed(
    leaveMessageId: string,
    leaveCallId: string,
    leavePartId: string | null,
    receipt: string,
    overrides: Partial<HousekeepingTransaction> = {},
): HousekeepingTransaction {
    return transaction({
        completed: {
            leaveMessageId,
            leaveCallId,
            leavePartId,
            receipt,
            commitRevision: 1,
            committedDraftRef: snapshotRef("committed-snapshot"),
        },
        ...overrides,
    })
}

function outputOf(part: Part | undefined): string | undefined {
    return part?.type === "tool" && part.state.status === "completed"
        ? part.state.output
        : undefined
}

function titleOf(part: Part | undefined): string | undefined {
    return part?.type === "tool" && part.state.status === "completed" ? part.state.title : undefined
}

function referencePartMatches(
    message: WithParts,
    partIndex: number,
    messageId: string,
    callId: string,
    partId: string | null = null,
): boolean {
    const part = message.parts[partIndex]
    return (
        message.info.id === messageId &&
        part?.type === "tool" &&
        part.callID === callId &&
        (partId === null || part.id === partId)
    )
}

function referenceProject(
    messages: WithParts[],
    transactions: HousekeepingTransaction[],
): WithParts[] {
    const positions = new Map<string, number>()
    let position = 0
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
        for (let partIndex = 0; partIndex < messages[messageIndex].parts.length; partIndex++) {
            positions.set(`${messageIndex}:${partIndex}`, position++)
        }
    }
    const hidden = new Set<number>()
    const boundaryEdits = new Map<number, Edit>()
    for (const transaction of transactions) {
        let entryPosition: number | undefined
        let leavePosition: number | undefined
        let sourceBoundaryPosition: number | undefined
        const operationPositions: number[] = []
        messages.forEach((message, messageIndex) =>
            message.parts.forEach((part, partIndex) => {
                const current = positions.get(`${messageIndex}:${partIndex}`)
                if (
                    transaction.sourceParts.some(
                        (source) =>
                            source.messageId === message.info.id && source.partId === part.id,
                    )
                ) {
                    sourceBoundaryPosition = current
                }
                if (
                    referencePartMatches(
                        message,
                        partIndex,
                        transaction.entryMessageId,
                        transaction.entryCallId,
                        transaction.entryPartId,
                    )
                ) {
                    entryPosition = current
                    if (transaction.completed) {
                        boundaryEdits.set(current!, {
                            output: EMPTY_ENTRY_PLACEHOLDER,
                            title: ENTRY_TITLE,
                        })
                    }
                }
                if (
                    transaction.completed &&
                    referencePartMatches(
                        message,
                        partIndex,
                        transaction.completed!.leaveMessageId,
                        transaction.completed!.leaveCallId,
                        transaction.completed!.leavePartId,
                    )
                ) {
                    leavePosition = current
                    boundaryEdits.set(current!, {
                        output: transaction.completed!.receipt,
                        title: LEAVE_TITLE,
                    })
                }
                for (const record of transaction.operationRecords) {
                    if (
                        record.messageId === message.info.id &&
                        record.partId === part.id &&
                        part.type === "tool" &&
                        part.callID === record.callId
                    ) {
                        operationPositions.push(current!)
                    }
                }
            }),
        )
        if (entryPosition !== undefined && leavePosition !== undefined) {
            for (let current = entryPosition + 1; current < leavePosition; current++)
                hidden.add(current)
        } else if (entryPosition === undefined && sourceBoundaryPosition !== undefined) {
            const end = leavePosition ?? Math.max(sourceBoundaryPosition, ...operationPositions)
            if (end > sourceBoundaryPosition) {
                for (let current = sourceBoundaryPosition + 1; current < end; current++)
                    hidden.add(current)
            }
        }
    }
    position = 0
    const result: WithParts[] = []
    for (const message of messages) {
        const parts = message.parts.flatMap((part) => {
            const current = position++
            if (hidden.has(current)) return []
            const edit = boundaryEdits.get(current)
            if (edit && part.type === "tool" && part.state.status === "completed") {
                return [
                    { ...part, state: { ...part.state, output: edit.output, title: edit.title } },
                ]
            }
            return [part]
        })
        if (parts.length) result.push({ ...message, parts })
    }
    return result
}

test("completed transaction hides its interior and rewrites both boundaries", () => {
    const messages = [
        message("m0", [textPart("m0", "before", "before")]),
        message("m1", [toolPart("m1", "entry-part", "entry")]),
        message("m2", [textPart("m2", "inside", "inside")]),
        message("m3", [toolPart("m3", "inner", "inner")]),
        message("m4", [toolPart("m4", "leave-part", "leave")]),
        message("m5", [textPart("m5", "after", "after")]),
    ]
    const transactions = [
        completed("m4", "leave", "leave-part", "receipt", {
            entryMessageId: "m1",
            entryCallId: "entry",
            entryPartId: "entry-part",
            sourceParts: [{ messageId: "m0", partId: "before" }],
        }),
    ]

    const result = projectHousekeepingHistory(messages, transactions)

    assert.deepEqual(
        result.map((item) => item.info.id),
        ["m0", "m1", "m4", "m5"],
    )
    assert.equal(outputOf(result[1].parts[0]), EMPTY_ENTRY_PLACEHOLDER)
    assert.equal(titleOf(result[1].parts[0]), ENTRY_TITLE)
    assert.equal(outputOf(result[2].parts[0]), "receipt")
    assert.equal(titleOf(result[2].parts[0]), LEAVE_TITLE)
})

test("incomplete transaction leaves its working history visible", () => {
    const messages = [
        message("m0", [textPart("m0", "before", "before")]),
        message("m1", [toolPart("m1", "entry-part", "entry", { status: "running" })]),
        message("m2", [textPart("m2", "inside", "inside")]),
    ]
    const transactions = [
        transaction({
            entryMessageId: "m1",
            entryCallId: "entry",
            entryPartId: "entry-part",
            sourceParts: [{ messageId: "m0", partId: "before" }],
        }),
    ]

    const result = projectHousekeepingHistory(messages, transactions)

    assert.deepEqual(result, messages)
})

test("absent entry falls back from source through the last matching operation", () => {
    const messages = [
        message("m0", [textPart("m0", "source", "source")]),
        message("m1", [textPart("m1", "hidden", "hidden")]),
        message("m2", [toolPart("m2", "op-part", "op")]),
        message("m3", [textPart("m3", "after", "after")]),
    ]
    const transactions = [
        transaction({
            sourceParts: [{ messageId: "m0", partId: "source" }],
            operationRecords: [operation("m2", "op-part", "op")],
        }),
    ]

    const result = projectHousekeepingHistory(messages, transactions)

    assert.deepEqual(
        result.map((item) => item.info.id),
        ["m0", "m2", "m3"],
    )
})

test("absent entry fallback ends at a present leave boundary", () => {
    const messages = [
        message("m0", [textPart("m0", "source", "source")]),
        message("m1", [textPart("m1", "hidden", "hidden")]),
        message("m2", [toolPart("m2", "leave-part", "leave")]),
        message("m3", [textPart("m3", "after", "after")]),
    ]
    const transactions = [
        completed("m2", "leave", "leave-part", "receipt", {
            sourceParts: [{ messageId: "m0", partId: "source" }],
        }),
    ]

    const result = projectHousekeepingHistory(messages, transactions)

    assert.deepEqual(
        result.map((item) => item.info.id),
        ["m0", "m2", "m3"],
    )
    assert.equal(outputOf(result[1].parts[0]), "receipt")
})

test("overlapping transaction ranges form a union", () => {
    const messages = [
        message("m0", [toolPart("m0", "entry-1", "entry-1")]),
        message("m1", [textPart("m1", "one", "one")]),
        message("m2", [toolPart("m2", "entry-2", "entry-2")]),
        message("m3", [textPart("m3", "two", "two")]),
        message("m4", [toolPart("m4", "leave-1", "leave-1")]),
        message("m5", [textPart("m5", "three", "three")]),
        message("m6", [toolPart("m6", "leave-2", "leave-2")]),
    ]
    const transactions = [
        completed("m4", "leave-1", "leave-1", "receipt-1", {
            entryMessageId: "m0",
            entryCallId: "entry-1",
            entryPartId: "entry-1",
        }),
        completed("m6", "leave-2", "leave-2", "receipt-2", {
            entryMessageId: "m2",
            entryCallId: "entry-2",
            entryPartId: "entry-2",
        }),
    ]

    const result = projectHousekeepingHistory(messages, transactions)

    assert.deepEqual(
        result.map((item) => item.info.id),
        ["m0", "m6"],
    )
})

test("duplicate identities keep every matching edit and use the last boundary", () => {
    const messages = [
        message("dup", [toolPart("dup", "dup-part", "entry")]),
        message("dup", [toolPart("dup", "dup-part", "entry")]),
        message("done", [toolPart("done", "leave-part", "leave")]),
    ]
    const transactions = [
        completed("done", "leave", "leave-part", "receipt", {
            entryMessageId: "dup",
            entryCallId: "entry",
            entryPartId: "dup-part",
            sourceParts: [{ messageId: "dup", partId: "dup-part" }],
        }),
    ]

    const result = projectHousekeepingHistory(messages, transactions)

    assert.deepEqual(
        result.map((item) => item.info.id),
        ["dup", "dup", "done"],
    )
    assert.equal(outputOf(result[0].parts[0]), EMPTY_ENTRY_PLACEHOLDER)
    assert.equal(outputOf(result[1].parts[0]), EMPTY_ENTRY_PLACEHOLDER)
    assert.equal(outputOf(result[2].parts[0]), "receipt")
})

test("null part IDs are wildcards while non-null part IDs match exactly", () => {
    const messages = [
        message("m0", [toolPart("m0", "first", "shared"), toolPart("m0", "second", "shared")]),
        message("m1", [textPart("m1", "inside", "inside")]),
        message("m2", [toolPart("m2", "leave-part", "leave")]),
    ]

    const wildcard = projectHousekeepingHistory(messages, [
        completed("m2", "leave", "leave-part", "receipt", {
            entryMessageId: "m0",
            entryCallId: "shared",
            entryPartId: null,
        }),
    ])
    assert.deepEqual(
        wildcard.map((item) => item.info.id),
        ["m0", "m2"],
    )
    assert.equal(wildcard[0].parts.length, 2)
    assert.equal(outputOf(wildcard[0].parts[0]), EMPTY_ENTRY_PLACEHOLDER)
    assert.equal(outputOf(wildcard[0].parts[1]), EMPTY_ENTRY_PLACEHOLDER)

    const exact = projectHousekeepingHistory(messages, [
        completed("m2", "leave", "leave-part", "receipt", {
            entryMessageId: "m0",
            entryCallId: "shared",
            entryPartId: "first",
        }),
    ])
    assert.deepEqual(
        exact.map((item) => item.info.id),
        ["m0", "m2"],
    )
    assert.equal(exact[0].parts.length, 1)
    assert.equal(outputOf(exact[0].parts[0]), EMPTY_ENTRY_PLACEHOLDER)
})

test("operation fallback ignores non-tool parts but matches tool parts by identity", () => {
    const textOnly = [
        message("m0", [textPart("m0", "source", "source")]),
        message("m1", [textPart("m1", "op-part", "text", { callID: "op" })]),
    ]
    const textResult = projectHousekeepingHistory(textOnly, [
        transaction({
            sourceParts: [{ messageId: "m0", partId: "source" }],
            operationRecords: [operation("m1", "op-part", "op")],
        }),
    ])
    assert.deepEqual(
        textResult.map((item) => item.info.id),
        ["m0", "m1"],
    )

    const toolMatch = [
        message("m0", [textPart("m0", "source", "source")]),
        message("m1", [textPart("m1", "hidden", "hidden")]),
        message("m2", [toolPart("m2", "op-part", "op", { tool: "bash" })]),
    ]
    const toolResult = projectHousekeepingHistory(toolMatch, [
        transaction({
            sourceParts: [{ messageId: "m0", partId: "source" }],
            operationRecords: [operation("m2", "op-part", "op", "command:unrelated")],
        }),
    ])
    assert.deepEqual(
        toolResult.map((item) => item.info.id),
        ["m0", "m2"],
    )
})

test("later transactions and leave edits overwrite earlier boundary edits", () => {
    const messages = [
        message("m0", [toolPart("m0", "shared-part", "shared")]),
        message("m1", [toolPart("m1", "first-leave", "first-leave")]),
    ]
    const transactions = [
        completed("m1", "first-leave", "first-leave", "first-receipt", {
            id: "first",
            entryMessageId: "m0",
            entryCallId: "shared",
            entryPartId: "shared-part",
        }),
        completed("m0", "shared", "shared-part", "second-receipt", {
            id: "second",
            entryMessageId: "missing",
            entryCallId: "missing",
            entryPartId: null,
        }),
    ]

    const result = projectHousekeepingHistory(messages, transactions)

    assert.equal(outputOf(result[0].parts[0]), "second-receipt")
    assert.equal(titleOf(result[0].parts[0]), LEAVE_TITLE)

    const samePosition = projectHousekeepingHistory(messages.slice(0, 1), [
        completed("m0", "shared", "shared-part", "leave-wins", {
            entryMessageId: "m0",
            entryCallId: "shared",
            entryPartId: "shared-part",
        }),
    ])
    assert.equal(outputOf(samePosition[0].parts[0]), "leave-wins")
})

test("non-completed boundary tools keep their original output", () => {
    const messages = [
        message("m0", [
            toolPart("m0", "entry-part", "entry", { status: "running", output: "raw-entry" }),
        ]),
        message("m1", [toolPart("m1", "leave-part", "leave", { output: "raw-leave" })]),
    ]
    const transactions = [
        completed("m1", "leave", "leave-part", "receipt", {
            entryMessageId: "m0",
            entryCallId: "entry",
            entryPartId: "entry-part",
        }),
    ]

    const result = projectHousekeepingHistory(messages, transactions)

    assert.equal(outputOf(result[0].parts[0]), undefined)
    assert.equal(
        result[0].parts[0].type === "tool" ? result[0].parts[0].state.status : undefined,
        "running",
    )
    assert.equal(outputOf(result[1].parts[0]), "receipt")
})

test("empty messages and messages losing every part are dropped", () => {
    const messages = [
        message("empty", []),
        message("m0", [textPart("m0", "before", "before")]),
        message("m1", [toolPart("m1", "entry-part", "entry")]),
        message("m2", [textPart("m2", "inside", "inside")]),
        message("m3", [toolPart("m3", "leave-part", "leave")]),
    ]
    const transactions = [
        completed("m3", "leave", "leave-part", "receipt", {
            entryMessageId: "m1",
            entryCallId: "entry",
            entryPartId: "entry-part",
        }),
    ]

    const result = projectHousekeepingHistory(messages, transactions)

    assert.deepEqual(
        result.map((item) => item.info.id),
        ["m0", "m1", "m3"],
    )
})

test("input messages and parts are not mutated", () => {
    const messages = [
        message("m0", [textPart("m0", "before", "before")]),
        message("m1", [
            toolPart("m1", "entry-part", "entry", {
                output: "raw-entry",
                title: "raw-entry-title",
            }),
        ]),
        message("m2", [textPart("m2", "inside", "inside")]),
        message("m3", [toolPart("m3", "leave-part", "leave")]),
    ]
    const transactions = [
        completed("m3", "leave", "leave-part", "receipt", {
            entryMessageId: "m1",
            entryCallId: "entry",
            entryPartId: "entry-part",
        }),
    ]
    const snapshot = structuredClone(messages)

    projectHousekeepingHistory(messages, transactions)

    assert.deepEqual(messages, snapshot)
})

test("completed entry placeholder counts mixed operations in fixed category order", () => {
    const messages = [
        message("m0", [toolPart("m0", "entry-part", "entry")]),
        message("m1", [textPart("m1", "inside", "inside")]),
        message("m2", [toolPart("m2", "leave-part", "leave")]),
    ]
    const operationRecords = [
        operation("m1", null, "memo-1", "edit_memo"),
        operation("m1", null, "compress-1", "compress"),
        operation("m1", null, "toggle-1", "toggle_summary_version"),
        operation("m1", null, "memo-2", "command:memo"),
        operation("m1", null, "compress-2", "compress"),
        operation("m1", null, "memo-3", "command:memo-file"),
        operation("m1", null, "memo-4", "edit_memo"),
    ]

    const result = projectHousekeepingHistory(messages, [
        completed("m2", "leave", "leave-part", "receipt", {
            entryMessageId: "m0",
            entryCallId: "entry",
            entryPartId: "entry-part",
            operationRecords,
        }),
    ])

    assert.equal(
        outputOf(result[0].parts[0]),
        "2 compressions, 1 summary toggle, 4 memo edits. details truncated.",
    )
    assert.equal(titleOf(result[0].parts[0]), ENTRY_TITLE)
})

test("completed entry placeholder inflects counts and omits zero categories", () => {
    const messages = [
        message("m0", [toolPart("m0", "entry-part", "entry")]),
        message("m1", [toolPart("m1", "leave-part", "leave")]),
    ]
    const operationRecords = [
        operation("m0", null, "edit-1", "edit_summary"),
        operation("m0", null, "edit-2", "append_summary"),
        operation("m0", null, "edit-3", "rewrite_summary"),
        operation("m0", null, "edit-4", "command:edit"),
        operation("m0", null, "edit-5", "command:edit-file"),
        operation("m0", null, "expand-1", "expand_block"),
        operation("m0", null, "recompress-1", "command:recompress"),
        operation("m0", null, "recompress-2", "command:recompress"),
        operation("m0", null, "sweep-1", "command:sweep"),
        operation("m0", null, "decompress-1", "command:decompress"),
    ]

    const result = projectHousekeepingHistory(messages, [
        completed("m1", "leave", "leave-part", "receipt", {
            entryMessageId: "m0",
            entryCallId: "entry",
            entryPartId: "entry-part",
            operationRecords,
        }),
    ])

    assert.equal(
        outputOf(result[0].parts[0]),
        "5 summary edits, 2 expansions, 2 recompressions, 1 sweep. details truncated.",
    )
})

test("completed entry placeholder ignores reads and unknown operations", () => {
    const messages = [
        message("m0", [toolPart("m0", "entry-part", "entry")]),
        message("m1", [toolPart("m1", "leave-part", "leave")]),
    ]
    const operationRecords = [
        operation("m0", null, "read-1", "read"),
        operation("m0", null, "read-2", "read_memo"),
        operation("m0", null, "read-3", "fetch_summary_versions"),
        operation("m0", null, "read-4", "recall_compressed"),
        operation("m0", null, "unknown-1", "bash"),
        operation("m0", null, "unknown-2", "command:test"),
        operation("m0", null, "unknown-3", "command:unrelated"),
    ]

    const result = projectHousekeepingHistory(messages, [
        completed("m1", "leave", "leave-part", "receipt", {
            entryMessageId: "m0",
            entryCallId: "entry",
            entryPartId: "entry-part",
            operationRecords,
        }),
    ])

    assert.equal(outputOf(result[0].parts[0]), EMPTY_ENTRY_PLACEHOLDER)
})

test("completed entry placeholder never echoes operation inputs, results, or call identifiers", () => {
    const messages = [
        message("m0", [toolPart("m0", "entry-part", "entry")]),
        message("m1", [toolPart("m1", "leave-part", "leave")]),
    ]
    const operationRecords: HousekeepingOperation[] = [
        {
            messageId: "m0",
            partId: null,
            callId: "call-secret-identifier",
            tool: "compress",
            input: { path: "INPUT_SECRET_PATH", text: "INPUT_SECRET_TEXT" },
            result: "RESULT_SECRET_TEXT",
        },
    ]

    const result = projectHousekeepingHistory(messages, [
        completed("m1", "leave", "leave-part", "receipt", {
            entryMessageId: "m0",
            entryCallId: "entry",
            entryPartId: "entry-part",
            operationRecords,
        }),
    ])

    const output = outputOf(result[0].parts[0])
    assert.equal(output, "1 compression. details truncated.")
    for (const secret of [
        "call-secret-identifier",
        "INPUT_SECRET_PATH",
        "INPUT_SECRET_TEXT",
        "RESULT_SECRET_TEXT",
    ]) {
        assert.ok(!output!.includes(secret))
    }
})

test("completed placeholder leaves the receipt and incomplete entries untouched", () => {
    const completedMessages = [
        message("m0", [toolPart("m0", "entry-part", "entry")]),
        message("m1", [toolPart("m1", "leave-part", "leave", { output: "raw-leave" })]),
    ]
    const completedResult = projectHousekeepingHistory(completedMessages, [
        completed("m1", "leave", "leave-part", "receipt", {
            entryMessageId: "m0",
            entryCallId: "entry",
            entryPartId: "entry-part",
            operationRecords: [operation("m0", null, "compress-1", "compress")],
        }),
    ])
    assert.equal(outputOf(completedResult[0].parts[0]), "1 compression. details truncated.")
    assert.equal(outputOf(completedResult[1].parts[0]), "receipt")
    assert.equal(titleOf(completedResult[1].parts[0]), LEAVE_TITLE)

    const incompleteMessages = [
        message("m0", [toolPart("m0", "entry-part", "entry", { output: "raw-entry" })]),
        message("m1", [textPart("m1", "inside", "inside")]),
    ]
    const incompleteResult = projectHousekeepingHistory(incompleteMessages, [
        transaction({
            entryMessageId: "m0",
            entryCallId: "entry",
            entryPartId: "entry-part",
            operationRecords: [operation("m0", null, "compress-1", "compress")],
        }),
    ])
    assert.deepEqual(incompleteResult, incompleteMessages)
})

test("duplicate entry boundaries share one counted placeholder", () => {
    const messages = [
        message("dup", [toolPart("dup", "dup-part", "entry")]),
        message("dup", [toolPart("dup", "dup-part", "entry")]),
        message("done", [toolPart("done", "leave-part", "leave")]),
    ]

    const result = projectHousekeepingHistory(messages, [
        completed("done", "leave", "leave-part", "receipt", {
            entryMessageId: "dup",
            entryCallId: "entry",
            entryPartId: "dup-part",
            operationRecords: [
                operation("dup", "dup-part", "compress-1", "compress"),
                operation("dup", "dup-part", "compress-2", "compress"),
                operation("dup", "dup-part", "memo-1", "edit_memo"),
            ],
        }),
    ])

    assert.deepEqual(
        result.map((item) => item.info.id),
        ["dup", "dup", "done"],
    )
    assert.equal(outputOf(result[0].parts[0]), "2 compressions, 1 memo edit. details truncated.")
    assert.equal(outputOf(result[1].parts[0]), "2 compressions, 1 memo edit. details truncated.")
    assert.equal(outputOf(result[2].parts[0]), "receipt")
})

test("completed entries count only their own transaction operations", () => {
    const messages = [
        message("m0", [toolPart("m0", "entry-1", "entry-1")]),
        message("m1", [textPart("m1", "inside-1", "inside-1")]),
        message("m2", [toolPart("m2", "leave-1", "leave-1")]),
        message("m3", [toolPart("m3", "entry-2", "entry-2")]),
        message("m4", [textPart("m4", "inside-2", "inside-2")]),
        message("m5", [toolPart("m5", "leave-2", "leave-2")]),
    ]

    const result = projectHousekeepingHistory(messages, [
        completed("m2", "leave-1", "leave-1", "receipt-1", {
            id: "first",
            entryMessageId: "m0",
            entryCallId: "entry-1",
            entryPartId: "entry-1",
            operationRecords: [operation("m1", null, "compress-1", "compress")],
        }),
        completed("m5", "leave-2", "leave-2", "receipt-2", {
            id: "second",
            entryMessageId: "m3",
            entryCallId: "entry-2",
            entryPartId: "entry-2",
            operationRecords: [operation("m4", null, "sweep-1", "command:sweep")],
        }),
    ])

    assert.equal(outputOf(result[0].parts[0]), "1 compression. details truncated.")
    assert.equal(outputOf(result[2].parts[0]), "1 sweep. details truncated.")
})

function randomGenerator(seed: number): () => number {
    return () => {
        seed |= 0
        seed = (seed + 0x6d2b79f5) | 0
        let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296
    }
}

function pick<T>(random: () => number, values: T[]): T {
    return values[Math.floor(random() * values.length)]
}

function generateCase(seed: number): {
    messages: WithParts[]
    transactions: HousekeepingTransaction[]
} {
    const random = randomGenerator(seed)
    const messageCount = 1 + Math.floor(random() * 4)
    const messages: WithParts[] = []
    const descriptors: Array<{
        messageId: string
        partId: string
        callId: string
    }> = []
    const partIds = ["p0", "p1", "p2", "p3"]
    const callIds = ["a", "b", "c"]
    const statuses: Array<"pending" | "running" | "completed" | "error"> = [
        "completed",
        "completed",
        "running",
        "error",
    ]
    for (let messageIndex = 0; messageIndex < messageCount; messageIndex++) {
        const id = random() < 0.2 ? `m${Math.floor(random() * messageCount)}` : `m${messageIndex}`
        const partCount = Math.floor(random() * 4)
        const parts: Part[] = []
        for (let partIndex = 0; partIndex < partCount; partIndex++) {
            const partId = pick(random, partIds)
            const callId = pick(random, callIds)
            if (random() < 0.45) {
                parts.push(textPart(id, partId, `text-${messageIndex}-${partIndex}`))
            } else {
                parts.push(
                    toolPart(id, partId, callId, {
                        status: pick(random, statuses),
                        output: `raw-${messageIndex}-${partIndex}`,
                    }),
                )
                descriptors.push({ messageId: id, partId, callId })
            }
        }
        messages.push(message(id, parts))
    }
    const allPartIds = [...partIds, "missing-part"]
    const allCallIds = [...callIds, "missing-call"]
    const sourceOrEntryMessage = () =>
        descriptors.length && random() < 0.85
            ? pick(random, descriptors).messageId
            : pick(random, [...messages.map((item) => item.info.id), "missing-message"])
    const sourceOrPartId = () =>
        descriptors.length && random() < 0.85
            ? pick(random, descriptors).partId
            : pick(random, allPartIds)
    const sourceOrCallId = () =>
        descriptors.length && random() < 0.85
            ? pick(random, descriptors).callId
            : pick(random, allCallIds)
    const transactionCount = Math.floor(random() * 4)
    const transactions: HousekeepingTransaction[] = []
    for (let index = 0; index < transactionCount; index++) {
        const entryMessageId = sourceOrEntryMessage()
        const entryCallId = sourceOrCallId()
        const entryPartId = random() < 0.5 ? null : sourceOrPartId()
        const sourceParts = Array.from({ length: Math.floor(random() * 4) }, () => ({
            messageId: sourceOrEntryMessage(),
            partId: sourceOrPartId(),
        }))
        const operationRecords = Array.from({ length: Math.floor(random() * 3) }, () =>
            operation(
                sourceOrEntryMessage(),
                random() < 0.2 ? null : sourceOrPartId(),
                sourceOrCallId(),
                pick(random, ["read", "bash", "command:test"]),
            ),
        )
        const isCompleted = random() < 0.55
        transactions.push(
            transaction({
                id: `transaction-${index}`,
                entryMessageId,
                entryCallId,
                entryPartId,
                sourceParts,
                operationRecords,
                ...(isCompleted
                    ? {
                          completed: {
                              leaveMessageId: sourceOrEntryMessage(),
                              leaveCallId: sourceOrCallId(),
                              leavePartId: random() < 0.5 ? null : sourceOrPartId(),
                              receipt: `receipt-${index}`,
                              commitRevision: 1,
                              committedDraftRef: snapshotRef("committed-snapshot"),
                          },
                      }
                    : {}),
            }),
        )
    }
    return { messages, transactions }
}

test("matches the frozen reference across generated small cases", () => {
    for (let seed = 1; seed <= 200; seed++) {
        const { messages, transactions } = generateCase(seed)
        const before = structuredClone(messages)

        const actual = projectHousekeepingHistory(messages, transactions)
        const expected = referenceProject(messages, transactions)

        assert.deepEqual(actual, expected, `seed ${seed}`)
        assert.deepEqual(messages, before, `input mutated at seed ${seed}`)
    }
})
