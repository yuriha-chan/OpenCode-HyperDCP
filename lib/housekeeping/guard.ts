import type { ToolContext } from "../compress/types"
import { withSessionCoordinator } from "./coordinator"
import { loadAndReconcileSession } from "./state"

export interface ToolExecutionInput {
    tool: string
    sessionID: string
    callID: string
}

const HOUSEKEEPING_TOOLS = new Set([
    "leave_housekeeping",
    "compress",
    "edit_memo",
    "rewrite_summary",
    "toggle_summary_version",
    "expand_block",
    "edit_summary",
    "append_summary",
    "read_memo",
    "fetch_summary_versions",
    "recall_compressed",
    "enter_housekeeping",
])

const DISPATCH_TOOLS = new Set(["multi_tool_use.parallel", "functions.multi_tool_use.parallel"])

function isBuiltinTool(name: string): boolean {
    if (HOUSEKEEPING_TOOLS.has(name)) return true
    return name.startsWith("functions.") && HOUSEKEEPING_TOOLS.has(name.slice("functions.".length))
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertNoParallelTransition(toolName: string, args: Record<string, unknown>): void {
    if (!DISPATCH_TOOLS.has(toolName) || !Array.isArray(args.tool_uses)) return
    const hasBoundary = args.tool_uses.some(
        (child) =>
            isRecord(child) &&
            (child.recipient_name === "enter_housekeeping" ||
                child.recipient_name === "leave_housekeeping" ||
                child.recipient_name === "functions.enter_housekeeping" ||
                child.recipient_name === "functions.leave_housekeeping"),
    )
    if (hasBoundary && args.tool_uses.length > 1) {
        throw new Error(
            "Housekeeping entry and leave must run separately from parallel tool dispatch.",
        )
    }
}

function assertChildToolsAllowed(
    toolName: string,
    args: unknown,
    allowedTools: readonly string[],
): void {
    if (DISPATCH_TOOLS.has(toolName) && isRecord(args) && Array.isArray(args.tool_uses)) {
        assertNoParallelTransition(toolName, args)
        for (const child of args.tool_uses) {
            if (!isRecord(child) || typeof child.recipient_name !== "string") {
                throw new Error("Parallel tool dispatch contains an invalid child tool request.")
            }
            assertChildToolsAllowed(child.recipient_name, child.parameters, allowedTools)
        }
        if (allowedTools.includes(toolName)) return
        throw new Error(`Tool ${toolName} is blocked during housekeeping.`)
    }
    if (isBuiltinTool(toolName) || allowedTools.includes(toolName)) return
    throw new Error(`Tool ${toolName} is blocked during housekeeping.`)
}

export function createToolExecuteBeforeHandler(ctx: ToolContext) {
    return async (input: ToolExecutionInput, output: { args: unknown }): Promise<void> =>
        withSessionCoordinator(ctx.state, async () => {
            await loadAndReconcileSession(ctx, input.sessionID)
            if (!ctx.state.housekeeping) {
                if (DISPATCH_TOOLS.has(input.tool) && isRecord(output.args)) {
                    assertNoParallelTransition(input.tool, output.args)
                }
                return
            }
            if (ctx.state.housekeeping.sessionId !== input.sessionID) {
                throw new Error(
                    "Housekeeping session state does not match the executing tool session.",
                )
            }
            try {
                assertChildToolsAllowed(
                    input.tool,
                    output.args,
                    ctx.config.housekeeping?.allowedTools ?? [],
                )
            } catch (error) {
                if (input.tool === "enter_housekeeping") return
                if (error instanceof Error && error.message.includes("Parallel tool dispatch"))
                    throw error
                throw new Error(
                    `${error instanceof Error ? error.message : String(error)} Leave housekeeping or add the exact tool name to housekeeping.allowedTools.`,
                )
            }
        })
}
