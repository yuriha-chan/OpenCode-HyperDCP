import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./compress/types"
import type { CompressionBlock } from "./state/types"

function versionLabel(block: CompressionBlock, idx: number): string {
    if (idx < 0) return ""
    if (idx === 0) return "disabled"
    if (idx === 1) return "v1 (original)"
    return `v${idx} (rewrite)`
}

function getVersionContent(block: CompressionBlock, idx: number): string | null {
    if (idx < 0) return null
    if (idx === 0) return null
    if (idx === 1) return block.summary
    const vIdx = idx - 2
    if (vIdx < block.summaryVersions.length) return block.summaryVersions[vIdx]
    return null
}

function describeVersion(block: CompressionBlock, idx: number): string {
    const label = versionLabel(block, idx)
    if (idx === 0) return `${label}: not displayed`
    if (idx === 1) {
        const preview = block.summary.length > 120
            ? block.summary.slice(0, 120) + "..."
            : block.summary
        return `${label}: ${preview}`
    }
    const vIdx = idx - 2
    if (vIdx < block.summaryVersions.length) {
        const content = block.summaryVersions[vIdx]
        const preview = content.length > 120
            ? content.slice(0, 120) + "..."
            : content
        return `${label}: ${preview}`
    }
    return `${label}: (not found)`
}

export function createFetchSummaryVersionsTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: `Fetch all summary versions for a compressed block.

Returns the original summary, every rewrite version, and the currently active version.
Use this to inspect available versions before deciding to edit, revert, or rewrite.

THE FORMAT
{
  blockId: number,
  version?: number    // Optional: return full text of this version (e.g. 1 for original, 2+ for rewrites)
}`,
        args: {
            blockId: tool.schema.number().describe("Block ID to inspect (e.g. 3)"),
            version: tool.schema.number().optional().describe("Optional: return full text of this version (1=original, 2+=rewrite)"),
        },
        async execute(args) {
            const input = args as { blockId: number; version?: number }
            const block = ctx.state.prune.messages.blocksById.get(input.blockId)
            if (!block) throw new Error(`Block ${input.blockId} not found.`)

            // If version specified, return full text of that version
            if (input.version !== undefined) {
                const content = getVersionContent(block, input.version)
                if (content === null) {
                    throw new Error(`Version ${input.version} not found for block ${input.blockId}.`)
                }
                const label = versionLabel(block, input.version)
                return `Block #${block.blockId} — ${block.topic}\n${label}:\n\n${content}`
            }

            const lines: string[] = []
            lines.push(`Block #${block.blockId} — ${block.topic}`)
            lines.push(`Status: ${block.active ? "active" : block.deactivatedByUser ? "decompressed by user" : "inactive"}`)
            lines.push(`Active version: ${versionLabel(block, block.activeVersionIndex)}`)
            lines.push("")

            // List all available versions
            const totalVersions = 1 + block.summaryVersions.length
            lines.push(`${totalVersions} version(s) available:`)
            lines.push(`  ${describeVersion(block, 1)}`)

            for (let i = 0; i < block.summaryVersions.length; i++) {
                const vIdx = i + 2
                const active = vIdx === block.activeVersionIndex ? "  ← active" : ""
                lines.push(`  ${describeVersion(block, vIdx)}${active}`)
            }

            if (block.pendingEditBuffer !== undefined) {
                const preview = block.pendingEditBuffer.length > 120
                    ? block.pendingEditBuffer.slice(0, 120) + "..."
                    : block.pendingEditBuffer
                lines.push("")
                lines.push(`Pending edit buffer (${block.pendingEditBuffer.length} chars):`)
                lines.push(`  ${preview}`)
                lines.push(`  (use save_summary to commit, or edit_summary/append_summary to modify)`)
            }

            return lines.join("\n")
        },
    })
}
