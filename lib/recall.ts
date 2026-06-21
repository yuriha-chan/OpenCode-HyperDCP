import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./compress/types"
import type { WithParts } from "./state"
import { RECALL_COMPRESSED, RECALL_FORMAT_EXTENSION } from "./prompts/recall"
import { fetchSessionMessages } from "./compress/search"
import { parseMessageRef } from "./message-ids"
import { isIgnoredUserMessage } from "./messages/query"
import { countAllMessageTokens } from "./token-utils"
import { formatTokenCount } from "./ui/utils"

interface RecallArgs {
    action: "get" | "search"
    blockId?: number
    messageId?: string
    messageIdStart?: string
    messageIdEnd?: string
    query?: string
    blockIdStart?: number
    blockIdEnd?: number
}

function buildSchema() {
    return {
        action: tool.schema
            .enum(["get", "search"])
            .describe("The action: 'get' to retrieve original messages, 'search' to find text"),
        blockId: tool.schema.number().optional().describe("Block ID to scope 'search' (e.g. 3)"),
        messageId: tool.schema
            .string()
            .optional()
            .describe("Raw message ID (e.g. 'm0005') to retrieve via 'get'"),
        messageIdStart: tool.schema
            .string()
            .optional()
            .describe("Start of message ID range (e.g. 'm0005') for 'get' or 'search'"),
        messageIdEnd: tool.schema
            .string()
            .optional()
            .describe("End of message ID range (e.g. 'm0020') for 'get' or 'search'"),
        query: tool.schema
            .string()
            .optional()
            .describe("Text or regex pattern to search for (required for 'search')"),
        blockIdStart: tool.schema
            .number()
            .optional()
            .describe("Scope 'search' to messages from this block ID (inclusive)"),
        blockIdEnd: tool.schema
            .number()
            .optional()
            .describe("Scope 'search' to messages up to this block ID (inclusive)"),
    }
}

function formatMessage(msg: WithParts): string {
    const role = msg.info.role || "unknown"
    const lines: string[] = []
    lines.push(`--- ${role} ---`)

    for (const part of Array.isArray(msg.parts) ? msg.parts : []) {
        if (part.type === "text" && part.text) {
            lines.push(part.text)
        } else if (part.type === "tool" && (part as any).state?.output) {
            const toolName = (part as any).tool || "tool"
            const output =
                typeof (part as any).state.output === "string"
                    ? (part as any).state.output
                    : JSON.stringify((part as any).state.output)
            lines.push(`[tool:${toolName}] ${output}`)
        }
    }
    return lines.join("\n")
}

function resolveRefToRawId(ctx: ToolContext, ref: string): string | null {
    const rawId = ctx.state.messageIds.byRef.get(ref)
    if (rawId) return rawId
    return null
}

function findMessageIndex(messages: WithParts[], rawId: string | null): number {
    if (!rawId) return -1
    for (let i = 0; i < messages.length; i++) {
        if (messages[i]?.info.id === rawId) return i
    }
    return -1
}

function collectMessageIdsForBlock(ctx: ToolContext, blockId: number): string[] | null {
    const block = ctx.state.prune.messages.blocksById.get(blockId)
    if (!block) return null
    return [...block.effectiveMessageIds]
}

function collectMessageIdsForBlockRange(ctx: ToolContext, start: number, end: number): string[] {
    const ids = new Set<string>()
    for (const [id, block] of ctx.state.prune.messages.blocksById) {
        if (id >= start && id <= end) {
            for (const msgId of block.effectiveMessageIds) {
                ids.add(msgId)
            }
        }
    }
    return [...ids]
}

function collectMessageIdsForMessageRange(
    ctx: ToolContext,
    messages: WithParts[],
    startRef: string,
    endRef: string,
): string[] {
    const startRawId = resolveRefToRawId(ctx, startRef)
    const endRawId = resolveRefToRawId(ctx, endRef)

    const startIdx = findMessageIndex(messages, startRawId)
    const endIdx = findMessageIndex(messages, endRawId)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return []

    const ids: string[] = []
    for (let i = startIdx; i <= endIdx; i++) {
        const msg = messages[i]
        if (msg && !isIgnoredUserMessage(msg)) {
            ids.push(msg.info.id)
        }
    }
    return ids
}

