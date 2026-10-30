import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./compress/types"
import { editMemo, renderMemo, type MemoContent } from "./memo"
import { runHousekeepingMutation } from "./housekeeping/state"

type TopicInput = {
    topicTitle: string
    textItems?: string[]
    topics?: TopicInput[]
}

const textItemsSchema = tool.schema.array(tool.schema.string())

function memoTopicSchema(depth = 1): ReturnType<typeof tool.schema.object> {
    return tool.schema.object({
        topicTitle: tool.schema.string().describe("Topic title without slashes"),
        textItems: textItemsSchema.optional().describe("Text items, without bullet markers"),
        topics: tool.schema
            .array(depth >= 6 ? tool.schema.never() : memoTopicSchema(depth + 1))
            .optional()
            .describe("Nested topics; omitted means empty"),
    })
}

const topicsSchema = tool.schema.array(memoTopicSchema())

function topicContent(topic: TopicInput): MemoContent {
    return {
        topic: topic.topicTitle,
        items: [
            ...splitTextItems(topic.textItems ?? []),
            ...(topic.topics ?? []).map(topicContent),
        ],
    }
}

function splitTextItems(items: string[]): string[] {
    return items.flatMap((item) => item.split(/\r\n?|\n/))
}

export function createEditMemoTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: `Edit the persistent memo using append, remove, or clear actions.
The memo stores reusable working commands, user constraints, and temporary states, not history. Keep the entire memo around <1.5K tokens.

Append textItems and/or topics in one atomic call, optionally inside a parent topic or after a sibling topic. Each topic has a topicTitle and optional textItems and topics collections. Omitted collections mean empty; append requires at least one text item or topic. Supply topics as objects, not serialized JSON strings, and text items without bullet markers. Text items are placed before topics. Parent and after can be used together; after must identify a direct child of parent. Topics retain their submitted order after the anchor; text items anchored after a topic are relocated to the string portion with a warning.
Embedded newlines in text items are split into separate items. Text renders as plain lines without added bullet markers.
Remove a topic by its path (for example, "Plan/Details"), or a string by prefix using "Plan//prefix"; an empty topic path targets a string at the root (for example, "//prefix"). Clear empties a topic but keeps the topic itself; clear requires a topic path.
Topic paths are slash-separated strings. Topics cannot contain slashes, duplicate topics/strings and ambiguous string prefixes are rejected, and topic nesting is limited to six levels including the selected parent.

Examples:
{ action: "append", textItems: ["Remember this", "Another observation"] }
{ action: "append", parent: "Plan", topics: [{ topicTitle: "Next", textItems: ["Do this"], topics: [] }] }
{ action: "append", parent: "Plan", after: "Plan/Next", topics: [{ topicTitle: "Verification", textItems: ["Run tests"] }] }
{ action: "remove", path: "Plan//Do" }
{ action: "clear", path: "Plan/Next" }`,
        args: {
            action: tool.schema.enum(["append", "remove", "clear"]).describe("Memo action"),
            parent: tool.schema.string().optional().describe("Parent topic path for append"),
            after: tool.schema.string().optional().describe("Sibling topic path to insert after"),
            textItems: textItemsSchema
                .optional()
                .describe("Text items to append, without bullet markers; omitted means empty"),
            topics: topicsSchema
                .optional()
                .describe("Topics to append in submitted order; omitted means empty"),
            path: tool.schema
                .string()
                .optional()
                .describe("Topic path or string-prefix selector for remove/clear"),
        },
        async execute(args, toolCtx) {
            return runHousekeepingMutation(
                ctx,
                toolCtx,
                "edit_memo",
                args,
                async (operationCtx) => {
                    const input = args as unknown as Record<string, unknown>
                    if (
                        ["content", "oldString", "newString", "replaceAll"].some(
                            (key) => key in input,
                        )
                    ) {
                        throw new Error("Legacy memo edit arguments are not supported")
                    }
                    if (
                        input.action !== "append" &&
                        input.action !== "remove" &&
                        input.action !== "clear"
                    ) {
                        throw new Error(`Unknown memo action: ${String(input.action)}`)
                    }

                    let memo = operationCtx.state.memo ?? []
                    const warnings: string[] = []
                    if (input.action === "append") {
                        const textItems = textItemsSchema.parse(
                            input.textItems === undefined ? [] : input.textItems,
                        )
                        const topics = topicsSchema.parse(
                            input.topics === undefined ? [] : input.topics,
                        ) as TopicInput[]
                        if (!textItems.length && !topics.length)
                            throw new Error("Memo append requires at least one text item or topic")
                        if (input.parent !== undefined && typeof input.parent !== "string") {
                            throw new Error("Memo parent must be a topic path string")
                        }
                        if (input.after !== undefined && typeof input.after !== "string") {
                            throw new Error("Memo after must be a topic path string")
                        }
                        const parent = input.parent as string | undefined
                        let after = input.after as string | undefined
                        for (const content of [
                            ...splitTextItems(textItems),
                            ...topics.map(topicContent),
                        ]) {
                            const result = editMemo(memo, {
                                type: "append",
                                content,
                                parent,
                                after,
                            })
                            memo = result.memo
                            warnings.push(...result.warnings)
                            if (after !== undefined && typeof content !== "string") {
                                after =
                                    parent === undefined
                                        ? content.topic
                                        : `${parent}/${content.topic}`
                            }
                        }
                    } else {
                        if (typeof input.path !== "string" || !input.path) {
                            throw new Error(`Memo ${input.action} requires a non-empty path`)
                        }
                        const result = editMemo(memo, { type: input.action, path: input.path })
                        memo = result.memo
                        warnings.push(...result.warnings)
                    }

                    operationCtx.state.memo = memo.length ? memo : null
                    const rendered = operationCtx.state.memo
                        ? renderMemo(operationCtx.state.memo)
                        : ""
                    const outcome = operationCtx.state.memo
                        ? `Memo edited (${rendered.length} rendered characters).`
                        : "Memo cleared."
                    return [outcome, ...warnings].join("\n")
                },
            )
        },
    })
}
