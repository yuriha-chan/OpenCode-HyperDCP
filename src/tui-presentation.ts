import type { BlockInfo } from "./tui-state"

export function clampMessagePage(page: number, totalMessages: number, pageSize: number): number {
    const lastPage = Math.max(0, Math.ceil(totalMessages / pageSize) - 1)
    return Math.min(Math.max(page, 0), lastPage)
}

export function retainSummaryVersion(
    selected: number | null,
    block: Pick<BlockInfo, "versions" | "activeVersionIndex"> | undefined,
): number | null {
    if (selected === null) return null
    if (block === undefined) return selected
    return Math.min(Math.max(selected, 0), block.versions.length)
}
