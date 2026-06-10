import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { assignMessageRefs, parseMessageRef } from "../message-ids"
import { isIgnoredUserMessage } from "../messages/query"
import { getCurrentParams } from "../token-utils"
import { sendIgnoredMessage } from "../ui/notification"

export interface MessagesCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

const TRUNCATE_LENGTH = 80

function toolPreview(part: any): string {
    const toolName = part.tool || "tool"
    const input = part.state?.input

    if (toolName === "read" && input?.filePath) {
        return `[read ${input.filePath}]`
    }
    if ((toolName === "edit" || toolName === "write") && input?.filePath) {
        return `[${toolName} ${input.filePath}]`
    }
    if (toolName === "bash" && input?.command) {
        const cmd = String(input.command).replace(/\s+/g, " ").trim()
        if (cmd.length > 50) return `[bash ${cmd.slice(0, 47)}...]`
        return `[bash ${cmd}]`
    }
    return `[${toolName}]`
}

function extractPreview(message: WithParts): string {
    const parts = Array.isArray(message.parts) ? message.parts : []
    for (const part of parts) {
        if (part.type === "text" && part.text) {
            const text = part.text.replace(/\s+/g, " ").trim()
            if (text.length > TRUNCATE_LENGTH) {
                return text.slice(0, TRUNCATE_LENGTH) + "..."
            }
            return text
        }
        if (part.type === "tool" && (part as any).tool) {
            return toolPreview(part)
        }
    }
    return "(empty)"
}

function isCompressed(state: SessionState, rawId: string): boolean {
    const entry = state.prune.messages.byMessageId.get(rawId)
    return entry !== undefined && entry.activeBlockIds.length > 0
}

export async function handleMessagesCommand(ctx: MessagesCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages, args } = ctx
    const params = getCurrentParams(state, messages, logger)

    assignMessageRefs(state, messages)

    const visibleMessages = messages.filter((m) => !isIgnoredUserMessage(m))

    let startRef: string | null = null
    let endRef: string | null = null

    if (args.length >= 2) {
        const startIdx = parseMessageRef(args[0] || "")
        const endIdx = parseMessageRef(args[1] || "")
        if (startIdx !== null && endIdx !== null) {
            startRef = `m${String(startIdx).padStart(4, "0")}`
            endRef = `m${String(endIdx).padStart(4, "0")}`
        }
    } else if (args.length === 1) {
        const idx = parseMessageRef(args[0] || "")
        if (idx !== null) {
            startRef = `m${String(idx).padStart(4, "0")}`
            endRef = startRef
        }
    }

    let selected: WithParts[]
    if (startRef && endRef) {
        const startRawId = state.messageIds.byRef.get(startRef)
        const endRawId = state.messageIds.byRef.get(endRef)
        const startIndex = startRawId ? visibleMessages.findIndex((m) => m.info.id === startRawId) : -1
        const endIndex = endRawId ? visibleMessages.findIndex((m) => m.info.id === endRawId) : -1
        if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
            await sendIgnoredMessage(
                client, sessionId,
                "Invalid message range. Use /dcp messages m0001 m0005 format.",
                params, logger,
            )
            return
        }
        selected = visibleMessages.slice(startIndex, endIndex + 1)
    } else {
        const take = Math.min(10, visibleMessages.length)
        selected = visibleMessages.slice(visibleMessages.length - take)
    }

    if (selected.length === 0) {
        await sendIgnoredMessage(client, sessionId, "No messages to display.", params, logger)
        return
    }

    const lines: string[] = []
    lines.push(`${selected.length} message(s):`)

    for (const msg of selected) {
        const ref = state.messageIds.byRawId.get(msg.info.id) || msg.info.id
        const role = msg.info.role || "?"
        const preview = extractPreview(msg)
        const protected_ = state.protectedRefs.has(ref)
        const compressed = isCompressed(state, msg.info.id)
        const status = protected_ ? "P" : compressed ? "C" : "-"
        lines.push(`  ${ref}  ${status} ${role.padEnd(9)} ${preview}`)
    }

    await sendIgnoredMessage(client, sessionId, lines.join("\n"), params, logger)
}
