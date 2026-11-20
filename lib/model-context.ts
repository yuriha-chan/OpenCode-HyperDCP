import type { SessionRequest, SessionRequestMessage } from "@opencode/plugin/promise/session"
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
import type { CompressionBlock } from "./state/types"
import { selectProtectedSubagents, renderProtectedSubagents } from "./subagents/protection"

export function injectContextSubagents(
    request: ModelContextRequest,
    state: SessionState,
    config: PluginConfig,
    lastSummary?: { messageId: string; block: CompressionBlock },
): void {
    const messages = request.messages.filter((message) => message.id !== "msg_dcp_subagents")
    request.messages = messages
    if (!messages.some((message) => message.role === "user" && message.content.length > 0)) return
    const text = renderProtectedSubagents(
        selectProtectedSubagents(
            state.subagentExecutions,
            config.compress.protectSubagent,
            lastSummary?.block,
        ),
        config.compress.protectSubagent,
        state.messageIds,
    )
    if (!text) return
    let index = 0
    for (const [position, message] of messages.entries()) {
        if (
            message.id?.startsWith("msg_dcp_skill_") ||
            message.id === "msg_dcp_memo" ||
            message.id === lastSummary?.messageId
        )
            index = position + 1
    }
    request.messages = [
        ...messages.slice(0, index),
        { id: "msg_dcp_subagents", role: "user", content: [{ type: "text", text }] },
        ...messages.slice(index),
    ]
}

export type ModelContextRequest = Pick<SessionRequest, "messages" | "options">
type MessagePart = SessionRequestMessage["content"][number]

function mapMessageParts(
    message: SessionRequestMessage,
    transform: <Part extends MessagePart>(part: Part, index: number) => Part | undefined,
): SessionRequestMessage {
    const map = <Part extends MessagePart>(content: readonly Part[]): Part[] =>
        content.flatMap((part, index) => {
            const updated = transform(part, index)
            return updated === undefined ? [] : [updated]
        })
    switch (message.role) {
        case "system":
            return { ...message, content: map(message.content) }
        case "user":
            return { ...message, content: map(message.content) }
        case "assistant":
            return { ...message, content: map(message.content) }
        case "tool":
            return { ...message, content: map(message.content) }
    }
}

function insertMessageText<
    Message extends Extract<SessionRequestMessage, { role: "user" | "assistant" }>,
>(message: Message, text: string, index: number): Message {
    return {
        ...message,
        content: [
            ...message.content.slice(0, index),
            { type: "text" as const, text },
            ...message.content.slice(index),
        ],
    }
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
    const skills = records.flatMap((record): SessionRequestMessage[] => {
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
                const textIndex =
                    message.role === "user"
                        ? message.content.findLastIndex(
                              (part) =>
                                  isRecord(part) &&
                                  part.type === "text" &&
                                  typeof part.text === "string",
                          )
                        : message.content.findIndex(
                              (part) =>
                                  isRecord(part) &&
                                  part.type === "text" &&
                                  typeof part.text === "string",
                          )
                if (textIndex >= 0) {
                    return mapMessageParts(message, (part, index) => {
                        if (index !== textIndex || part.type !== "text") return part
                        const updated = { text: part.text }
                        appendToTextPart(updated, text)
                        return { ...part, text: updated.text }
                    })
                }
                const toolIndex = message.content.findIndex(
                    (part) => toolPartId(part, "tool-call") !== undefined,
                )
                return insertMessageText(
                    message,
                    text,
                    toolIndex < 0 ? message.content.length : toolIndex,
                )
            })
        },
    )
}

const DCP_TAG_STOPS = ["<dcp-", "</dcp-"]
const DCP_MEMO_MESSAGE_ID = "msg_dcp_memo"

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}

function stripText<Value extends Record<string, unknown>>(value: Value, key: string): Value {
    const original = value[key]
    if (typeof original !== "string") return value
    const clean = stripHallucinationsFromString(original)
    return clean === original ? value : { ...value, [key]: clean }
}

function stripTextPart<
    Part extends
        MessagePart | { type: "text"; text: string } | { type: "file"; uri: string; mime: string },
>(part: Part): Part {
    return isRecord(part) && part.type === "text" ? stripText(part, "text") : part
}

function stripPart<Part extends MessagePart>(part: Part): Part {
    if (!isRecord(part) || part.type !== "tool-result" || !isRecord(part.result)) {
        return stripTextPart(part)
    }
    if (part.result.type === "text") {
        const result = stripText(part.result, "value")
        return result === part.result ? part : { ...part, result }
    }
    if (part.result.type === "content" && Array.isArray(part.result.value)) {
        const content = part.result.value
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
        const projected = mapMessageParts(message, (part) => {
            if (part.type !== "tool-result") return hidden[position++] > 0 ? undefined : part
            const call = calls.get(part.id)
            if (call == null) return part
            if (hidden[call] > 0) return undefined
            const edit = boundaryEdits.get(call)
            return edit && part.result.type !== "error"
                ? { ...part, result: { type: "text" as const, value: edit.output } }
                : part
        })
        const content = projected.content
        if (
            content.length === message.content.length &&
            content.every((part, i) => part === message.content[i])
        ) {
            return [message]
        }
        return content.length > 0 ? [projected] : []
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
        const projected = mapMessageParts(message, stripPart)
        return projected.content.some((part, i) => part !== message.content[i])
            ? projected
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
): { messageId: string; block: CompressionBlock } | undefined {
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
    let lastSummary: { messageId: string; block: CompressionBlock } | undefined
    for (const message of request.messages) {
        if (message.role === "user" && message.content.length > 0) hasUser = true
        const summary =
            message.id === undefined
                ? undefined
                : contextBlockSummary(state, logger, config, message.id)
        if (summary) {
            if (hasUser) {
                const messageId = `msg_dcp_block_${summary.block.blockId}_${summary.block.anchorMessageId}`
                lastSummary = { messageId, block: summary.block }
                result.push({
                    id: messageId,
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
        const projected = mapMessageParts(message, (part) => {
            const id = toolPartId(part, "tool-result")
            return id !== undefined && calls.get(id) === true ? undefined : part
        })
        const content = projected.content
        if (content.length === message.content.length) result.push(message)
        else if (content.length > 0) result.push(projected)
    }
    request.messages = result
    return lastSummary
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
        const projected = mapMessageParts(message, (part) => {
            if (part.type !== "tool-result") return part
            const id = toolPartId(part, "tool-result")
            const tag = id === undefined ? undefined : calls.get(id)
            if (!tag || part.result.type === "error") return part
            if (part.result.type === "text" && typeof part.result.value === "string") {
                annotatedCalls.add(id!)
                return { ...part, result: { ...part.result, value: part.result.value + tag } }
            }
            if (part.result.type === "content" && Array.isArray(part.result.value)) {
                const values = part.result.value
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
                                i === index && value.type === "text"
                                    ? { ...value, text: value.text + tag }
                                    : value,
                            ),
                        },
                    }
                }
            }
            return part
        })
        return projected.content.some((part, i) => part !== message.content[i])
            ? projected
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
            return insertMessageText(message, tag.replace(/^\n+/, ""), message.content.length)
        }
        return mapMessageParts(message, (part, i) => {
            if (!selected.includes(i) || part.type !== "text") return part
            const text = String(part.text).replace(/\n*$/, "")
            return { ...part, text: (text ? text + "\n\n" : "") + tag.replace(/^\n+/, "") }
        })
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
