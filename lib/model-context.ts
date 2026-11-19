import { planHousekeepingProjection } from "./housekeeping/history"
import { stripHallucinationsFromString } from "./messages/utils"
import type { HousekeepingTransaction } from "./state"

export interface ModelContextRequest {
    messages: Array<{ id?: string; content: readonly unknown[] }>
    options: { stop?: readonly string[] }
}

const DCP_TAG_STOPS = ["<dcp-", "</dcp-"]

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}

function stripText(value: Record<string, unknown>, key: string) {
    const original = value[key]
    if (typeof original !== "string") return value
    const clean = stripHallucinationsFromString(original)
    return clean === original ? value : { ...value, [key]: clean }
}

function stripTextPart(part: unknown): unknown {
    return isRecord(part) && part.type === "text" ? stripText(part, "text") : part
}

function stripPart(part: unknown): unknown {
    if (!isRecord(part) || part.type !== "tool-result" || !isRecord(part.result)) {
        return stripTextPart(part)
    }
    if (part.result.type === "text") {
        const result = stripText(part.result, "value")
        return result === part.result ? part : { ...part, result }
    }
    if (part.result.type === "content" && Array.isArray(part.result.value)) {
        const content: unknown[] = part.result.value
        const value = content.map(stripTextPart)
        if (value.some((item, i) => item !== content[i])) {
            return { ...part, result: { ...part.result, value } }
        }
    }
    return part
}

function toolPartId(part: unknown, type: "tool-call" | "tool-result"): string | undefined {
    if (isRecord(part) && part.type === type && typeof part.id === "string") return part.id
}

function projectHousekeeping(
    messages: ModelContextRequest["messages"],
    history: readonly HousekeepingTransaction[],
): ModelContextRequest["messages"] {
    const parts: Array<{ messageId: string; messageIndex: number; callId?: string }> = []
    const messageIds = messages.map((message) => message.id ?? "")
    const messageEnds: number[] = []
    messages.forEach((message, messageIndex) => {
        for (const part of message.content) {
            if (toolPartId(part, "tool-result") !== undefined) continue
            parts.push({
                messageId: messageIds[messageIndex]!,
                messageIndex,
                callId: toolPartId(part, "tool-call"),
            })
        }
        messageEnds.push(parts.length - 1)
    })
    const { hidden, boundaryEdits } = planHousekeepingProjection(
        parts,
        history,
        messageIds,
        messageEnds,
    )
    const calls = new Map<string, number | null>()
    for (const [position, { callId }] of parts.entries()) {
        if (callId !== undefined) calls.set(callId, calls.has(callId) ? null : position)
    }

    let position = 0
    return messages.flatMap((message) => {
        const content = message.content.flatMap((part) => {
            const resultId = toolPartId(part, "tool-result")
            if (resultId === undefined) return hidden[position++] > 0 ? [] : [part]
            const call = calls.get(resultId)
            if (call == null) return [part]
            if (hidden[call] > 0) return []
            const edit = boundaryEdits.get(call)
            return edit && isRecord(part) && part.resultType !== "error"
                ? [{ ...part, result: { type: "text", value: edit.output } }]
                : [part]
        })
        if (content.length === message.content.length && content.every((part, i) => part === message.content[i])) {
            return [message]
        }
        return content.length > 0 ? [{ ...message, content }] : []
    })
}

export function prepareModelContext(
    request: ModelContextRequest,
    history: readonly HousekeepingTransaction[] = [],
): void {
    request.messages = request.messages.map((message) => {
        const content = message.content.map(stripPart)
        return content.some((part, i) => part !== message.content[i])
            ? { ...message, content }
            : message
    })
    if (history.length > 0) request.messages = projectHousekeeping(request.messages, history)
    const existing = request.options.stop ?? []
    const missing = DCP_TAG_STOPS.filter((stop) => !existing.includes(stop))
    if (missing.length > 0) request.options.stop = [...existing, ...missing]
}
