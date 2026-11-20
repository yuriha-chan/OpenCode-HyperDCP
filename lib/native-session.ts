import type { WithParts } from "./state"

export interface NativeModelRef {
    id?: string
    providerID?: string
}

export interface NativePermissionRule {
    action: string
    resource: string
    effect: "ask" | "allow" | "deny"
}

export interface NativeSessionInfo {
    id?: string
    parentID?: string
    agent?: string
    model?: NativeModelRef
    permissions?: ReadonlyArray<NativePermissionRule>
    revert?: {
        messageID?: string
    }
}

export interface NativeToolContent {
    type: string
    text?: string
}

export interface NativeToolState {
    status: string
    input?: unknown
    metadata?: Record<string, unknown>
    content?: ReadonlyArray<NativeToolContent>
    error?: unknown
}

interface NativePartTime {
    created: number
    ran?: number
    completed?: number
}

export type NativeAssistantContent =
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string; time?: NativePartTime }
    | { type: "tool"; id: string; name: string; state: NativeToolState; time: NativePartTime }

export interface NativeSessionMessage {
    id: string
    type: string
    text?: string
    summary?: string
    status?: string
    agent?: string
    model?: NativeModelRef
    content?: ReadonlyArray<NativeAssistantContent>
    time?: {
        created?: number
        completed?: number
    }
}

export interface NativeSessionApi {
    context(input: { sessionID: string }): Promise<NativeSessionMessage[]>
    get(input: { sessionID: string }): Promise<NativeSessionInfo>
}

type AssistantInfo = Extract<WithParts["info"], { role: "assistant" }>
type UserInfo = Extract<WithParts["info"], { role: "user" }>
type CorePart = WithParts["parts"][number]
type CoreToolPart = Extract<CorePart, { type: "tool" }>
type CoreToolState = CoreToolPart["state"]

function partId(messageID: string, index: number): string {
    return `${messageID}:part:${index}`
}

function userInfo(message: NativeSessionMessage, sessionID: string): UserInfo {
    return {
        id: message.id,
        sessionID,
        role: "user",
        time: { created: message.time?.created ?? 0 },
        agent: message.agent ?? "user",
        model: {
            providerID: message.model?.providerID ?? "",
            modelID: message.model?.id ?? "",
        },
    }
}

function assistantInfo(
    message: NativeSessionMessage,
    sessionID: string,
    created: number,
): AssistantInfo {
    return {
        id: message.id,
        sessionID,
        role: "assistant",
        time: {
            created,
            ...(message.time?.completed !== undefined ? { completed: message.time.completed } : {}),
        },
        parentID: "",
        modelID: message.model?.id ?? "",
        providerID: message.model?.providerID ?? "",
        mode: "",
        agent: message.agent ?? "assistant",
        path: { cwd: "", root: "" },
        cost: 0,
        tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
        },
    }
}

function errorText(error: unknown): string {
    if (typeof error === "string") return error
    if (!error || typeof error !== "object") return String(error)
    const record = error as Record<string, unknown>
    if (typeof record.message === "string") return record.message
    const data = record.data
    if (
        data &&
        typeof data === "object" &&
        typeof (data as Record<string, unknown>).message === "string"
    )
        return (data as Record<string, string>).message
    return JSON.stringify(error)
}

function toolState(
    state: NativeToolState | undefined,
    start: number,
    end: number | undefined,
): CoreToolState {
    const input =
        state?.input && typeof state.input === "object"
            ? (state.input as Record<string, unknown>)
            : {}
    if (state?.status === "completed") {
        const output = (state.content ?? [])
            .filter((content) => content.type === "text")
            .map((content) => content.text ?? "")
            .join("")
        return {
            status: "completed",
            input,
            output,
            title: typeof state.metadata?.title === "string" ? state.metadata.title : "",
            metadata: state.metadata ?? {},
            time: { start, end: end ?? start },
        }
    }
    if (state?.status === "error")
        return {
            status: "error",
            input,
            error: errorText(state.error),
            metadata: state.metadata ?? {},
            time: { start, end: end ?? start },
        }
    if (state?.status === "running")
        return {
            status: "running",
            input,
            title: typeof state.metadata?.title === "string" ? state.metadata.title : undefined,
            metadata: state.metadata ?? {},
            time: { start },
        }
    return {
        status: "pending",
        input,
        raw: typeof state?.input === "string" ? state.input : "",
    }
}

