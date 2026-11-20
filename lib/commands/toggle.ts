import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { parseBlockRef } from "../message-ids"
import { getCurrentParams } from "../token-utils"
import { truncate } from "../ui/utils"
import { countTokens } from "../token-utils"
import type { CommandSendMessage } from "./output"

function parseBlockIdArg(arg: string): number | null {
    const normalized = arg.trim().toLowerCase()
    const blockRef = parseBlockRef(normalized)
    if (blockRef !== null) return blockRef
    if (!/^[1-9]\d*$/.test(normalized)) return null
    const parsed = Number.parseInt(normalized, 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export interface ToggleCommandContext {
    sendMessage: CommandSendMessage
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

function formatVersionLabel(index: number): string {
    if (index === 0) return "disabled"
    return `v${index}`
}

function activeSummaryFor(block: {
    summary: string
    summaryVersions: string[]
    activeVersionIndex: number
}): string {
    const idx = block.activeVersionIndex
    if (idx === 0) return "(disabled)"
    if (
        idx >= 2 &&
        Array.isArray(block.summaryVersions) &&
        idx - 2 < block.summaryVersions.length
    ) {
        return block.summaryVersions[idx - 2]
    }
    return block.summary
        .replace(/^\[Compressed conversation section\]\s*/, "")
        .replace(/\s*<dcp-message-id[^>]*>b\d+<\/dcp-message-id>\s*$/, "")
        .trim()
}

export async function handleToggleCommand(ctx: ToggleCommandContext): Promise<void> {
    const { sendMessage, state, logger, sessionId, messages, args } = ctx

    const params = getCurrentParams(state, messages, logger)
    const blockIdArg = args[0]
    const versionArg = args[1]

    if (!blockIdArg) {
        await sendMessage("Usage: /dcp toggle <n> [version]", params)
        return
    }

    const blockId = parseBlockIdArg(blockIdArg)
    if (blockId === null) {
        await sendMessage("Invalid block number. Usage: /dcp toggle <n> [version]", params)
        return
    }

    const block = state.prune.messages.blocksById.get(blockId)
    if (!block) {
        await sendMessage(`Block ${blockIdArg} not found.`, params)
        return
    }

    const versions = Array.isArray(block.summaryVersions) ? block.summaryVersions : []

    if (versionArg === undefined) {
        const lines: string[] = []
        lines.push(`Block #${block.blockId} versions:`)
        lines.push(`  0 disabled: (summary pruned)`)
        const original = activeSummaryFor({ ...block, activeVersionIndex: 1 })
        lines.push(`  1 v1 (${countTokens(original)} tok): ${truncate(original, 120)}`)

        versions.forEach((v, i) => {
            lines.push(`  ${i + 2} v${i + 2} (${countTokens(v)} tok): ${truncate(v, 120)}`)
        })

        lines.push("")
        lines.push(`Active: ${formatVersionLabel(block.activeVersionIndex)}`)
        lines.push("")
        lines.push("Usage: /dcp toggle <n> <version>  — 0=disabled, 1=v1, 2=v2, ...")

        await sendMessage(lines.join("\n"), params)
        return
    }

    let newIndex: number

    const versionNum = Number.parseInt(versionArg, 10)
    if (!Number.isInteger(versionNum) || versionNum < 0) {
        await sendMessage(
            `Invalid version "${versionArg}". Use 0 for disabled, 1 for original, 2+ for rewrites.`,
            params,
        )
        return
    }

    if (versionNum === 0) {
        newIndex = 0
    } else if (versionNum === 1) {
        newIndex = 1
    } else {
        if (versionNum - 2 >= versions.length) {
            await sendMessage(
                `Version ${versionNum} does not exist. Available: 0 (disabled) through ${versions.length + 1} (v${versions.length + 1}).`,
                params,
            )
            return
        }
        newIndex = versionNum
    }

    block.activeVersionIndex = newIndex

    await sendMessage(
        `Block #${block.blockId} summary set to ${formatVersionLabel(newIndex)}.`,
        params,
    )
}
