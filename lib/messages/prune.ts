import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { isMessageCompacted } from "../state/utils"
import { renderContextMemo } from "../memo"
import { createSyntheticSkillMessage, createSyntheticUserMessage } from "./utils"
import { contextBlockSummary } from "./block-summary"
import { isIgnoredUserMessage } from "./query"
import { isMessageWithInfo } from "./shape"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import type { CompressionBlock } from "../state/types"
import { selectProtectedSubagents, renderProtectedSubagents } from "../subagents/protection"

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
    const memoContent = state.memo ? renderContextMemo(state.memo) : ""
    const protectedSkills = Array.isArray(state.protectedSkills) ? state.protectedSkills : []
    if (
        state.prune.messages.byMessageId.size === 0 &&
        state.prune.messages.activeByAnchorMessageId.size === 0 &&
        memoContent.length === 0 &&
        protectedSkills.length === 0 &&
        state.subagentExecutions.length === 0
    ) {
        return
    }

    const result: WithParts[] = []
    let lastBlockIndex = -1
    let lastProjectedBlock: CompressionBlock | undefined
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
        const renderedSummary = contextBlockSummary(state, logger, config, msgId)
        if (renderedSummary) {
            const { block: summary, content: summaryContent } = renderedSummary
            if (userMessage) {
                const userInfo = userMessage.info as UserMessage
                const summarySeed = `${summary.blockId}:${summary.anchorMessageId}`
                result.push(createSyntheticUserMessage(userMessage, summaryContent, summarySeed))
                lastBlockIndex = result.length - 1
                lastProjectedBlock = summary

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
            const memoMsg = createSyntheticUserMessage(latestEligibleUser, memoContent, "dcp_memo")
            memoIndex = lastBlockIndex >= 0 ? lastBlockIndex + 1 : 0
            result.splice(memoIndex, 0, memoMsg)
        }
    }

    let skillEndIndex = -1
    if (protectedSkills.length > 0 && latestEligibleUser) {
        const skillMessages = protectedSkills.map((record) =>
            createSyntheticSkillMessage(latestEligibleUser!, record),
        )
        const skillIndex =
            memoIndex >= 0 ? memoIndex + 1 : lastBlockIndex >= 0 ? lastBlockIndex + 1 : 0
        result.splice(skillIndex, 0, ...skillMessages)
        skillEndIndex = skillIndex + skillMessages.length
    }

    const protectedContent = renderProtectedSubagents(
        selectProtectedSubagents(
            state.subagentExecutions,
            config.compress.protectSubagent,
            lastProjectedBlock,
        ),
        config.compress.protectSubagent,
        state.messageIds,
    )
    if (protectedContent && latestEligibleUser) {
        const index =
            skillEndIndex >= 0
                ? skillEndIndex
                : memoIndex >= 0
                  ? memoIndex + 1
                  : lastBlockIndex >= 0
                    ? lastBlockIndex + 1
                    : 0
        result.splice(
            index,
            0,
            createSyntheticUserMessage(latestEligibleUser, protectedContent, "dcp_subagents"),
        )
    }

    // Replace messages array contents
    messages.length = 0
    messages.push(...result)
}
