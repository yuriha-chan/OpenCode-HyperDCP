import type { Plugin } from "@opencode/plugin/tui"

export type TuiMessageEntry = {
    id: string
    type: string
    text?: string
    content?: unknown[]
    output?: string
}

export interface TuiTransport {
    sendEditCommand(sessionID: string, argumentsText: string): Promise<unknown>
    readSessionMessages(sessionID: string): Promise<TuiMessageEntry[]>
}

type V1Client = {
    session: {
        command(input: { sessionID: string; command: string; arguments: string }): Promise<unknown>
        messages(input: { sessionID: string }): Promise<unknown>
    }
}

type V1Message = {
    info?: { id?: string; role?: string }
    parts?: unknown[]
}

type V2Client = Pick<Plugin.Context["client"], "session" | "message">
type V2Message = Awaited<ReturnType<V2Client["message"]["list"]>>["data"][number]

function mapV2Content(content: unknown[]): unknown[] {
    return content.map((part) => {
        if (typeof part !== "object" || part === null) return part
        const record = part as Record<string, unknown>
        if (record.type === "tool" && typeof record.name === "string") {
            return { ...record, tool: record.name }
        }
        return part
    })
}

function mapV2Message(message: V2Message): TuiMessageEntry {
    const entry: TuiMessageEntry = {
        id: message.id ?? "",
        type: message.type ?? "",
    }
    if ("text" in message && typeof message.text === "string") entry.text = message.text
    if ("content" in message && Array.isArray(message.content))
        entry.content = mapV2Content(message.content)
    if ("output" in message && typeof message.output === "string") entry.output = message.output
    return entry
}

export function createV1TuiTransport(client: unknown): TuiTransport {
    const api = client as V1Client
    return {
        async sendEditCommand(sessionID: string, argumentsText: string): Promise<unknown> {
            return api.session.command({
                sessionID,
                command: "dcp",
                arguments: argumentsText,
            })
        },
        async readSessionMessages(sessionID: string): Promise<TuiMessageEntry[]> {
            const response = (await api.session.messages({ sessionID })) as
                { data?: V1Message[] } | undefined
            const data = response?.data
            if (!Array.isArray(data)) return []
            return data.map((message) => ({
                id: message.info?.id ?? "",
                type: message.info?.role ?? "",
                content: message.parts,
            }))
        },
    }
}

export function createV2TuiTransport(api: V2Client): TuiTransport {
    return {
        async sendEditCommand(sessionID: string, argumentsText: string): Promise<unknown> {
            return api.session.command({
                sessionID,
                name: "dcp",
                text: argumentsText,
            })
        },
        async readSessionMessages(sessionID: string): Promise<TuiMessageEntry[]> {
            const entries: TuiMessageEntry[] = []
            let cursor: string | undefined
            while (true) {
                const input: Parameters<V2Client["message"]["list"]>[0] = {
                    sessionID,
                    limit: 200,
                    ...(cursor === undefined ? { order: "asc" as const } : { cursor }),
                }
                const page = await api.message.list(input)
                const data = page?.data
                if (Array.isArray(data)) {
                    for (const message of data) entries.push(mapV2Message(message))
                }
                const next = page?.cursor?.next
                if (typeof next !== "string" || next.length === 0) break
                cursor = next
            }
            return entries
        },
    }
}
