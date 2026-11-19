import assert from "node:assert/strict"
import test from "node:test"
import { projectHousekeepingHistory } from "../lib/housekeeping/history"
import { prepareModelContext } from "../lib/model-context"
import type { HousekeepingOperation, HousekeepingTransaction, WithParts } from "../lib/state"

type Part = WithParts["parts"][number]
type Edit = { output: string; title: string }
type TestOperation = HousekeepingOperation
type TestCompleted = NonNullable<HousekeepingTransaction["completed"]>
type TestTransaction = HousekeepingTransaction

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

function operation(messageId: string, callId: string, tool = "read"): TestOperation {
    return { messageId, callId, tool, input: {}, result: "ok" }
}

function snapshotRef(snapshotId: string): HousekeepingTransaction["baseRef"] {
    return { kind: "snapshot", snapshotId }
}

function transaction(overrides: Partial<TestTransaction> = {}): TestTransaction {
    return {
        id: "transaction-1",
        sessionId: sessionID,
        entryMessageId: "missing-entry",
        entryCallId: "missing-entry-call",
        entryCreatedAt: 1,
        sourceMessageIds: [],
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
    receipt: string,
    overrides: Partial<TestTransaction> = {},
): TestTransaction {
    return transaction({
        completed: {
            leaveMessageId,
            leaveCallId,
            receipt,
            commitRevision: 1,
            committedDraftRef: snapshotRef("committed-snapshot"),
        },
        ...overrides,
    })
}

function project(messages: WithParts[], transactions: TestTransaction[]): WithParts[] {
    return projectHousekeepingHistory(messages, transactions)
}

function prepare(
    request: Parameters<typeof prepareModelContext>[0],
    history: TestTransaction[],
): void {
    prepareModelContext(request, history)
}

function outputOf(part: Part | undefined): string | undefined {
    return part?.type === "tool" && part.state.status === "completed"
        ? part.state.output
        : undefined
}

function titleOf(part: Part | undefined): string | undefined {
    return part?.type === "tool" && part.state.status === "completed" ? part.state.title : undefined
}

function requestWithSplitResults() {
    const text = (text: string) => ({ type: "text", text })
    const call = (id: string, name: string) => ({ type: "tool-call", id, name, input: {} })
    const result = (id: string, name: string, value: string) => ({
        type: "tool-result",
        id,
        name,
        result: { type: "text", value },
    })
    const request = {
        options: {},
        messages: [
            {
                id: "assistant-entry",
                role: "assistant",
                content: [
                    text("ordinary before"),
                    call("enter", "enter_housekeeping"),
                    call("read", "read"),
                ],
            },
            { role: "tool", content: [result("enter", "enter_housekeeping", "full guidance")] },
            { role: "tool", content: [result("read", "read", "ordinary result")] },
            {
                id: "assistant-maintenance",
                role: "assistant",
                content: [text("maintenance"), call("operation", "edit_memo")],
            },
            { role: "tool", content: [result("operation", "edit_memo", "maintenance details")] },
            {
                id: "assistant-leave",
                role: "assistant",
                content: [
                    text("leave thinking"),
                    call("leave", "leave_housekeeping"),
                    call("post", "read"),
                ],
            },
            { role: "tool", content: [result("leave", "leave_housekeeping", "full result")] },
            { role: "tool", content: [result("post", "read", "post result")] },
            {
                id: "assistant-after",
                role: "assistant",
                content: [text("ordinary after")],
            },
        ],
    }
    return { request, text, call, result }
}

test("model context hides completed housekeeping and its split tool results, while retaining both receipts", () => {
    const { request, text, call, result } = requestWithSplitResults()
    const original = structuredClone(request.messages)
    const sourceMessages = request.messages
    const history = [
        completed("assistant-leave", "leave", "maintenance committed", {
            entryMessageId: "assistant-entry",
            entryCallId: "enter",
        }),
    ]

    prepare(request, history)

    assert.deepEqual(request.messages, [
        {
            id: "assistant-entry",
            role: "assistant",
            content: [
                text("ordinary before"),
                call("enter", "enter_housekeeping"),
                call("read", "read"),
            ],
        },
        { role: "tool", content: [result("enter", "enter_housekeeping", EMPTY_ENTRY_PLACEHOLDER)] },
        { role: "tool", content: [result("read", "read", "ordinary result")] },
        {
            id: "assistant-leave",
            role: "assistant",
            content: [call("leave", "leave_housekeeping")],
        },
        { role: "tool", content: [result("leave", "leave_housekeeping", "maintenance committed")] },
        { id: "assistant-after", role: "assistant", content: [text("ordinary after")] },
    ])
    assert.deepEqual(sourceMessages, original)
})

test("model context keeps work visible until housekeeping has completed", () => {
    const { request } = requestWithSplitResults()
    const original = structuredClone(request.messages)

    prepare(request, [transaction({ entryMessageId: "assistant-entry", entryCallId: "enter" })])

    assert.deepEqual(request.messages, original)
})

test("model context retains entry-message siblings for either order of the parallel tool calls", () => {
    const text = (text: string) => ({ type: "text", text })
    const call = (id: string, name: string) => ({ type: "tool-call", id, name, input: {} })
    for (const content of [
        [text("before entry"), call("enter", "enter_housekeeping"), call("read", "read")],
        [text("before entry"), call("read", "read"), call("enter", "enter_housekeeping")],
    ]) {
        const request = {
            options: {},
            messages: [
                { id: "assistant-entry", role: "assistant", content },
                {
                    id: "assistant-leave",
                    role: "assistant",
                    content: [call("leave", "leave_housekeeping")],
                },
            ],
        }
        prepare(request, [
            completed("assistant-leave", "leave", "receipt", {
                entryMessageId: "assistant-entry",
                entryCallId: "enter",
            }),
        ])
        assert.deepEqual(request.messages[0], { id: "assistant-entry", role: "assistant", content })
    }
})

test("model context hides every leave-message sibling regardless of its position", () => {
    const text = (text: string) => ({ type: "text", text })
    const call = (id: string, name: string) => ({ type: "tool-call", id, name, input: {} })
    for (const content of [
        [text("before leave"), call("leave", "leave_housekeeping"), call("post", "read")],
        [text("before leave"), call("post", "read"), call("leave", "leave_housekeeping")],
    ]) {
        const request = {
            options: {},
            messages: [
                {
                    id: "assistant-entry",
                    role: "assistant",
                    content: [call("enter", "enter_housekeeping")],
                },
                { id: "assistant-leave", role: "assistant", content },
            ],
        }
        prepare(request, [
            completed("assistant-leave", "leave", "receipt", {
                entryMessageId: "assistant-entry",
                entryCallId: "enter",
            }),
        ])
        assert.deepEqual(request.messages[1], {
            id: "assistant-leave",
            role: "assistant",
            content: [call("leave", "leave_housekeeping")],
        })
    }
})

function referenceMatches(
    points: Array<{ messageId: string; callId?: string; messageIndex: number }>,
    messageId: string,
    callId: string,
): number[] {
    const positions: number[] = []
    points.forEach((point, position) => {
        if (point.messageId === messageId && point.callId === callId) positions.push(position)
    })
    return positions
}

function referenceProject(messages: WithParts[], transactions: TestTransaction[]): WithParts[] {
    const points: Array<{ messageId: string; callId?: string; messageIndex: number }> = []
    const messageEnds: number[] = []
    messages.forEach((message, messageIndex) => {
        for (const part of message.parts) {
            points.push({
                messageId: message.info.id,
                callId: part.type === "tool" ? part.callID : undefined,
                messageIndex,
            })
        }
        messageEnds[messageIndex] = points.length - 1
    })
    const endOfMessage = (position: number) => messageEnds[points[position].messageIndex]

    const hidden = new Set<number>()
    const boundaryEdits = new Map<number, Edit>()
    for (const transaction of transactions) {
        const entryPositions = referenceMatches(
            points,
            transaction.entryMessageId,
            transaction.entryCallId,
        )
        const entryPosition = entryPositions.at(-1)
        const leavePositions = transaction.completed
            ? referenceMatches(
                  points,
                  transaction.completed.leaveMessageId,
                  transaction.completed.leaveCallId,
              )
            : []
        const leavePosition = leavePositions.at(-1)
        if (transaction.completed) {
            for (const position of entryPositions) {
                boundaryEdits.set(position, {
                    output: EMPTY_ENTRY_PLACEHOLDER,
                    title: ENTRY_TITLE,
                })
            }
            for (const position of leavePositions) {
                boundaryEdits.set(position, {
                    output: transaction.completed.receipt,
                    title: LEAVE_TITLE,
                })
            }
        }
        if (!transaction.completed && entryPosition !== undefined) continue

        let start: number | undefined
        if (entryPosition !== undefined) {
            start = endOfMessage(entryPosition)
        } else {
            const sourceIds = new Set(transaction.sourceMessageIds)
            let sourceIndex = -1
            messages.forEach((candidate, index) => {
                if (sourceIds.has(candidate.info.id)) sourceIndex = index
            })
            if (sourceIndex >= 0) start = messageEnds[sourceIndex]
        }
        if (start === undefined) continue

        if (leavePosition !== undefined) {
            const leaveMessageIndex = points[leavePosition].messageIndex
            const retained = new Set(
                leavePositions.filter(
                    (position) => points[position].messageIndex === leaveMessageIndex,
                ),
            )
            for (let position = start + 1; position <= endOfMessage(leavePosition); position++) {
                if (!retained.has(position)) hidden.add(position)
            }
            continue
        }

        let operationMaximum: number | undefined
        for (const record of transaction.operationRecords) {
            for (const position of referenceMatches(points, record.messageId, record.callId)) {
                if (operationMaximum === undefined || position > operationMaximum)
                    operationMaximum = position
            }
        }
        if (operationMaximum !== undefined) {
            for (let position = start + 1; position < operationMaximum; position++)
                hidden.add(position)
        }
    }
    let position = 0
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
        completed("m4", "leave", "receipt", {
            entryMessageId: "m1",
            entryCallId: "entry",
            sourceMessageIds: ["m0"],
        }),
    ]

    const result = project(messages, transactions)

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
            sourceMessageIds: ["m0"],
        }),
    ]

    const result = project(messages, transactions)

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
            sourceMessageIds: ["m0"],
            operationRecords: [operation("m2", "op")],
        }),
    ]

    const result = project(messages, transactions)

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
        completed("m2", "leave", "receipt", {
            sourceMessageIds: ["m0"],
        }),
    ]

    const result = project(messages, transactions)

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
        completed("m4", "leave-1", "receipt-1", {
            entryMessageId: "m0",
            entryCallId: "entry-1",
        }),
        completed("m6", "leave-2", "receipt-2", {
            entryMessageId: "m2",
            entryCallId: "entry-2",
        }),
    ]

    const result = project(messages, transactions)

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
        completed("done", "leave", "receipt", {
            entryMessageId: "dup",
            entryCallId: "entry",
            sourceMessageIds: ["dup"],
        }),
    ]

    const result = project(messages, transactions)

    assert.deepEqual(
        result.map((item) => item.info.id),
        ["dup", "dup", "done"],
    )
    assert.equal(outputOf(result[0].parts[0]), EMPTY_ENTRY_PLACEHOLDER)
    assert.equal(outputOf(result[1].parts[0]), EMPTY_ENTRY_PLACEHOLDER)
    assert.equal(outputOf(result[2].parts[0]), "receipt")
})

