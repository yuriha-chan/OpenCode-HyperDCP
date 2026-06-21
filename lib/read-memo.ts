import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./compress/types"

export function createReadMemoTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: `Read the persistent memo block content.
You do not usually need to call this — the memo is visible just after the
last compressed block in the conversation. However, call this tool when
you are confused about the memo's current state to get the authoritative text.
No arguments needed — returns the full current memo text verbatim.`,
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
