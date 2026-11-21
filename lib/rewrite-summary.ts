import { tool } from "@opencode-ai/plugin"
import { summaryDocument } from "./summary-text"
import type { ToolContext } from "./compress/types"
import { REWRITE_FORMAT_EXTENSION } from "./prompts/rewrite-summary"
import type { PromptStore } from "./prompts/store"
import { loadAndReconcileSession, runSharedHousekeepingMutation } from "./housekeeping/state"
import type { SharedOperationContext, ToolExecutionContext } from "./housekeeping/types"
import { materializePendingSummary } from "./expand-block"

export interface RewriteSummaryInput {
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

export function renderRewriteSummaryDescription(prompts: PromptStore): string {
    prompts.reload()
    return prompts.getRuntimePrompts().rewriteSummary + REWRITE_FORMAT_EXTENSION
}

export async function rewriteSummary(
    ctx: SharedOperationContext,
    toolContext: ToolExecutionContext,
    input: RewriteSummaryInput,
): Promise<string> {
    return runSharedHousekeepingMutation(
        ctx,
        toolContext,
        "rewrite_summary",
        input,
        async (operationCtx) => {
            const block = operationCtx.state.prune.messages.blocksById.get(input.blockId)
            if (!block) {
                throw new Error(
                    `Block ${input.blockId} not found. Use /dcp view to see available blocks.`,
                )
            }

            const trimmed = summaryDocument(input.summary).trim()
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
}

export function createRewriteSummaryTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: renderRewriteSummaryDescription(ctx.prompts),
        args: buildSchema(),
        async execute(args, toolCtx) {
            return rewriteSummary(
                {
                    ...ctx,
                    refreshSession: (sessionID) => loadAndReconcileSession(ctx, sessionID),
                },
                toolCtx,
                args as RewriteSummaryInput,
            )
        },
    })
}