test("boundary matching ignores native part IDs and matches every recorded call", () => {
    const messages = [
        message("m0", [toolPart("m0", "first", "shared"), toolPart("m0", "second", "shared")]),
        message("m1", [textPart("m1", "inside", "inside")]),
        message("m2", [toolPart("m2", "leave-part", "leave")]),
    ]

    const result = project(messages, [
        completed("m2", "leave", "receipt", {
            entryMessageId: "m0",
            entryCallId: "shared",
        }),
    ])

    assert.deepEqual(
        result.map((item) => item.info.id),
        ["m0", "m2"],
    )
    assert.equal(result[0].parts.length, 2)
    assert.equal(outputOf(result[0].parts[0]), EMPTY_ENTRY_PLACEHOLDER)
    assert.equal(outputOf(result[0].parts[1]), EMPTY_ENTRY_PLACEHOLDER)
})

test("recorded boundaries still match after native part IDs change", () => {
    const transaction = completed("m2", "leave", "receipt", {
        entryMessageId: "m0",
        entryCallId: "shared",
    })
    const build = (entryPart: string, leavePart: string) => [
        message("m0", [toolPart("m0", entryPart, "shared")]),
        message("m1", [textPart("m1", "inside", "inside")]),
        message("m2", [toolPart("m2", leavePart, "leave")]),
    ]

    for (const messages of [build("old-entry", "old-leave"), build("new-entry", "new-leave")]) {
        const result = project(messages, [transaction])
        assert.deepEqual(
            result.map((item) => item.info.id),
            ["m0", "m2"],
        )
        assert.equal(outputOf(result[0].parts[0]), EMPTY_ENTRY_PLACEHOLDER)
        assert.equal(outputOf(result[1].parts[0]), "receipt")
    }
})

