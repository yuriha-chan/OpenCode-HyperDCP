import { renderMemo, validateMemo } from "../lib/memo"

export function renderStoredMemo(value: unknown): string | null {
    if (typeof value === "string") return value
    if (!Array.isArray(value)) return null

    validateMemo(value)
    const rendered = renderMemo(value)
    return rendered || null
}