function assistantParts(message: NativeSessionMessage, sessionID: string): CorePart[] {
    const created = message.time?.created ?? 0
    return (message.content ?? []).flatMap((content, index): CorePart[] => {
        if (content.type === "text")
            return [
                {
                    id: partId(message.id, index),
                    sessionID,
                    messageID: message.id,
                    type: "text",
                    text: content.text ?? "",
                },
            ]
        if (content.type === "reasoning")
            return [
                {
                    id: partId(message.id, index),
                    sessionID,
                    messageID: message.id,
                    type: "reasoning",
                    text: content.text ?? "",
                    time: {
                        start: content.time?.created ?? created,
                        ...(content.time?.completed !== undefined
                            ? { end: content.time.completed }
                            : {}),
                    },
                },
            ]
        if (content.type === "tool")
            return [
                {
                    id: partId(message.id, index),
                    sessionID,
                    messageID: message.id,
                    type: "tool",
                    callID: content.id,
                    tool: content.name,
                    state: toolState(
                        content.state,
                        content.time?.created ?? created,
                        content.time?.completed ?? content.time?.ran,
                    ),
                    metadata: content.state?.metadata,
                },
            ]
        return []
    })
}

export function normalizeNativeHistory(
    messages: NativeSessionMessage[],
    sessionID: string,
): WithParts[] {
    return messages.flatMap((message): WithParts[] => {
        const created = message.time?.created ?? 0
        if (message.type === "user")
            return [
                {
                    info: userInfo(message, sessionID),
                    parts: [
                        {
                            id: partId(message.id, 0),
                            sessionID,
                            messageID: message.id,
                            type: "text",
                            text: message.text ?? "",
                        },
                    ],
                },
            ]
        if (message.type === "assistant")
            return [
                {
                    info: assistantInfo(message, sessionID, created),
                    parts: assistantParts(message, sessionID),
                },
            ]
        if (message.type === "compaction" && message.status === "completed")
            return [
                {
                    info: {
                        ...assistantInfo(message, sessionID, created),
                        summary: true,
                    },
                    parts: [
                        {
                            id: partId(message.id, 0),
                            sessionID,
                            messageID: message.id,
                            type: "text",
                            text: message.summary ?? "",
                        },
                    ],
                },
            ]
        return []
    })
}

const NATIVE_TODO_STATUSES = new Set<unknown>(["pending", "in_progress", "completed", "cancelled"])

function parseNativeTodos(value: unknown): Array<{ content: string; status: unknown }> {
    if (!Array.isArray(value)) return []
    return value.flatMap((item) => {
        if (!item || typeof item !== "object") return []
        const record = item as Record<string, unknown>
        if (typeof record.content !== "string" || !record.content) return []
        return [
            {
                content: record.content,
                status: NATIVE_TODO_STATUSES.has(record.status) ? record.status : "pending",
            },
        ]
    })
}

export function nativeSessionTodos(
    messages: readonly NativeSessionMessage[],
    boundary?: string,
): unknown[] {
    const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1
    const scoped = boundaryIndex === -1 ? messages : messages.slice(0, boundaryIndex)
    let latest: NativeToolState | undefined
    for (const message of scoped) {
        if (message.type !== "assistant") continue
        for (const content of message.content ?? []) {
            if (content.type !== "tool" || content.name !== "todowrite") continue
            if (content.state.status === "completed") latest = content.state
        }
    }
    const input = latest?.input
    const todos =
        input && typeof input === "object" ? (input as Record<string, unknown>).todos : undefined
    return parseNativeTodos(todos)
}