test("entry-message ordinary content survives either order of the parallel tool calls", () => {
    for (const parts of [
        [
            textPart("m0", "before-entry", "before entry"),
            toolPart("m0", "entry-part", "entry"),
            toolPart("m0", "read-part", "read", { tool: "read" }),
        ],
        [
            textPart("m0", "before-entry", "before entry"),
            toolPart("m0", "read-part", "read", { tool: "read" }),
            toolPart("m0", "entry-part", "entry"),
        ],
    ]) {
        const messages = [
            message("m0", parts),
            message("m2", [toolPart("m2", "leave-part", "leave")]),
        ]
        const result = project(messages, [
            completed("m2", "leave", "receipt", {
                entryMessageId: "m0",
                entryCallId: "entry",
            }),
        ])
        assert.deepEqual(
            result.map((item) => item.info.id),
            ["m0", "m2"],
        )
        assert.equal(result[0].parts.length, parts.length)
        assert.equal(
            outputOf(result[0].parts.find((part) => part.id === "entry-part")),
            EMPTY_ENTRY_PLACEHOLDER,
        )
    }
})

test("leave-message thinking and other calls are hidden regardless of sibling order", () => {
    for (const parts of [
        [
            textPart("m2", "leave-thinking", "leave thinking"),
            toolPart("m2", "leave-part", "leave"),
            toolPart("m2", "post-part", "post", { tool: "read" }),
        ],
        [
            textPart("m2", "leave-thinking", "leave thinking"),
            toolPart("m2", "post-part", "post", { tool: "read" }),
            toolPart("m2", "leave-part", "leave"),
        ],
    ]) {
        const messages = [
            message("m0", [toolPart("m0", "entry-part", "entry")]),
            message("m2", parts),
        ]
        const result = project(messages, [
            completed("m2", "leave", "receipt", {
                entryMessageId: "m0",
                entryCallId: "entry",
            }),
        ])
        assert.deepEqual(
            result.map((item) => item.info.id),
            ["m0", "m2"],
        )
        assert.deepEqual(
            result[1].parts.map((part) => part.id),
            ["leave-part"],
        )
        assert.equal(outputOf(result[1].parts[0]), "receipt")
    }
})

