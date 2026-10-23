import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./compress/types"
import { editMemo, renderMemo, type MemoContent, type MemoEdit } from "./memo"
import { runHousekeepingMutation } from "./housekeeping/state"

function memoContentSchema(depth = 1): ReturnType<typeof tool.schema.union> {
    const string = tool.schema.string()
    if (depth >= 7) return tool.schema.union([string])
    const section = tool.schema.object({
        topic: tool.schema.string().describe("Topic name"),
        items: tool.schema
            .array(tool.schema.union([string, memoContentSchema(depth + 1)]))
            .describe("Strings and nested topics"),
    })
    return tool.schema.union([string, section])
}

export function createEditMemoTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: `Edit the persistent memo using append, remove, or clear actions.
The memo stores reusable working commands, user constraints, and temporary states, not history. Keep the entire memo around <1.5K tokens.

Append a string or topic, optionally inside a parent topic or after a sibling topic. Parent and after can be used together; after must identify a direct child of parent. String content is placed before topics, so a string anchored after a topic is relocated to the string portion with a warning.
Remove a topic by its path (for example, "Plan/Details"), or a string by prefix using "Plan//prefix"; an empty topic path targets a string at the root (for example, "//prefix"). Clear empties a topic but keeps the topic itself; clear requires a topic path.
Topic paths are slash-separated strings. Topics cannot contain slashes, duplicate topics/strings and ambiguous string prefixes are rejected, and topic nesting is limited to six levels. Supplied items are normalized to strings-before-topics with a warning when necessary.

Examples:
{ action: "append", content: "Remember this" }
{ action: "append", parent: "Plan", content: { topic: "Next", items: ["Do this"] } }
{ action: "append", parent: "Plan", after: "Plan/Next", content: "Another string" }
{ action: "remove", path: "Plan//Do" }
{ action: "clear", path: "Plan/Next" }`,
        args: {
            action: tool.schema.enum(["append", "remove", "clear"]).describe("Memo action"),
            parent: tool.schema.string().optional().describe("Parent topic path for append"),
            after: tool.schema.string().optional().describe("Sibling topic path to insert after"),
            content: memoContentSchema()
                .optional()
                .describe("String or nested topic content for append"),
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
                    if (["oldString", "newString", "replaceAll"].some((key) => key in input)) {
                        throw new Error("Legacy memo edit arguments are not supported")
                    }
                    if (
                        input.action !== "append" &&
                        input.action !== "remove" &&
                        input.action !== "clear"
                    ) {
                        throw new Error(`Unknown memo action: ${String(input.action)}`)
                    }

                    let edit: MemoEdit
                    if (input.action === "append") {
                        if (input.content === undefined)
                            throw new Error("Memo append requires content")
                        if (
                            typeof input.content !== "string" &&
                            (typeof input.content !== "object" || input.content === null)
                        ) {
                            throw new Error("Memo append content must be a string or topic")
                        }
                        if (input.parent !== undefined && typeof input.parent !== "string") {
                            throw new Error("Memo parent must be a topic path string")
                        }
                        if (input.after !== undefined && typeof input.after !== "string") {
                            throw new Error("Memo after must be a topic path string")
                        }
                        edit = {
                            type: "append",
                            content: input.content as MemoContent,
                            ...(input.parent === undefined
                                ? {}
                                : { parent: input.parent as string }),
                            ...(input.after === undefined ? {} : { after: input.after as string }),
                        }
                    } else {
                        if (typeof input.path !== "string" || !input.path) {
                            throw new Error(`Memo ${input.action} requires a non-empty path`)
                        }
                        if (input.action === "remove") edit = { type: "remove", path: input.path }
                        else edit = { type: "clear", path: input.path }
                    }

                    const result = editMemo(operationCtx.state.memo ?? [], edit)
                    operationCtx.state.memo = result.memo.length ? result.memo : null
                    const rendered = operationCtx.state.memo
                        ? renderMemo(operationCtx.state.memo)
                        : ""
                    const outcome = operationCtx.state.memo
                        ? `Memo edited (${rendered.length} rendered characters).`
                        : "Memo cleared."
                    return [outcome, ...result.warnings].join("\n")
                },
            )
        },
    })
}
