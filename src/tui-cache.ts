import type { TuiMessageEntry } from "./tui-client"
import type { TuiCacheSnapshot, TuiCachedState } from "./tui-state"
import { isDeepStrictEqual } from "node:util"

export interface TuiSessionCacheDependencies {
    readSessionMessages(sessionID: string): Promise<TuiMessageEntry[]>
    readSessionMessage(sessionID: string, messageID: string): Promise<TuiMessageEntry>
    readState(sessionID: string): Promise<TuiCachedState>
    onError(error: unknown): void
}

export interface TuiSessionCache {
    get(sessionID: string): TuiCacheSnapshot
    observe(sessionID: string, listener: () => void): () => void
    markMessageChanged(sessionID: string, messageID: string): void
    complete(sessionID: string): Promise<void>
    refreshCommitted(sessionID: string): Promise<void>
    removeMessage(sessionID: string, messageID: string): void
    dispose(): void
}

interface SessionCacheEntry {
    id: string
    messages: TuiMessageEntry[]
    state: TuiCachedState
    initialized: boolean
    hasState: boolean
    listeners: Map<symbol, () => void>
    initialLoad: Promise<boolean> | null
    initialToken: object | null
    stateLoad: Promise<void> | null
    stateToken: object | null
    dirtyQueue: string[]
    dirtySet: Set<string>
    readyQueue: string[]
    readySet: Set<string>
    failedDirty: Set<string>
    removed: Set<string>
    drain: Promise<void> | null
    drainToken: object | null
}

function emptyState(): TuiCachedState {
    return { blocks: [], trackedMessages: [], memo: null, stats: null, skills: [] }
}

function createSessionEntry(sessionID: string): SessionCacheEntry {
    return {
        id: sessionID,
        messages: [],
        state: emptyState(),
        initialized: false,
        hasState: false,
        listeners: new Map(),
        initialLoad: null,
        initialToken: null,
        stateLoad: null,
        stateToken: null,
        dirtyQueue: [],
        dirtySet: new Set(),
        readyQueue: [],
        readySet: new Set(),
        failedDirty: new Set(),
        removed: new Set(),
        drain: null,
        drainToken: null,
    }
}

