import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./compress/types"
import { REWRITE_SUMMARY, REWRITE_FORMAT_EXTENSION } from "./prompts/rewrite-summary"
import { runHousekeepingMutation } from "./housekeeping/state"
import { materializePendingSummary } from "./expand-block"

interface RewriteSummaryArgs {
    blockId: number
    summary: string
}

function buildSchema() {
    return {
        blockId: tool.schema.number().describe("Block ID to rewrite (e.g. 1)"),
        summary: tool.schema
            .string()
            .describe("The complete rewritten summary to save as a new version"),
    }
}

export function createRewriteSummaryTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()

    return tool({
        description: (runtimePrompts as any).rewriteSummary + REWRITE_FORMAT_EXTENSION,
        args: buildSchema(),
        async execute(args, toolCtx) {
            return runHousekeepingMutation(
                ctx,
                toolCtx,
                "rewrite_summary",
                args,
                async (operationCtx) => {
                    const input = args as RewriteSummaryArgs

                    const block = operationCtx.state.prune.messages.blocksById.get(input.blockId)
                    if (!block) {
                        throw new Error(
                            `Block ${input.blockId} not found. Use /dcp view to see available blocks.`,
                        )
                    }

                    const trimmed = input.summary.trim()
                    if (!trimmed) {
                        throw new Error("Summary must not be empty.")
                    }

                    materializePendingSummary(block)

                    if (!Array.isArray(block.summaryVersions)) {
                        block.summaryVersions = []
                    }

                    block.summaryVersions.push(trimmed)
                    block.activeVersionIndex = block.summaryVersions.length + 1

                    const versionLabel = block.activeVersionIndex
                    return `Rewrote summary for block ${input.blockId} (v${versionLabel} now active). Previous versions can be toggled with /dcp toggle ${input.blockId}.`
                },
            )
        },
    })
}
