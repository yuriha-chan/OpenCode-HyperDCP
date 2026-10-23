import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./compress/types"
import { draftState } from "./housekeeping/state"
import { loadAndReconcileSession } from "./housekeeping/state"
import { withSessionCoordinator } from "./housekeeping/coordinator"
import { renderMemo } from "./memo"

export function createReadMemoTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: `Read the persistent memo block content.
You do not usually need to call this — the memo is visible just after the
last compressed block in the conversation. However, call this tool when
you are confused about the memo's current state to get the authoritative text.
No arguments needed — returns the full current memo text verbatim.`,
        args: {},
        async execute(_args, toolContext) {
            return withSessionCoordinator(ctx.state, async () => {
                await loadAndReconcileSession(ctx, toolContext.sessionID)
                const memo = (ctx.state.housekeeping ? draftState(ctx.state) : ctx.state).memo
                if (!memo) return "(memo is empty)"
                const rendered = renderMemo(memo)
                return rendered.trim().length > 0 ? rendered : "(memo is empty)"
            })
        },
    })
}
