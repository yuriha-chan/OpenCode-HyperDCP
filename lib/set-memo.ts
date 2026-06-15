import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./compress/types"
import { saveSessionState } from "./state/persistence"

export function createSetMemoTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: `Write or clear the persistent memo block that appears before all messages in every turn. Use this for durable task tracking, context notes, or any information that should persist across compressions and turns. Provide an empty string to clear the memo.`,
        args: {
            content: tool.schema
                .string()
                .describe("Memo content (plain text). Empty string clears the memo."),
        },
        async execute(args) {
            const input = args as { content: string }
            const trimmed = input.content.trim()
            ctx.state.memo = trimmed.length > 0 ? trimmed : null
            await saveSessionState(ctx.state, ctx.logger)
            return ctx.state.memo
                ? `Memo updated (${ctx.state.memo.length} chars).`
                : "Memo cleared."
        },
    })
}