export function createTuiSessionCache(dependencies: TuiSessionCacheDependencies): TuiSessionCache {
    const sessions = new Map<string, SessionCacheEntry>()
    let timer: ReturnType<typeof setInterval> | null = null
    let disposed = false

    function ensureSession(sessionID: string): SessionCacheEntry {
        let session = sessions.get(sessionID)
        if (session === undefined) {
            session = createSessionEntry(sessionID)
            sessions.set(sessionID, session)
        }
        return session
    }

    function notify(session: SessionCacheEntry): void {
        if (disposed) return
        for (const listener of [...session.listeners.values()]) {
            if (disposed) return
            try {
                listener()
            } catch (error) {
                dependencies.onError(error)
            }
        }
    }

    function applyState(session: SessionCacheEntry, incoming: TuiCachedState): void {
        const previous = session.state
        const sameBlocks = isDeepStrictEqual(previous.blocks, incoming.blocks)
        const sameTracked = isDeepStrictEqual(previous.trackedMessages, incoming.trackedMessages)
        const sameMemo = previous.memo === incoming.memo
        const sameStats = isDeepStrictEqual(previous.stats, incoming.stats)
        const sameSkills = isDeepStrictEqual(previous.skills, incoming.skills)
        session.hasState = true
        if (sameBlocks && sameTracked && sameMemo && sameStats && sameSkills) return
        session.state = {
            skills: sameSkills ? previous.skills : incoming.skills,
            blocks: sameBlocks ? previous.blocks : incoming.blocks,
            trackedMessages: sameTracked ? previous.trackedMessages : incoming.trackedMessages,
            memo: incoming.memo,
            stats: sameStats ? previous.stats : incoming.stats,
        }
        notify(session)
    }

    function clearStateLoad(session: SessionCacheEntry, token: object): void {
        if (session.stateToken !== token) return
        session.stateLoad = null
        session.stateToken = null
    }

    function loadState(session: SessionCacheEntry): Promise<void> {
        if (disposed) return Promise.resolve()
        if (session.stateLoad !== null) return session.stateLoad

        const token = {}
        session.stateToken = token
        let read: Promise<TuiCachedState>
        try {
            read = Promise.resolve(dependencies.readState(session.id))
        } catch (error) {
            read = Promise.reject(error)
        }
        const handled = read.then(
            (incoming) => {
                if (disposed) return
                applyState(session, incoming)
            },
            (error) => {
                if (!disposed) dependencies.onError(error)
            },
        )
        const run = handled.then(
            () => {
                clearStateLoad(session, token)
            },
            () => {
                clearStateLoad(session, token)
            },
        )
        session.stateLoad = run
        return run
    }

    function mergeInitialMessages(
        session: SessionCacheEntry,
        messages: TuiMessageEntry[],
    ): TuiMessageEntry[] {
        if (session.removed.size === 0) return messages
        return messages.filter((message) => !session.removed.has(message.id))
    }

    function clearInitialLoad(session: SessionCacheEntry, token: object): void {
        if (session.initialToken !== token) return
        session.initialLoad = null
        session.initialToken = null
    }

    function loadInitial(session: SessionCacheEntry): Promise<boolean> {
        if (disposed) return Promise.resolve(false)
        if (session.initialized) return Promise.resolve(true)
        if (session.initialLoad !== null) return session.initialLoad

        const token = {}
        session.initialToken = token
        let read: Promise<TuiMessageEntry[]>
        try {
            read = Promise.resolve(dependencies.readSessionMessages(session.id))
        } catch (error) {
            read = Promise.reject(error)
        }
        let loaded = false
        const handled = read.then(
            (messages) => {
                if (disposed) return
                session.messages = mergeInitialMessages(session, messages)
                session.initialized = true
                loaded = true
                notify(session)
            },
            (error) => {
                if (!disposed) dependencies.onError(error)
            },
        )
        const run = handled.then(
            () => {
                clearInitialLoad(session, token)
                return loaded && !disposed
            },
            () => {
                clearInitialLoad(session, token)
                return loaded && !disposed
            },
        )
        session.initialLoad = run
        return run
    }

    function applyTargeted(
        session: SessionCacheEntry,
        messageID: string,
        entry: TuiMessageEntry,
    ): void {
        const index = session.messages.findIndex((message) => message.id === messageID)
        if (index === -1) {
            session.messages = [...session.messages, entry]
            return
        }
        const next = session.messages.slice()
        next[index] = entry
        session.messages = next
    }

    function clearDrain(session: SessionCacheEntry, token: object): void {
        if (session.drainToken !== token) return
        session.drain = null
        session.drainToken = null
    }

    function ensureTimer(): void {
        if (disposed || timer !== null) return
        const handle = setInterval(() => {
            if (disposed) return
            for (const session of sessions.values()) {
                if (session.listeners.size > 0) void refreshCommitted(session.id)
            }
        }, 500)
        const maybeUnref = handle as unknown as { unref?: () => void }
        if (typeof maybeUnref.unref === "function") maybeUnref.unref()
        timer = handle
    }

    function stopTimerIfUnobserved(): void {
        if (timer === null) return
        for (const session of sessions.values()) {
            if (session.listeners.size > 0) return
        }
        clearInterval(timer)
        timer = null
    }

    function get(sessionID: string): TuiCacheSnapshot {
        if (disposed) return { messages: [], state: emptyState() }
        const session = sessions.get(sessionID)
        if (session === undefined) return { messages: [], state: emptyState() }
        return { messages: session.messages, state: session.state }
    }

    function observe(sessionID: string, listener: () => void): () => void {
        if (disposed) return () => {}
        const session = ensureSession(sessionID)
        const wasObserved = session.listeners.size > 0
        const token = Symbol("tui-session-observer")
        session.listeners.set(token, listener)
        ensureTimer()
        if (!wasObserved || !session.hasState) void loadState(session)
        void loadInitial(session)
        let released = false
        return () => {
            if (released) return
            released = true
            session.listeners.delete(token)
            stopTimerIfUnobserved()
        }
    }

    function markMessageChanged(sessionID: string, messageID: string): void {
        if (disposed) return
        const session = ensureSession(sessionID)
        if (session.removed.has(messageID)) return
        if (session.dirtySet.has(messageID)) return
        session.dirtySet.add(messageID)
        session.dirtyQueue.push(messageID)
    }

    function complete(sessionID: string): Promise<void> {
        if (disposed) return Promise.resolve()
        const session = ensureSession(sessionID)
        for (const messageID of [...session.dirtyQueue, ...session.failedDirty]) {
            if (session.removed.has(messageID) || session.readySet.has(messageID)) continue
            session.readySet.add(messageID)
            session.readyQueue.push(messageID)
        }
        session.dirtyQueue = []
        session.dirtySet.clear()
        session.failedDirty.clear()
        if (session.drain !== null) return session.drain
        if (session.readyQueue.length === 0) return Promise.resolve()

        const token = {}
        session.drainToken = token
        const work = (async () => {
            const initialized = await loadInitial(session)
            if (!initialized || disposed) return

            while (!disposed) {
                const messageID = session.readyQueue.shift()
                if (messageID === undefined) break
                session.readySet.delete(messageID)
                if (session.removed.has(messageID)) continue

                let entry: TuiMessageEntry
                try {
                    entry = await dependencies.readSessionMessage(session.id, messageID)
                } catch (error) {
                    if (disposed) return
                    session.failedDirty.add(messageID)
                    dependencies.onError(error)
                    continue
                }

                if (disposed || session.removed.has(messageID)) continue
                applyTargeted(session, messageID, entry)
                notify(session)
            }
        })()
        const run = work.then(
            () => {
                clearDrain(session, token)
            },
            (error) => {
                clearDrain(session, token)
                if (!disposed) dependencies.onError(error)
            },
        )
        session.drain = run
        return run
    }

    function refreshCommitted(sessionID: string): Promise<void> {
        if (disposed) return Promise.resolve()
        return loadState(ensureSession(sessionID))
    }

    function removeMessage(sessionID: string, messageID: string): void {
        if (disposed) return
        const session = ensureSession(sessionID)
        session.removed.add(messageID)
        session.dirtySet.delete(messageID)
        session.failedDirty.delete(messageID)
        session.readySet.delete(messageID)
        session.readyQueue = session.readyQueue.filter((queued) => queued !== messageID)
        if (session.dirtyQueue.length > 0) {
            session.dirtyQueue = session.dirtyQueue.filter((queued) => queued !== messageID)
        }
        const next = session.messages.filter((message) => message.id !== messageID)
        if (next.length === session.messages.length) return
        session.messages = next
        notify(session)
    }

    function dispose(): void {
        if (disposed) return
        disposed = true
        if (timer !== null) {
            clearInterval(timer)
            timer = null
        }
        sessions.clear()
    }

    return {
        get,
        observe,
        markMessageChanged,
        complete,
        refreshCommitted,
        removeMessage,
        dispose,
    }
}
