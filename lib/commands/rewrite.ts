import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { parseBlockRef } from "../message-ids"
import { getCurrentParams } from "../token-utils"
import { sendIgnoredMessage } from "../ui/notification"

function parseBlockIdArg(arg: string): number | null {
    const normalized = arg.trim().toLowerCase()
    const blockRef = parseBlockRef(normalized)
    if (blockRef !== null) return blockRef
    if (!/^[1-9]\d*$/.test(normalized)) return null
    const parsed = Number.parseInt(normalized, 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export interface RewriteCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

export async function handleRewriteCommand(ctx: RewriteCommandContext): Promise<string | null> {
    const { client, state, logger, sessionId, messages, args } = ctx

    const params = getCurrentParams(state, messages, logger)
    const blockIdArg = args[0]
    const aspect = args.slice(1).join(" ").trim()

    if (!blockIdArg) {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Usage: /dcp rewrite <n> [aspect]",
            params,
            logger,
        )
        return null
    }

    const blockId = parseBlockIdArg(blockIdArg)
    if (blockId === null) {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Invalid block number. Usage: /dcp rewrite <n> [aspect]",
            params,
            logger,
        )
        return null
    }

    const block = state.prune.messages.blocksById.get(blockId)
    if (!block) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Block ${blockIdArg} not found.`,
            params,
            logger,
        )
        return null
    }

    const aspectClause = aspect
        ? ` instruction: "${aspect}"`
        : ""

    const prompt = [
        `Rewrite the summary for compression block #${blockId}.`,
        `The current summary is visible in the context above (as an injected user message).${aspectClause}`,
        `After generating the rewritten version, use the rewrite_summary tool to save your result.`,
    ].join("\n")

    return prompt
}
