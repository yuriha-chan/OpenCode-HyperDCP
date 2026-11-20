import { planHousekeepingProjection } from "./housekeeping/history"
import { isOwnedDisplayOnlyMetadata } from "./native-session"
import {
    appendToTextPart,
    hasContent,
    skillMessageIdentity,
    stripHallucinationsFromString,
} from "./messages/utils"
import type { HousekeepingTransaction, SessionState, SkillContext, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import { contextBlockSummary } from "./messages/block-summary"
import { injectCompressNudges, messageIdTag } from "./messages/inject/inject"
import type { CompressionPriorityMap } from "./messages/priority"
import type { RuntimePrompts } from "./prompts/store"

export interface ModelContextRequest {
    messages: Array<{
        id?: string
        role?: string
        metadata?: Record<string, unknown>
        content: readonly unknown[]
    }>
    options: { stop?: readonly string[] }
}

export function injectContextSkills(
    request: ModelContextRequest,
    records: readonly SkillContext[],
    lastSummaryId?: string,
): void {
    const messages = request.messages.filter((message) => !message.id?.startsWith("msg_dcp_skill_"))
    request.messages = messages
    if (
        !records.length ||
        !messages.some((message) => message.role === "user" && message.content.length > 0)
    )
        return
    const memoIndex = messages.findIndex((message) => message.id === "msg_dcp_memo")
    const summaryIndex =
        lastSummaryId === undefined
            ? -1
            : messages.findIndex((message) => message.id === lastSummaryId)
    const index = memoIndex >= 0 ? memoIndex + 1 : summaryIndex >= 0 ? summaryIndex + 1 : 0
    const skills = records.flatMap((record) => {
        const { messageId, callId } = skillMessageIdentity(record)
        return [
            {
                id: messageId,
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        id: callId,
                        name: "skill",
                        input: structuredClone(record.input),
                    },
                ],
            },
            {
                id: `${messageId}_result`,
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        id: callId,
                        name: "skill",
                        result: { type: "text", value: record.output },
                    },
                ],
            },
        ]
    })
    request.messages = [...messages.slice(0, index), ...skills, ...messages.slice(index)]
}

export function injectContextNudges(
    request: ModelContextRequest,
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    sources: WithParts[],
    prompts: RuntimePrompts,
    priorities?: CompressionPriorityMap,
): void {
    const selectedIds = new Set(request.messages.map((message) => message.id))
    const surviving = sources.filter((message) => selectedIds.has(message.info.id))
    injectCompressNudges(
        state,
        config,
        logger,
        surviving,
        prompts,
        priorities,
        sources,
        (source, text) => {
            request.messages = request.messages.map((message) => {
                if (message.id !== source.info.id) return message
                if (message.role !== "user" && message.role !== "assistant") return message
                if (message.role === "assistant" && !hasContent(source)) return message
                const content = [...message.content]
                const textIndex =
                    message.role === "user"
                        ? content.findLastIndex(
                              (part) =>
                                  isRecord(part) &&
                                  part.type === "text" &&
                                  typeof part.text === "string",
                          )
                        : content.findIndex(
                              (part) =>
                                  isRecord(part) &&
                                  part.type === "text" &&
                                  typeof part.text === "string",
                          )
                if (textIndex >= 0) {
                    const part = content[textIndex] as Record<string, unknown>
                    const updated = { ...part, text: part.text as string }
                    appendToTextPart(updated, text)
                    content[textIndex] = updated
                } else {
                    const toolIndex = content.findIndex(
                        (part) => toolPartId(part, "tool-call") !== undefined,
                    )
                    content.splice(toolIndex < 0 ? content.length : toolIndex, 0, {
                        type: "text",
                        text,
                    })
                }
                return { ...message, content }
            })
        },
    )
}

const DCP_TAG_STOPS = ["<dcp-", "</dcp-"]
const DCP_MEMO_MESSAGE_ID = "msg_dcp_memo"

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
        if (
            content.length === message.content.length &&
            content.every((part, i) => part === message.content[i])
        ) {
            return [message]
        }
        return content.length > 0 ? [{ ...message, content }] : []
    })
}