function searchMessages(messages: WithParts[], messageIds: Set<string>, query: string, byRawId: Map<string, string>): string {
    let pattern: RegExp
    try {
        pattern = new RegExp(query, "i")
    } catch {
        throw new Error(`Invalid search pattern: ${query}`)
    }
    const matchingMessages: Array<{ msg: WithParts; matchText: string }> = []

    for (const msg of messages) {
        if (!messageIds.has(msg.info.id)) continue

        const textParts: string[] = []
        for (const part of Array.isArray(msg.parts) ? msg.parts : []) {
            if (part.type === "text" && part.text) textParts.push(part.text)
            else if (part.type === "tool" && (part as any).state?.output) {
                textParts.push(
                    typeof (part as any).state.output === "string"
                        ? (part as any).state.output
                        : JSON.stringify((part as any).state.output),
                )
            }
        }
        const fullText = textParts.join(" ")

        if (pattern.test(fullText)) {
            const matchStart = fullText.search(pattern)
            const contextStart = Math.max(0, matchStart - 40)
            const contextEnd = Math.min(fullText.length, matchStart + query.length + 40)
            let snippet = fullText.slice(contextStart, contextEnd)
            if (contextStart > 0) snippet = "..." + snippet
            if (contextEnd < fullText.length) snippet = snippet + "..."
            matchingMessages.push({ msg, matchText: snippet })
        }
    }

    if (matchingMessages.length === 0) {
        return "No matches found for the query."
    }

    const lines: string[] = []
    lines.push(`Found ${matchingMessages.length} match(es):`)
    lines.push("")

    for (const { msg, matchText } of matchingMessages) {
        const tokenCount = countAllMessageTokens(msg)
        const displayId = byRawId.get(msg.info.id) ?? msg.info.id
        lines.push(`  ${displayId} (${msg.info.role}, ~${formatTokenCount(tokenCount)})`)
        lines.push(`  ${matchText}`)
        lines.push("")
    }

    return lines.join("\n")
}

export function createRecallCompressedTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()

    return tool({
        description: runtimePrompts.recallCompressed + RECALL_FORMAT_EXTENSION,
        args: buildSchema(),
        async execute(args, toolCtx) {
            const input = args as RecallArgs

            const rawMessages = await fetchSessionMessages(ctx.client, toolCtx.sessionID)

            if (input.action === "get") {
                return handleGet(ctx, rawMessages, input)
            }

            if (input.action === "search") {
                return handleSearch(ctx, rawMessages, input)
            }

            throw new Error(`Unknown action: ${input.action}`)
        },
    })
}

function handleGet(ctx: ToolContext, messages: WithParts[], input: RecallArgs): string {
    let targetIds: string[] | null = null
    let label = ""

    if (input.messageId) {
        const rawId = resolveRefToRawId(ctx, input.messageId)
        if (!rawId) {
            throw new Error(`Message ${input.messageId} not found in context.`)
        }
        targetIds = [rawId]
        label = `Message ${input.messageId}`
    } else if (input.messageIdStart && input.messageIdEnd) {
        targetIds = collectMessageIdsForMessageRange(
            ctx,
            messages,
            input.messageIdStart,
            input.messageIdEnd,
        )
        label = `Messages ${input.messageIdStart} → ${input.messageIdEnd}`
    } else if (input.blockId !== undefined) {
        throw new Error(
            `Cannot use blockId with action "get". ` +
            `Use fetch_summary_versions to inspect a block's summary, ` +
            `or provide a messageId (e.g. "m0100") to retrieve raw messages.`,
        )
    } else {
        throw new Error(
            `Provide a messageId (e.g. "m0100") or ` +
            `messageIdStart/messageIdEnd to retrieve raw messages. ` +
            `To inspect a block summary use fetch_summary_versions.`,
        )
    }

    if (!targetIds || targetIds.length === 0) {
        return `${label}: no messages found.`
    }

    const targetSet = new Set(targetIds)
    const matchingMessages = messages.filter((m) => targetSet.has(m.info.id))

    if (matchingMessages.length === 0) {
        return `${label}: no messages found in session.`
    }

    const totalTokens = matchingMessages.reduce((sum, m) => sum + countAllMessageTokens(m), 0)
    const lines: string[] = []
    lines.push(
        `${label} — ${matchingMessages.length} message(s), ~${formatTokenCount(totalTokens)}`,
    )
    lines.push("")

    for (const msg of matchingMessages) {
        lines.push(formatMessage(msg))
        lines.push("")
    }

    return lines.join("\n")
}

function handleSearch(ctx: ToolContext, messages: WithParts[], input: RecallArgs): string {
    if (!input.query) {
        throw new Error("Query is required for search action.")
    }

    let targetIds: string[]

    if (input.blockId !== undefined) {
        const ids = collectMessageIdsForBlock(ctx, input.blockId)
        if (ids === null) {
            throw new Error(`Block ${input.blockId} not found.`)
        }
        targetIds = ids
    } else if (input.blockIdStart !== undefined && input.blockIdEnd !== undefined) {
        targetIds = collectMessageIdsForBlockRange(ctx, input.blockIdStart, input.blockIdEnd)
    } else if (input.messageIdStart && input.messageIdEnd) {
        targetIds = collectMessageIdsForMessageRange(
            ctx,
            messages,
            input.messageIdStart,
            input.messageIdEnd,
        )
    } else {
        targetIds = []
        for (const block of ctx.state.prune.messages.blocksById.values()) {
            for (const msgId of block.effectiveMessageIds) {
                targetIds.push(msgId)
            }
        }
    }

    if (targetIds.length === 0) {
        return "No messages to search."
    }

    return searchMessages(messages, new Set(targetIds), input.query, ctx.state.messageIds.byRawId)
}
