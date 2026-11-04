import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { isMessageCompacted } from "../state/utils"
import { renderMemo } from "../memo"
import {
    createSyntheticSkillMessage,
    createSyntheticUserMessage,
    replaceBlockIdsWithBlocked,
} from "./utils"
import { isIgnoredUserMessage } from "./query"
import { isMessageWithInfo } from "./shape"
import type { UserMessage } from "@opencode-ai/sdk/v2"

const PRUNED_TOOL_OUTPUT_REPLACEMENT =
    "[Output removed to save context - information superseded or no longer needed]"
const PRUNED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]"
const PRUNED_QUESTION_INPUT_REPLACEMENT = "[questions removed - see output for user's answers]"

export const prune = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    filterCompressedRanges(state, logger, config, messages)
    // pruneFullTool(state, logger, messages)
    pruneToolOutputs(state, logger, messages)
    pruneToolInputs(state, logger, messages)
    pruneToolErrors(state, logger, messages)
}

const pruneFullTool = (state: SessionState, logger: Logger, messages: WithParts[]): void => {
    const messagesToRemove = new Set<string>()

    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        const partsToRemove = new Set<string>()

        for (const part of parts) {
            if (part.type !== "tool") {
                continue
            }

            if (!state.prune.tools.has(part.callID)) {
                continue
            }
            if (part.tool !== "edit" && part.tool !== "write") {
                continue
            }

            partsToRemove.add(part.callID)
        }

        if (partsToRemove.size === 0) {
            continue
        }

        msg.parts = parts.filter((part) => part.type !== "tool" || !partsToRemove.has(part.callID))

        if (msg.parts.length === 0) {
            messagesToRemove.add(msg.info.id)
        }
    }

    if (messagesToRemove.size > 0) {
        const result = messages.filter((msg) => !messagesToRemove.has(msg.info.id))
        messages.length = 0
        messages.push(...result)
    }
}

const pruneToolOutputs = (state: SessionState, logger: Logger, messages: WithParts[]): void => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") {
                continue
            }
            if (!state.prune.tools.has(part.callID)) {
                continue
            }
            if (part.state.status !== "completed") {
                continue
            }
            if (part.tool === "question" || part.tool === "edit" || part.tool === "write") {
                continue
            }

            part.state.output = PRUNED_TOOL_OUTPUT_REPLACEMENT
        }
    }
}

const pruneToolInputs = (state: SessionState, logger: Logger, messages: WithParts[]): void => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") {
                continue
            }

            if (!state.prune.tools.has(part.callID)) {
                continue
            }
            if (part.state.status !== "completed") {
                continue
            }
            if (part.tool !== "question") {
                continue
            }

            if (part.state.input?.questions !== undefined) {
                part.state.input.questions = PRUNED_QUESTION_INPUT_REPLACEMENT
            }
        }
    }
}

const pruneToolErrors = (state: SessionState, logger: Logger, messages: WithParts[]): void => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") {
                continue
            }
            if (!state.prune.tools.has(part.callID)) {
                continue
            }
            if (part.state.status !== "error") {
                continue
            }

            // Prune all string inputs for errored tools
            const input = part.state.input
            if (input && typeof input === "object") {
                for (const key of Object.keys(input)) {
                    if (typeof input[key] === "string") {
                        input[key] = PRUNED_TOOL_ERROR_INPUT_REPLACEMENT
                    }
                }
            }
        }
    }
}

