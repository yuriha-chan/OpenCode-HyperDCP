import { performance } from "node:perf_hooks"
import { projectHousekeepingHistory } from "../lib/housekeeping/history"
import type { HousekeepingOperation, HousekeepingTransaction, WithParts } from "../lib/state"

const sessionID = "ses_housekeeping_history_scaling"

type Descriptor = { messageId: string; partId: string; callId: string }

interface Scenario {
    label: string
    messages: number
    partsPerMessage: number
    transactions: number
    sourceParts: number
    operations: number
}

function toolPart(messageID: string, id: string, callID: string): WithParts["parts"][number] {
    return {
        id,
        messageID,
        sessionID,
        type: "tool",
        tool: "read",
        callID,
        state: {
            status: "completed",
            input: {},
            output: `raw-${id}`,
            title: `raw-${id}`,
            metadata: {},
            time: { start: 1, end: 2 },
        },
    } as unknown as WithParts["parts"][number]
}

function buildCase(scenario: Scenario): {
    messages: WithParts[]
    transactions: HousekeepingTransaction[]
} {
    const messages: WithParts[] = []
    const descriptors: Descriptor[] = []
    for (let messageIndex = 0; messageIndex < scenario.messages; messageIndex++) {
        const messageId = `m${messageIndex}`
        const parts: WithParts["parts"] = []
        for (let partIndex = 0; partIndex < scenario.partsPerMessage; partIndex++) {
            const partId = `p${messageIndex}-${partIndex}`
            const callId = `c${messageIndex}-${partIndex}`
            parts.push(toolPart(messageId, partId, callId))
            descriptors.push({ messageId, partId, callId })
        }
        messages.push({
            info: {
                id: messageId,
                sessionID,
                role: "assistant",
                agent: "assistant",
                model: { providerID: "test", modelID: "test" },
                time: { created: messageIndex + 1 },
            } as WithParts["info"],
            parts,
        })
    }
    const entry = descriptors[0]
    const leave = descriptors[descriptors.length - 1]
    const transactions: HousekeepingTransaction[] = []
    for (let index = 0; index < scenario.transactions; index++) {
        const sourceParts = Array.from({ length: scenario.sourceParts }, (_, sourceIndex) => {
            const descriptor = descriptors[(index + sourceIndex) % descriptors.length]
            return { messageId: descriptor.messageId, partId: descriptor.partId }
        })
        const operationRecords: HousekeepingOperation[] = Array.from(
            { length: scenario.operations },
            (_, operationIndex) => {
                const descriptor =
                    descriptors[
                        descriptors.length - 1 - ((index + operationIndex) % descriptors.length)
                    ]
                return {
                    messageId: descriptor.messageId,
                    partId: descriptor.partId,
                    callId: descriptor.callId,
                    tool: "read",
                    input: {},
                    result: "ok",
                }
            },
        )
        const completed = index % 2 === 0
        transactions.push({
            id: `transaction-${index}`,
            sessionId: sessionID,
            entryMessageId: completed ? entry.messageId : "missing-entry",
            entryPartId: completed ? entry.partId : null,
            entryCallId: completed ? entry.callId : "missing-entry-call",
            entryCreatedAt: index + 1,
            sourceParts,
            baseRevision: 0,
            base: {} as HousekeepingTransaction["base"],
            draft: {} as HousekeepingTransaction["draft"],
            operations: {},
            operationResults: {},
            operationRecords,
            operationOrder: [],
            operationDrafts: {},
            ...(completed
                ? {
                      completed: {
                          leaveMessageId: leave.messageId,
                          leavePartId: leave.partId,
                          leaveCallId: leave.callId,
                          receipt: `receipt-${index}`,
                          commitRevision: index + 1,
                          committedDraft: {} as HousekeepingTransaction["base"],
                      },
                  }
                : {}),
        })
    }
    return { messages, transactions }
}

function measure(messages: WithParts[], transactions: HousekeepingTransaction[]): number {
    const runs = 5
    for (let run = 0; run < runs; run++) projectHousekeepingHistory(messages, transactions)
    let best = Number.POSITIVE_INFINITY
    for (let run = 0; run < runs; run++) {
        const started = performance.now()
        projectHousekeepingHistory(messages, transactions)
        best = Math.min(best, performance.now() - started)
    }
    return best
}

const base = {
    messages: 200,
    partsPerMessage: 10,
    transactions: 100,
    sourceParts: 5,
    operations: 5,
}
const scenarios: Scenario[] = [
    { label: "baseline", ...base },
    { label: "2x parts", ...base, messages: 400 },
    { label: "4x parts", ...base, messages: 800 },
    { label: "2x transactions", ...base, transactions: 200 },
    { label: "4x transactions", ...base, transactions: 400 },
    { label: "2x source/operation", ...base, sourceParts: 10, operations: 10 },
    { label: "4x source/operation", ...base, sourceParts: 20, operations: 20 },
    { label: "4x messages/parts", ...base, messages: 800, partsPerMessage: 40 },
    { label: "4x messages/transactions", ...base, messages: 800, transactions: 400 },
    { label: "4x messages/source", ...base, messages: 800, sourceParts: 20 },
]

const rows = scenarios.map((scenario) => {
    const { messages, transactions } = buildCase(scenario)
    return {
        label: scenario.label,
        messages: scenario.messages,
        parts: scenario.messages * scenario.partsPerMessage,
        transactions: scenario.transactions,
        sourceParts: scenario.transactions * scenario.sourceParts,
        operations: scenario.transactions * scenario.operations,
        bestMs: measure(messages, transactions).toFixed(3),
        outputMessages: projectHousekeepingHistory(messages, transactions).length,
    }
})

console.table(rows)
