import { GLOB_CHARS, matchesGlob } from "./protected-patterns"

export type TruncateDirection = "head" | "tail" | "both"

export interface ProtectedToolSpec {
    protect?: boolean
}

export interface CompressProtectedToolSpec extends ProtectedToolSpec {
    truncateSize?: number
    truncateDirection?: TruncateDirection
    keepLast?: number
}

export type ProtectedToolsConfig<S extends ProtectedToolSpec = ProtectedToolSpec> =
    | string[]
    | Record<string, S>

export type ResolvedProtectedTool<S extends ProtectedToolSpec> = S & { protect: boolean }

export const TRUNCATION_MARKER = "\n... [truncated] ...\n"

export function normalizeProtectedTools<S extends ProtectedToolSpec>(
    value: ProtectedToolsConfig<S> | undefined,
): Record<string, S> {
    const result: Record<string, S> = {}
    if (!value) {
        return result
    }

    if (Array.isArray(value)) {
        for (const name of value) {
            if (typeof name === "string" && name.length > 0) {
                result[name] = { protect: true } as S
            }
        }
        return result
    }

    for (const [name, spec] of Object.entries(value)) {
        if (name.length > 0) {
            result[name] = { ...spec } as S
        }
    }
    return result
}

function withProtectDefault<S extends ProtectedToolSpec>(spec: S): ResolvedProtectedTool<S> {
    return { ...spec, protect: spec.protect !== false } as ResolvedProtectedTool<S>
}

export function resolveProtectedTool<S extends ProtectedToolSpec>(
    value: ProtectedToolsConfig<S> | undefined,
    toolName: string,
): ResolvedProtectedTool<S> | null {
    if (!value || !toolName) {
        return null
    }

    const tools = normalizeProtectedTools(value)
    if (Object.prototype.hasOwnProperty.call(tools, toolName)) {
        return withProtectDefault(tools[toolName])
    }

    for (const [pattern, spec] of Object.entries(tools)) {
        if (GLOB_CHARS.test(pattern) && matchesGlob(toolName, pattern)) {
            return withProtectDefault(spec)
        }
    }

    return null
}

export function isToolProtected(
    value: ProtectedToolsConfig | undefined,
    toolName: string,
): boolean {
    const spec = resolveProtectedTool(value, toolName)
    return spec !== null && spec.protect === true
}

export function mergeProtectedTools<S extends ProtectedToolSpec>(
    base: ProtectedToolsConfig<S> | undefined,
    override: ProtectedToolsConfig<S> | undefined,
): Record<string, S> {
    const result = normalizeProtectedTools(base)
    for (const [name, spec] of Object.entries(normalizeProtectedTools(override))) {
        result[name] = { ...(result[name] ?? ({} as S)), ...spec } as S
    }
    return result
}

export function truncateText(text: string, size: number, direction: TruncateDirection): string {
    if (!Number.isFinite(size) || size <= 0 || text.length <= size) {
        return text
    }

    if (direction === "head") {
        return text.slice(0, size) + TRUNCATION_MARKER
    }

    if (direction === "tail") {
        return TRUNCATION_MARKER + text.slice(text.length - size)
    }

    const tailLength = Math.floor(size / 2)
    const headLength = size - tailLength
    return text.slice(0, headLength) + TRUNCATION_MARKER + text.slice(text.length - tailLength)
}
