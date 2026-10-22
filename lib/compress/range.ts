import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { countTokens } from "../token-utils"
import { RANGE_FORMAT_EXTENSION } from "../prompts/extensions/tool"
import { finalizeSession, prepareSession, type NotificationEntry } from "./pipeline"
import {
    appendProtectedPromptInfo,
    appendProtectedTools,
    appendProtectedUserMessages,
} from "./protected-content"
import { resolveRanges, validateArgs, validateNonOverlapping } from "./range-utils"
import {
    COMPRESSED_BLOCK_HEADER,
    allocateBlockId,
    allocateRunId,
    applyCompressionState,
    wrapCompressedSummary,
} from "./state"
import type { CompressRangeToolArgs } from "./types"
import { runHousekeepingMutation } from "../housekeeping/state"

function buildSchema() {
    return {
        topic: tool.schema
            .string()
            .describe("Short label (3-5 words) for display - e.g., 'Auth System Exploration'"),
        content: tool.schema
            .array(
                tool.schema.object({
                    startId: tool.schema
                        .string()
                        .describe(
                            "Message or block ID marking the beginning of range (e.g. m0001, b2)",
                        ),
                    endId: tool.schema
                        .string()
                        .describe("Message or block ID marking the end of range (e.g. m0012, b5)"),
                    summary: tool.schema
                        .string()
                        .describe("Complete technical summary replacing all content in range"),
                }),
            )
            .describe(
                "One or more ranges to compress, each with start/end boundaries and a summary",
            ),
    }
}

export function createCompressRangeTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()

    return tool({
        description: runtimePrompts.compressRange + RANGE_FORMAT_EXTENSION,
        args: buildSchema(),
        async execute(args, toolCtx) {
            return runHousekeepingMutation(ctx, toolCtx, "compress", args, async (operationCtx) => {
                const input = args as CompressRangeToolArgs
                validateArgs(input)
                const callId =
                    typeof (toolCtx as unknown as { callID?: unknown }).callID === "string"
                        ? (toolCtx as unknown as { callID: string }).callID
                        : undefined
                const { rawMessages, searchContext } = await prepareSession(
                    operationCtx,
                    toolCtx,
                    `Compress Range: ${input.topic}`,
                )
                const resolvedPlans = resolveRanges(input, searchContext, operationCtx.state)
                validateNonOverlapping(resolvedPlans)

                // Reject small ranges — compressing under minCompressTokens is not worth the overhead
                const minTokens = ctx.config.compress.minCompressTokens
                if (minTokens > 0) {
                    for (const plan of resolvedPlans) {
                        let totalTokens = 0
                        for (const count of plan.selection.messageTokenById.values()) {
                            totalTokens += count
                        }
                        if (totalTokens < minTokens) {
                            throw new Error(
                                `Range is only ${totalTokens} tokens. Compressing a small fragment ` +
                                    `does not help save context. Organize with meaningful granularity — ` +
                                    `keep as is or expand adjacent blocks.`,
                            )
                        }
                    }
                }

                const notifications: NotificationEntry[] = []
                const preparedPlans: Array<{
                    entry: (typeof resolvedPlans)[number]["entry"]
                    selection: (typeof resolvedPlans)[number]["selection"]
                    anchorMessageId: string
                    finalSummary: string
                }> = []
                let totalCompressedMessages = 0

                for (const plan of resolvedPlans) {
                    const summaryWithUsers = appendProtectedUserMessages(
                        plan.entry.summary,
                        plan.selection,
                        searchContext,
                        operationCtx.state,
                        ctx.config.compress.protectUserMessages,
                    )

                    const summaryWithPromptInfo = appendProtectedPromptInfo(
                        summaryWithUsers,
                        plan.selection,
                        searchContext,
                        operationCtx.state,
                        ctx.config.compress.protectTags,
                    )

                    const summaryWithTools = await appendProtectedTools(
                        operationCtx.client,
                        operationCtx.state,
                        operationCtx.config.experimental.allowSubAgents,
                        summaryWithPromptInfo,
                        plan.selection,
                        searchContext,
                        operationCtx.config.compress.protectedTools,
                        operationCtx.config.protectedFilePatterns,
                    )

                    preparedPlans.push({
                        entry: plan.entry,
                        selection: plan.selection,
                        anchorMessageId: plan.anchorMessageId,
                        finalSummary: summaryWithTools,
                    })
                }

                const runId = allocateRunId(operationCtx.state)
                const preExistingActiveMessages = new Set<string>()
                for (const [msgId, entry] of operationCtx.state.prune.messages.byMessageId) {
                    if (entry.activeBlockIds.length > 0) {
                        preExistingActiveMessages.add(msgId)
                    }
                }

                for (const preparedPlan of preparedPlans) {
                    const blockId = allocateBlockId(operationCtx.state)
                    const storedSummary = wrapCompressedSummary(
                        blockId,
                        preparedPlan.finalSummary,
                        `${preparedPlan.entry.startId}-${preparedPlan.entry.endId}`,
                    )
                    const summaryTokens = countTokens(storedSummary)

                    const applied = applyCompressionState(
                        operationCtx.state,
                        {
                            topic: input.topic,
                            batchTopic: input.topic,
                            startId: preparedPlan.entry.startId,
                            endId: preparedPlan.entry.endId,
                            mode: "range",
                            runId,
                            compressMessageId: toolCtx.messageID,
                            compressCallId: callId,
                            summaryTokens,
                        },
                        preparedPlan.selection,
                        preparedPlan.anchorMessageId,
                        blockId,
                        storedSummary,
                        [preparedPlan.selection.startReference, preparedPlan.selection.endReference]
                            .filter((reference) => reference.kind === "compressed-block")
                            .map((reference) => reference.blockId!)
                            .filter((blockId, index, list) => list.indexOf(blockId) === index),
                        preExistingActiveMessages,
                    )

                    totalCompressedMessages += applied.messageIds.length

                    notifications.push({
                        blockId,
                        runId,
                        summary: preparedPlan.finalSummary,
                        summaryTokens,
                    })
                }

                await finalizeSession(
                    operationCtx,
                    toolCtx,
                    rawMessages,
                    notifications,
                    input.topic,
                )
                const result = `Staged compression of ${totalCompressedMessages} messages into ${COMPRESSED_BLOCK_HEADER}.`
                if (operationCtx.state.housekeeping)
                    operationCtx.state.housekeeping.notifications = [
                        ...(operationCtx.state.housekeeping.notifications ?? []),
                        ...notifications,
                    ]
                if (operationCtx.state.housekeeping)
                    operationCtx.state.housekeeping.batchTopic = input.topic

                return result
            })
        },
    })
}
