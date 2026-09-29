import type { SessionState } from "../state"
import { isIgnoredUserMessage } from "../messages/query"
import { getFilePathsFromParameters, isFilePathProtected } from "../protected-patterns"
import {
    resolveProtectedTool,
    truncateText,
    type CompressProtectedToolSpec,
    type ProtectedToolsConfig,
} from "../protected-tools"
import {
    buildSubagentResultText,
    getSubAgentId,
    mergeSubagentResult,
} from "../subagents/subagent-results"
import { fetchSessionMessages } from "./search"
import type { SearchContext, SelectionResolution } from "./types"

export function appendProtectedUserMessages(
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
    state: SessionState,
    enabled: boolean,
): string {
    if (!enabled) return summary

    const userTexts: string[] = []

    for (const messageId of selection.messageIds) {
        const existingCompressionEntry = state.prune.messages.byMessageId.get(messageId)
        if (existingCompressionEntry && existingCompressionEntry.activeBlockIds.length > 0) {
            continue
        }

        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue
        if (message.info.role !== "user") continue
        if (isIgnoredUserMessage(message)) continue

        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
                userTexts.push(part.text)
                break
            }
        }
    }

    if (userTexts.length === 0) {
        return summary
    }

    const heading = "\n\nThe following user messages were sent in this conversation verbatim:"
    const body = userTexts.map((text) => `\n${text}`).join("")
    return summary + heading + body
}

export function appendProtectedPromptInfo(
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
    state: SessionState,
    enabled: boolean,
): string {
    if (!enabled) return summary

    const protectedTexts: string[] = []

    for (const messageId of selection.messageIds) {
        const existingCompressionEntry = state.prune.messages.byMessageId.get(messageId)
        if (existingCompressionEntry && existingCompressionEntry.activeBlockIds.length > 0) {
            continue
        }

        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue
        if (message.info.role !== "user") continue
        if (isIgnoredUserMessage(message)) continue

        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type !== "text" || typeof part.text !== "string") continue

            protectedTexts.push(...extractProtectedPromptInfo(part.text))
        }
    }

    if (protectedTexts.length === 0) {
        return summary
    }

    const heading =
        "\n\nThe following protected prompt information was included in this conversation verbatim:"
    const body = protectedTexts.map((text) => `\n${text}`).join("")
    return summary + heading + body
}

export function extractProtectedPromptInfo(text: string): string[] {
    const protectedTexts: string[] = []
    const protectTagRegex = /<protect>([\s\S]*?)<\/protect>/gi

    for (const match of text.matchAll(protectTagRegex)) {
        const protectedText = match[1]?.trim()
        if (protectedText) {
            protectedTexts.push(protectedText)
        }
    }

    return protectedTexts
}

export async function appendProtectedTools(
    client: any,
    state: SessionState,
    allowSubAgents: boolean,
    summary: string,
    selection: SelectionResolution,
    searchContext: SearchContext,
    protectedTools: ProtectedToolsConfig<CompressProtectedToolSpec>,
    protectedFilePatterns: string[] = [],
): Promise<string> {
    const collected: Array<{ tool: string; text: string; keepLast?: number }> = []

    for (const messageId of selection.messageIds) {
        const existingCompressionEntry = state.prune.messages.byMessageId.get(messageId)
        if (existingCompressionEntry && existingCompressionEntry.activeBlockIds.length > 0) {
            continue
        }

        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue

        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type === "tool" && part.callID) {
                const spec = resolveProtectedTool(protectedTools, part.tool)
                let protectTool = spec !== null && spec.protect === true

                if (!protectTool && protectedFilePatterns.length > 0) {
                    const filePaths = getFilePathsFromParameters(part.tool, part.state?.input)
                    if (isFilePathProtected(filePaths, protectedFilePatterns)) {
                        protectTool = true
                    }
                }

                if (!protectTool) continue

                const title = `Tool: ${part.tool}`
                let output = ""

                if (part.state?.status === "completed" && part.state?.output) {
                    output =
                        typeof part.state.output === "string"
                            ? part.state.output
                            : JSON.stringify(part.state.output)
                }

                if (
                    allowSubAgents &&
                    part.tool === "task" &&
                    part.state?.status === "completed" &&
                    typeof part.state?.output === "string"
                ) {
                    const cachedSubAgentResult = state.subAgentResultCache.get(part.callID)

                    if (cachedSubAgentResult !== undefined) {
                        if (cachedSubAgentResult) {
                            output = mergeSubagentResult(part.state.output, cachedSubAgentResult)
                        }
                    } else {
                        const subAgentSessionId = getSubAgentId(part)
                        if (subAgentSessionId) {
                            let subAgentResultText = ""
                            try {
                                const subAgentMessages = await fetchSessionMessages(
                                    client,
                                    subAgentSessionId,
                                )
                                subAgentResultText = buildSubagentResultText(subAgentMessages)
                            } catch {
                                subAgentResultText = ""
                            }

                            if (subAgentResultText) {
                                state.subAgentResultCache.set(part.callID, subAgentResultText)
                                output = mergeSubagentResult(part.state.output, subAgentResultText)
                            }
                        }
                    }
                }

                if (!output) continue

                if (spec && spec.truncateSize !== undefined) {
                    output = truncateText(
                        output,
                        spec.truncateSize,
                        spec.truncateDirection ?? "both",
                    )
                }

                collected.push({
                    tool: part.tool,
                    text: `\n### ${title}\n${output}`,
                    keepLast: spec?.keepLast,
                })
            }
        }
    }

    const protectedOutputs = applyKeepLast(collected)

    if (protectedOutputs.length === 0) {
        return summary
    }

    const heading = "\n\nThe following protected tools were used in this conversation as well:"
    return summary + heading + protectedOutputs.join("")
}

function applyKeepLast(
    entries: Array<{ tool: string; text: string; keepLast?: number }>,
): string[] {
    const indicesByTool = new Map<string, number[]>()
    entries.forEach((entry, index) => {
        const indices = indicesByTool.get(entry.tool) ?? []
        indices.push(index)
        indicesByTool.set(entry.tool, indices)
    })

    const dropped = new Set<number>()
    for (const indices of indicesByTool.values()) {
        const keepLast = entries[indices[0]]?.keepLast
        if (keepLast !== undefined && keepLast >= 0 && indices.length > keepLast) {
            for (const index of indices.slice(0, indices.length - keepLast)) {
                dropped.add(index)
            }
        }
    }

    return entries.filter((_, index) => !dropped.has(index)).map((entry) => entry.text)
}
