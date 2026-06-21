import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./compress/types"
import { saveSessionState } from "./state/persistence"

export function createEditMemoTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: `Edit the persistent memo block with surgical string replacement.
This is the only way to update the memo — no bulk-set equivalent exists.
Keep oldString short (typically 2-3 lines). Match only the surgical fragment to replace.
The memo stores working commands, user constraints, and temporary states — reusable short memories that would otherwise evaporate. It is NOT a history record (that is what compression blocks are for).
Entire memo size should be kept around <1.5K tokens. Keep references & guardrails.

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
                throw new Error(
                    `oldString and newString must differ (both are ${JSON.stringify(input.oldString)})`,
                )
            }
            const current = ctx.state.memo ?? ""
            if (input.replaceAll) {
                if (!current.includes(input.oldString)) {
                    throw new Error(
                        `Old string ${JSON.stringify(input.oldString)} not found in memo. ` +
                        `Match oldString exactly — watch for leading/trailing whitespace, ` +
                        `line breaks, and indentation. The memo content is visible in your ` +
                        `conversation context above.`,
                    )
                }
                ctx.state.memo = current.split(input.oldString).join(input.newString)
            } else {
                const idx = current.indexOf(input.oldString)
                if (idx === -1) {
                    throw new Error(
                        `Old string ${JSON.stringify(input.oldString)} not found in memo. ` +
                        `Match oldString exactly — watch for leading/trailing whitespace, ` +
                        `line breaks, and indentation. The memo content is visible in your ` +
                        `conversation context above.`,
                    )
                }
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
