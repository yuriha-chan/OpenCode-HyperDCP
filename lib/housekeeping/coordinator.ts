import type { SessionState } from "../state"
import type { HousekeepingDraft, HousekeepingTransaction } from "../state"
import { AsyncLocalStorage } from "node:async_hooks"

export const HOUSEKEEPING_DRAFT_VIEW = Symbol("housekeeping-draft-view")

export interface HousekeepingDraftViewMarker {
    root: SessionState
    transaction: HousekeepingTransaction
    draft: HousekeepingDraft
}

const queues = new WeakMap<SessionState, Promise<void>>()
const activeCoordinator = new AsyncLocalStorage<SessionState>()

export async function withSessionCoordinator<T>(
    state: SessionState,
    operation: () => Promise<T>,
): Promise<T> {
    if (activeCoordinator.getStore() === state) return operation()
    const previous = queues.get(state) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((resolve) => (release = resolve))
    queues.set(
        state,
        previous.then(() => next),
    )
    await previous
    try {
        return await activeCoordinator.run(state, operation)
    } finally {
        release()
    }
}
