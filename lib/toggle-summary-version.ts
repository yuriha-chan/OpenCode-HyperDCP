import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./compress/types"
import type { CompressionBlock } from "./state/types"
import { saveSessionState } from "./state/persistence"

interface ToggleSummaryVersionArgs {
    blockId: number
    version: number
}

function versionLabel(idx: number): string {
    if (idx === 0) return "disabled"
    return `v${idx}`
}

function validateVersion(block: CompressionBlock, version: number): number {
    if (!Number.isInteger(version) || version < 0) {
        throw new Error(
            `Invalid version "${version}". Use 0 for disabled, 1 for original, 2+ for rewrites.`,
        )
    }
    if (version === 0) return 0
    if (version === 1) return 1
    if (version - 2 < block.summaryVersions.length) return version
    throw new Error(
        `Version ${version} does not exist. Available: 0 (disabled) through ${block.summaryVersions.length + 1}.`,
    )
}

export function createToggleSummaryVersionTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: `Switch the active summary version of a compressed block.

Use after calling fetch_summary_versions to inspect available versions, then call this tool to switch.
Version 0 disables the summary (block content is no longer summarized in context).
Version 1 is the original summary produced at compression time.
Versions 2+ are rewrite summaries produced via rewrite_summary or edit_summary.

Requires /dcp autotoggle on to be enabled in the session.

THE FORMAT
{
  blockId: number,    // Block ID to toggle (e.g. 3)
  version: number     // Target version: 0=disabled, 1=original, 2+=rewrite
}`,
        args: {
            blockId: tool.schema.number().describe("Block ID whose summary version to switch (e.g. 3)"),
            version: tool.schema.number().describe("Target version: 0=disabled, 1=original, 2+=rewrite"),
        },
        async execute(args) {
            const input = args as ToggleSummaryVersionArgs

            if (!ctx.state.autotoggle) {
                throw new Error(
                    "Autotoggle is disabled. Run /dcp autotoggle on to allow the LLM to toggle summary versions.",
                )
            }

            const block = ctx.state.prune.messages.blocksById.get(input.blockId)
            if (!block) {
                throw new Error(
                    `Block ${input.blockId} not found. Use fetch_summary_versions to inspect blocks.`,
                )
            }

            const newIndex = validateVersion(block, input.version)
            block.activeVersionIndex = newIndex

            await saveSessionState(ctx.state, ctx.logger)

            return `Block #${block.blockId} summary set to ${versionLabel(newIndex)}.`
        },
    })
}
