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

export function createEditMemoTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: `Edit the persistent memo block with surgical string replacement.
Provide only the text to replace as oldString — not the entire memo.
Use set_memo to replace the entire memo.
The memo stores working commands, user constraints, task tracking, and durable state that persists across compressions.

THE FORMAT
{
  oldString: string,        // Text to find and replace
  newString: string,        // Replacement text (must differ from old)
  replaceAll?: boolean      // Replace all occurrences (default: first only)
}`,
        args: {
            oldString: tool.schema.string().describe("Text to find and replace"),
            newString: tool.schema.string().describe("Replacement text"),
            replaceAll: tool.schema.boolean().describe("Replace all occurrences (default false)"),
        },
        async execute(args) {
            const input = args as { oldString: string; newString: string; replaceAll?: boolean }
            if (input.oldString === input.newString) {
                throw new Error("oldString and newString must differ")
            }
            const current = ctx.state.memo ?? ""
            if (input.replaceAll) {
                if (!current.includes(input.oldString)) {
                    throw new Error("Old string not found in memo.")
                }
                ctx.state.memo = current.split(input.oldString).join(input.newString)
            } else {
                const idx = current.indexOf(input.oldString)
                if (idx === -1) throw new Error("Old string not found in memo.")
                ctx.state.memo =
                    current.slice(0, idx) +
                    input.newString +
                    current.slice(idx + input.oldString.length)
            }
            const trimmed = ctx.state.memo.trim()
            ctx.state.memo = trimmed.length > 0 ? trimmed : null
            await saveSessionState(ctx.state, ctx.logger)
            return ctx.state.memo
                ? `Memo edited (${ctx.state.memo.length} chars).`
                : "Memo cleared."
        },
    })
}
