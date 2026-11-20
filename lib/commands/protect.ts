import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { parseMessageRef } from "../message-ids"
import { getCurrentParams } from "../token-utils"
import type { CommandSendMessage } from "./output"

export interface ProtectCommandContext {
    sendMessage: CommandSendMessage
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

export async function handleProtectCommand(ctx: ProtectCommandContext): Promise<void> {
    const { sendMessage, state, logger, sessionId, messages, args } = ctx
    const params = getCurrentParams(state, messages, logger)
    const targetArg = args[0]

    if (!targetArg) {
        const refs = Array.from(state.protectedRefs).sort((a, b) => {
            const matchA = a.match(/^m(\d+)$/)
            const matchB = b.match(/^m(\d+)$/)
            if (matchA && matchB) {
                return Number.parseInt(matchA[1]) - Number.parseInt(matchB[1])
            }
            return a.localeCompare(b)
        })

        if (refs.length === 0) {
            await sendMessage("No messages are manually protected.", params)
            return
        }

        const lines: string[] = []
        lines.push(`${refs.length} protected message(s):`)
        for (const ref of refs) {
            const rawId = state.messageIds.byRef.get(ref)
            const suffix = rawId ? ` (${rawId})` : ""
            lines.push(`  ${ref}${suffix}`)
        }
        await sendMessage(lines.join("\n"), params)
        return
    }

    const ref = targetArg.trim().toLowerCase()
    const index = parseMessageRef(ref)

    let formattedRef: string
    if (index !== null) {
        formattedRef = `m${String(index).padStart(4, "0")}`
    } else if (/^m\d+$/i.test(ref)) {
        formattedRef = ref.replace(/^m/i, "m")
        const num = Number.parseInt(formattedRef.slice(1), 10)
        if (!Number.isInteger(num) || num < 1) {
            formattedRef = ""
        } else {
            formattedRef = `m${String(num).padStart(4, "0")}`
        }
    } else if (/^\d+$/.test(ref)) {
        const num = Number.parseInt(ref, 10)
        formattedRef = `m${String(num).padStart(4, "0")}`
    } else {
        formattedRef = ""
    }

    if (!formattedRef) {
        await sendMessage(
            "Please provide a valid message ID. Example: /dcp protect m0005 or /dcp protect 5",
            params,
        )
        return
    }

    if (!state.messageIds.byRef.has(formattedRef)) {
        await sendMessage(`Message ${formattedRef} is not in the current context.`, params)
        return
    }

    if (state.protectedRefs.has(formattedRef)) {
        await sendMessage(`Message ${formattedRef} is already protected.`, params)
        return
    }

    state.protectedRefs.add(formattedRef)
    await sendMessage(
        `Protected message ${formattedRef}. It will be excluded from compression.`,
        params,
    )
}
