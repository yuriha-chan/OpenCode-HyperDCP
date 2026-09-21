import type { CompressionBlock } from "../state/types"

/**
 * Returns the intersection of `ids` with `active`, preserving the original order.
 * Returns `null` if no IDs are active, so the caller decides how to handle an empty result.
 */
export function filterToActive(ids: string[], active: Set<string>): string[] | null {
    const onChain = ids.filter((id) => active.has(id))
    return onChain.length > 0 ? onChain : null
}

/**
 * Returns the on-chain subset of `block.effectiveMessageIds`, or `null` if the block
 * has no coverage on the active branch (the caller treats the block as non-existent).
 */
export function onChainCoverage(
    block: CompressionBlock,
    active: Set<string>,
): string[] | null {
    return filterToActive(block.effectiveMessageIds, active)
}
