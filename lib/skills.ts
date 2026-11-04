import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./compress/types"
import type { SkillContext } from "./state"
import { saveSessionStateStrict } from "./state"
import { withSessionCoordinator } from "./housekeeping/coordinator"
import { loadAndReconcileSession } from "./housekeeping/state"

const NATIVE_SKILL_TOOL = "skill"

interface SkillLoadArguments {
    name: string
    force?: boolean
    [key: string]: unknown
}

interface SkillResult {
    title: string
    output: string
    metadata: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateLoadArguments(value: unknown): SkillLoadArguments {
    if (!isRecord(value))
        throw new Error("Invalid native skill arguments: expected an argument object.")
    if (typeof value.name !== "string" || value.name.length === 0)
        throw new Error("Invalid native skill name: expected a non-empty string.")
    if (value.force !== undefined && typeof value.force !== "boolean")
        throw new Error("Invalid native skill force argument: expected a boolean.")
    return value as SkillLoadArguments
}

function validateNativeResult(value: unknown): SkillResult {
    if (!isRecord(value)) throw new Error("Invalid native skill result: expected a result object.")
    if (typeof value.title !== "string")
        throw new Error("Invalid native skill result title: expected a string.")
    if (typeof value.output !== "string")
        throw new Error("Invalid native skill result output: expected a string.")
    if (!isRecord(value.metadata))
        throw new Error("Invalid native skill result metadata: expected an object.")
    return {
        title: value.title,
        output: value.output,
        metadata: value.metadata,
    }
}

async function publishLoadedSkills(ctx: ToolContext, skills: SkillContext[]): Promise<void> {
    const candidate = structuredClone(ctx.state)
    candidate.loadedSkills = structuredClone(skills)
    await saveSessionStateStrict(candidate, ctx.logger)
    ctx.state.loadedSkills = candidate.loadedSkills
    ctx.state.revision = candidate.revision
}

export function createSkillToolDefinitionHandler(_ctx: ToolContext) {
    return async (
        input: { toolID: string },
        output: { description: string; parameters: any; jsonSchema?: any },
    ): Promise<void> => {
        if (input.toolID !== NATIVE_SKILL_TOOL) return
        const current = isRecord(output.jsonSchema) ? output.jsonSchema : {}
        const properties = isRecord(current.properties) ? { ...current.properties } : {}
        const name = isRecord(properties.name) ? { ...properties.name } : {}
        name.type = "string"
        const force = isRecord(properties.force) ? { ...properties.force } : {}
        force.type = "boolean"
        if (force.description === undefined)
            force.description = "Reload the skill when it is already loaded."
        const required = Array.isArray(current.required)
            ? current.required.filter((entry) => entry !== "force")
            : []
        if (!required.includes("name")) required.unshift("name")
        output.jsonSchema = {
            ...current,
            type: typeof current.type === "string" ? current.type : "object",
            properties: { ...properties, name, force },
            required,
        }
    }
}

export function createSkillExecuteBeforeHandler(ctx: ToolContext) {
    return async (
        input: { tool: string; sessionID: string; callID: string },
        output: { args: any },
    ): Promise<void> => {
        if (input.tool !== NATIVE_SKILL_TOOL) return
        return withSessionCoordinator(ctx.state, async () => {
            await loadAndReconcileSession(ctx, input.sessionID)
            const args = validateLoadArguments(output.args)
            const loaded = ctx.state.loadedSkills.some((record) => record.name === args.name)
            if (!loaded) return
            if (args.force !== true)
                throw new Error(
                    `Skill "${args.name}" is already loaded. Pass force=true to reload it.`,
                )
            await publishLoadedSkills(
                ctx,
                ctx.state.loadedSkills.filter((record) => record.name !== args.name),
            )
        })
    }
}

export function createSkillExecuteAfterHandler(ctx: ToolContext) {
    return async (
        input: { tool: string; sessionID: string; callID: string; args: any },
        output: { title: string; output: string; metadata: any },
    ): Promise<void> => {
        if (input.tool !== NATIVE_SKILL_TOOL) return
        return withSessionCoordinator(ctx.state, async () => {
            await loadAndReconcileSession(ctx, input.sessionID)
            const args = validateLoadArguments(input.args)
            const result = validateNativeResult(output)
            const record: SkillContext = {
                name: args.name,
                callId: input.callID,
                input: structuredClone(args) as Record<string, unknown>,
                title: result.title,
                output: result.output,
                metadata: structuredClone(result.metadata),
            }
            const skills = [...ctx.state.loadedSkills]
            const index = skills.findIndex((entry) => entry.name === args.name)
            if (index >= 0) skills[index] = record
            else skills.push(record)
            await publishLoadedSkills(ctx, skills)
        })
    }
}

export function createUnloadSkillTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: "Unload a loaded skill by name.",
        args: {
            name: tool.schema.string().describe("Name of the loaded skill to unload."),
        },
        async execute(args, toolContext) {
            return withSessionCoordinator(ctx.state, async () => {
                await loadAndReconcileSession(ctx, toolContext.sessionID)
                if (typeof args.name !== "string" || args.name.length === 0)
                    throw new Error("Invalid unload_skill name: expected a non-empty string.")
                const loaded = ctx.state.loadedSkills.some((record) => record.name === args.name)
                if (!loaded)
                    throw new Error(`Skill "${args.name}" is not loaded and cannot be unloaded.`)
                await publishLoadedSkills(
                    ctx,
                    ctx.state.loadedSkills.filter((record) => record.name !== args.name),
                )
                return `Unloaded skill "${args.name}".`
            })
        },
    })
}
