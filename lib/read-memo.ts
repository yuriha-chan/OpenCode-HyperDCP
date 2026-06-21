import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./compress/types"

export function createReadMemoTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: `Read the persistent memo block content.
No arguments needed — returns the full current memo text verbatim.
Use this to see the exact memo content before calling edit_memo.`,
        args: {},
        async execute() {
            const memo = ctx.state.memo
            if (memo && memo.trim().length > 0) {
                return memo
            }
            return "(memo is empty)"
        },
    })
}