export function prepareModelContext(
    request: ModelContextRequest,
    history: readonly HousekeepingTransaction[] = [],
    ownedDisplayOnlyIds: ReadonlySet<string> = new Set(),
): void {
    request.messages = request.messages.filter((message) => {
        if (isOwnedDisplayOnlyMetadata(message.metadata)) return false
        return message.id === undefined || !ownedDisplayOnlyIds.has(message.id)
    })
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

export function projectContextBlocks(
    request: ModelContextRequest,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
): string | undefined {
    const covered = (id: string | undefined) =>
        id !== undefined &&
        (state.prune.messages.byMessageId.get(id)?.activeBlockIds.length ?? 0) > 0
    const calls = new Map<string, boolean | null>()
    for (const message of request.messages) {
        for (const part of message.content) {
            const id = toolPartId(part, "tool-call")
            if (id !== undefined) calls.set(id, calls.has(id) ? null : covered(message.id))
        }
    }
    const result: ModelContextRequest["messages"] = []
    let hasUser = false
    let lastSummaryId: string | undefined
    for (const message of request.messages) {
        if (message.role === "user" && message.content.length > 0) hasUser = true
        const summary =
            message.id === undefined
                ? undefined
                : contextBlockSummary(state, logger, config, message.id)
        if (summary) {
            if (hasUser) {
                lastSummaryId = `msg_dcp_block_${summary.block.blockId}_${summary.block.anchorMessageId}`
                result.push({
                    id: lastSummaryId,
                    role: "user",
                    content: [{ type: "text", text: summary.content }],
                })
            } else {
                logger.warn("No user message found for compress summary", {
                    anchorMessageId: message.id,
                })
            }
        }
        if (covered(message.id)) continue
        const content = message.content.filter((part) => {
            const id = toolPartId(part, "tool-result")
            return id === undefined || calls.get(id) !== true
        })
        if (content.length === message.content.length) result.push(message)
        else if (content.length > 0) result.push({ ...message, content })
    }
    request.messages = result
    return lastSummaryId
}

export function injectContextMessageIds(
    request: ModelContextRequest,
    state: SessionState,
    config: PluginConfig,
    sources: WithParts[],
    compressionPriorities?: CompressionPriorityMap,
): void {
    const tags = new Map(
        sources.map((source) => [
            source.info.id,
            messageIdTag(state, config, source, compressionPriorities),
        ]),
    )
    const boundaryCalls = new Set(
        state.housekeepingHistory.flatMap((transaction) => [
            transaction.entryCallId,
            ...(transaction.completed ? [transaction.completed.leaveCallId] : []),
        ]),
    )
    const calls = new Map<string, string | undefined>()
    for (const message of request.messages) {
        for (const part of message.content) {
            const id = toolPartId(part, "tool-call")
            if (id !== undefined)
                calls.set(
                    id,
                    calls.has(id) || boundaryCalls.has(id) ? undefined : tags.get(message.id ?? ""),
                )
        }
    }
    const annotatedCalls = new Set<string>()
    request.messages = request.messages.map((message) => {
        const content = message.content.map((part) => {
            const id = toolPartId(part, "tool-result")
            const tag = id === undefined ? undefined : calls.get(id)
            if (!tag || !isRecord(part) || !isRecord(part.result) || part.resultType === "error")
                return part
            if (part.result.type === "text" && typeof part.result.value === "string") {
                annotatedCalls.add(id!)
                return { ...part, result: { ...part.result, value: part.result.value + tag } }
            }
            if (part.result.type === "content" && Array.isArray(part.result.value)) {
                const values: unknown[] = part.result.value
                const index = values.findLastIndex(
                    (value) =>
                        isRecord(value) && value.type === "text" && typeof value.text === "string",
                )
                if (index >= 0) {
                    annotatedCalls.add(id!)
                    return {
                        ...part,
                        result: {
                            ...part.result,
                            value: values.map((value, i) =>
                                i === index && isRecord(value)
                                    ? { ...value, text: value.text + tag }
                                    : value,
                            ),
                        },
                    }
                }
            }
            return part
        })
        return content.some((part, i) => part !== message.content[i])
            ? { ...message, content }
            : message
    })
    request.messages = request.messages.map((message) => {
        const tag = tags.get(message.id ?? "")
        if (!tag || (message.role !== "user" && message.role !== "assistant")) return message
        const toolIds = message.content.flatMap((part) => toolPartId(part, "tool-call") ?? [])
        const boundary = toolIds.some((id) => boundaryCalls.has(id))
        if (
            message.role === "assistant" &&
            !boundary &&
            toolIds.some((id) => annotatedCalls.has(id))
        )
            return message
        if (
            message.role === "assistant" &&
            !boundary &&
            !message.content.some(
                (part) =>
                    isRecord(part) &&
                    part.type === "text" &&
                    typeof part.text === "string" &&
                    part.text.trim(),
            )
        )
            return message
        const textIndexes = message.content.flatMap((part, i) =>
            isRecord(part) && part.type === "text" && typeof part.text === "string" ? [i] : [],
        )
        const selected = message.role === "user" || boundary ? textIndexes : textIndexes.slice(-1)
        if (selected.length === 0) {
            if (
                boundary ||
                (message.role === "assistant" &&
                    !message.content.some(
                        (part) =>
                            isRecord(part) &&
                            part.type === "text" &&
                            typeof part.text === "string" &&
                            part.text.trim(),
                    ))
            )
                return message
            return {
                ...message,
                content: [...message.content, { type: "text", text: tag.replace(/^\n+/, "") }],
            }
        }
        return {
            ...message,
            content: message.content.map((part, i) => {
                if (!selected.includes(i) || !isRecord(part)) return part
                const text = String(part.text).replace(/\n*$/, "")
                return { ...part, text: (text ? text + "\n\n" : "") + tag.replace(/^\n+/, "") }
            }),
        }
    })
}

export function injectContextMemo(
    request: ModelContextRequest,
    memoText: string,
    lastSummaryId?: string,
): void {
    request.messages = request.messages.filter((message) => message.id !== DCP_MEMO_MESSAGE_ID)
    if (memoText.length === 0) return
    const hasUserContent = request.messages.some(
        (message) => message.role === "user" && message.content.length > 0,
    )
    if (!hasUserContent) return
    const summaryIndex =
        lastSummaryId === undefined
            ? -1
            : request.messages.findIndex((message) => message.id === lastSummaryId)
    request.messages.splice(summaryIndex + 1, 0, {
        id: DCP_MEMO_MESSAGE_ID,
        role: "user",
        content: [{ type: "text", text: memoText }],
    })
}