test("operation fallback ignores non-tool parts but matches tool parts by call identity", () => {
    const textOnly = [
        message("m0", [textPart("m0", "source", "source")]),
        message("m1", [textPart("m1", "op-part", "text", { callID: "op" })]),
    ]
    const textResult = project(textOnly, [
        transaction({
            sourceMessageIds: ["m0"],
            operationRecords: [operation("m1", "op")],
        }),
    ])
    assert.deepEqual(
        textResult.map((item) => item.info.id),
        ["m0", "m1"],
    )

    const toolMatch = [
        message("m0", [textPart("m0", "source", "source")]),
        message("m1", [textPart("m1", "hidden", "hidden")]),
        message("m2", [toolPart("m2", "renamed-part", "op", { tool: "bash" })]),
    ]
    const toolResult = project(toolMatch, [
        transaction({
            sourceMessageIds: ["m0"],
            operationRecords: [operation("m2", "op", "command:unrelated")],
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
        completed("m1", "first-leave", "first-receipt", {
            id: "first",
            entryMessageId: "m0",
            entryCallId: "shared",
        }),
        completed("m0", "shared", "second-receipt", {
            id: "second",
            entryMessageId: "missing",
            entryCallId: "missing",
            sourceMessageIds: [],
        }),
    ]

    const result = project(messages, transactions)

    assert.equal(outputOf(result[0].parts[0]), "second-receipt")
    assert.equal(titleOf(result[0].parts[0]), LEAVE_TITLE)

    const samePosition = project(messages.slice(0, 1), [
        completed("m0", "shared", "leave-wins", {
            entryMessageId: "m0",
            entryCallId: "shared",
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
        completed("m1", "leave", "receipt", {
            entryMessageId: "m0",
            entryCallId: "entry",
        }),
    ]

    const result = project(messages, transactions)

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
        completed("m3", "leave", "receipt", {
            entryMessageId: "m1",
            entryCallId: "entry",
        }),
    ]

    const result = project(messages, transactions)

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
        completed("m3", "leave", "receipt", {
            entryMessageId: "m1",
            entryCallId: "entry",
        }),
    ]
    const snapshot = structuredClone(messages)

    project(messages, transactions)

    assert.deepEqual(messages, snapshot)
})

test("completed entry placeholder counts mixed operations in fixed category order", () => {
    const messages = [
        message("m0", [toolPart("m0", "entry-part", "entry")]),
        message("m1", [textPart("m1", "inside", "inside")]),
        message("m2", [toolPart("m2", "leave-part", "leave")]),
    ]
    const operationRecords = [
        operation("m1", "memo-1", "edit_memo"),
        operation("m1", "compress-1", "compress"),
        operation("m1", "toggle-1", "toggle_summary_version"),
        operation("m1", "memo-2", "command:memo"),
        operation("m1", "compress-2", "compress"),
        operation("m1", "memo-3", "command:memo-file"),
        operation("m1", "memo-4", "edit_memo"),
    ]

    const result = project(messages, [
        completed("m2", "leave", "receipt", {
            entryMessageId: "m0",
            entryCallId: "entry",
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
        operation("m0", "edit-1", "edit_summary"),
        operation("m0", "edit-2", "append_summary"),
        operation("m0", "edit-3", "rewrite_summary"),
        operation("m0", "edit-4", "command:edit"),
        operation("m0", "edit-5", "command:edit-file"),
        operation("m0", "expand-1", "expand_block"),
        operation("m0", "recompress-1", "command:recompress"),
        operation("m0", "recompress-2", "command:recompress"),
        operation("m0", "sweep-1", "command:sweep"),
        operation("m0", "decompress-1", "command:decompress"),
    ]

    const result = project(messages, [
        completed("m1", "leave", "receipt", {
            entryMessageId: "m0",
            entryCallId: "entry",
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
        operation("m0", "read-1", "read"),
        operation("m0", "read-2", "read_memo"),
        operation("m0", "read-3", "fetch_summary_versions"),
        operation("m0", "read-4", "recall_compressed"),
        operation("m0", "unknown-1", "bash"),
        operation("m0", "unknown-2", "command:test"),
        operation("m0", "unknown-3", "command:unrelated"),
    ]

    const result = project(messages, [
        completed("m1", "leave", "receipt", {
            entryMessageId: "m0",
            entryCallId: "entry",
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
    const operationRecords: TestOperation[] = [
        {
            messageId: "m0",
            callId: "call-secret-identifier",
            tool: "compress",
            input: { path: "INPUT_SECRET_PATH", text: "INPUT_SECRET_TEXT" },
            result: "RESULT_SECRET_TEXT",
        },
    ]

    const result = project(messages, [
        completed("m1", "leave", "receipt", {
            entryMessageId: "m0",
            entryCallId: "entry",
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
    const completedResult = project(completedMessages, [
        completed("m1", "leave", "receipt", {
            entryMessageId: "m0",
            entryCallId: "entry",
            operationRecords: [operation("m0", "compress-1", "compress")],
        }),
    ])
    assert.equal(outputOf(completedResult[0].parts[0]), "1 compression. details truncated.")
    assert.equal(outputOf(completedResult[1].parts[0]), "receipt")
    assert.equal(titleOf(completedResult[1].parts[0]), LEAVE_TITLE)

    const incompleteMessages = [
        message("m0", [toolPart("m0", "entry-part", "entry", { output: "raw-entry" })]),
        message("m1", [textPart("m1", "inside", "inside")]),
    ]
    const incompleteResult = project(incompleteMessages, [
        transaction({
            entryMessageId: "m0",
            entryCallId: "entry",
            operationRecords: [operation("m0", "compress-1", "compress")],
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

    const result = project(messages, [
        completed("done", "leave", "receipt", {
            entryMessageId: "dup",
            entryCallId: "entry",
            operationRecords: [
                operation("dup", "compress-1", "compress"),
                operation("dup", "compress-2", "compress"),
                operation("dup", "memo-1", "edit_memo"),
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

    const result = project(messages, [
        completed("m2", "leave-1", "receipt-1", {
            id: "first",
            entryMessageId: "m0",
            entryCallId: "entry-1",
            operationRecords: [operation("m1", "compress-1", "compress")],
        }),
        completed("m5", "leave-2", "receipt-2", {
            id: "second",
            entryMessageId: "m3",
            entryCallId: "entry-2",
            operationRecords: [operation("m4", "sweep-1", "command:sweep")],
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
    transactions: TestTransaction[]
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
    const allMessageIds = [...new Set([...messages.map((item) => item.info.id), "missing-message"])]
    const allCallIds = [...callIds, "missing-call"]
    const pickDescriptor = () =>
        descriptors.length && random() < 0.85
            ? pick(random, descriptors)
            : {
                  messageId: pick(random, allMessageIds),
                  partId: pick(random, partIds),
                  callId: pick(random, allCallIds),
              }
    const transactionCount = Math.floor(random() * 4)
    const transactions: TestTransaction[] = []
    for (let index = 0; index < transactionCount; index++) {
        const entry = pickDescriptor()
        const sourceMessageIds = [
            ...new Set(
                Array.from({ length: Math.floor(random() * 4) }, () => pick(random, allMessageIds)),
            ),
        ]
        const operationRecords = Array.from({ length: Math.floor(random() * 3) }, () => {
            const operationEntry = pickDescriptor()
            return operation(
                operationEntry.messageId,
                operationEntry.callId,
                pick(random, ["read", "bash", "command:test"]),
            )
        })
        const isCompleted = random() < 0.55
        const leave = pickDescriptor()
        transactions.push(
            transaction({
                id: `transaction-${index}`,
                entryMessageId: entry.messageId,
                entryCallId: entry.callId,
                sourceMessageIds,
                operationRecords,
                ...(isCompleted
                    ? {
                          completed: {
                              leaveMessageId: leave.messageId,
                              leaveCallId: leave.callId,
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

        const actual = project(messages, transactions)
        const expected = referenceProject(messages, transactions)

        assert.deepEqual(actual, expected, `seed ${seed}`)
        assert.deepEqual(messages, before, `input mutated at seed ${seed}`)
    }
})