const filterCompressedRanges = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    const memoContent = state.memo ? renderMemo(state.memo) : ""
    const protectedSkills = Array.isArray(state.protectedSkills) ? state.protectedSkills : []
    if (
        state.prune.messages.byMessageId.size === 0 &&
        state.prune.messages.activeByAnchorMessageId.size === 0 &&
        memoContent.length === 0 &&
        protectedSkills.length === 0
    ) {
        return
    }

    const result: WithParts[] = []
    let lastBlockIndex = -1
    let latestEligibleUser: WithParts | null = null
    const messageEligibility = new Map<
        WithParts,
        { eligible: boolean; eligibleUser: WithParts | null }
    >()

    for (const msg of messages) {
        const msgId = msg.info.id

        let eligibility = messageEligibility.get(msg)
        if (!eligibility) {
            const eligible =
                isMessageWithInfo(msg) && msg.info.role === "user" && !isIgnoredUserMessage(msg)
            if (eligible) {
                latestEligibleUser = msg
            }
            eligibility = { eligible, eligibleUser: latestEligibleUser }
            messageEligibility.set(msg, eligibility)
        } else if (eligibility.eligible) {
            latestEligibleUser = msg
        }

        // Find user message for variant and as base for synthetic message
        const userMessage = eligibility.eligibleUser

        // Check if there's a summary to inject at this anchor point
        const blockId = state.prune.messages.activeByAnchorMessageId.get(msgId)
        const summary =
            blockId !== undefined ? state.prune.messages.blocksById.get(blockId) : undefined
        if (summary) {
            const versionIndex =
                typeof summary.activeVersionIndex === "number" ? summary.activeVersionIndex : 1
            let rawSummaryContent: string

            if (versionIndex === 0) {
                rawSummaryContent = "" // disabled
            } else if (
                versionIndex >= 2 &&
                Array.isArray(summary.summaryVersions) &&
                versionIndex - 2 < summary.summaryVersions.length
            ) {
                rawSummaryContent = summary.summaryVersions[versionIndex - 2]
            } else {
                rawSummaryContent = (summary as { summary?: string }).summary ?? ""
            }

            if (
                summary.active !== true ||
                typeof rawSummaryContent !== "string" ||
                rawSummaryContent.length === 0
            ) {
                logger.warn("Skipping malformed compress summary", {
                    anchorMessageId: msgId,
                    blockId: (summary as { blockId?: unknown }).blockId,
                })
            } else {
                if (userMessage) {
                    const userInfo = userMessage.info as UserMessage
                    const summaryContent =
                        config.compress.mode === "message"
                            ? replaceBlockIdsWithBlocked(rawSummaryContent)
                            : rawSummaryContent
                    const summarySeed = `${summary.blockId}:${summary.anchorMessageId}`
                    result.push(
                        createSyntheticUserMessage(userMessage, summaryContent, summarySeed),
                    )
                    lastBlockIndex = result.length - 1

                    logger.info("Injected compress summary", {
                        anchorMessageId: msgId,
                        summaryLength: summaryContent.length,
                    })
                } else {
                    logger.warn("No user message found for compress summary", {
                        anchorMessageId: msgId,
                    })
                }
            }
        }

        // Skip messages that are in the prune list
        const pruneEntry = state.prune.messages.byMessageId.get(msgId)
        if (pruneEntry && pruneEntry.activeBlockIds.length > 0) {
            continue
        }

        // Normal message, include it
        result.push(msg)
    }

    // Inject memo after the last block summary
    let memoIndex = -1
    if (memoContent.length > 0) {
        if (latestEligibleUser) {
            const memoMsg = createSyntheticUserMessage(
                latestEligibleUser,
                `[Memo]\n${memoContent}`,
                "dcp_memo",
            )
            memoIndex = lastBlockIndex >= 0 ? lastBlockIndex + 1 : 0
            result.splice(memoIndex, 0, memoMsg)
        }
    }

    if (protectedSkills.length > 0 && latestEligibleUser) {
        const skillMessages = protectedSkills.map((record) =>
            createSyntheticSkillMessage(latestEligibleUser!, record),
        )
        const skillIndex =
            memoIndex >= 0 ? memoIndex + 1 : lastBlockIndex >= 0 ? lastBlockIndex + 1 : 0
        result.splice(skillIndex, 0, ...skillMessages)
    }

    // Replace messages array contents
    messages.length = 0
    messages.push(...result)
}
