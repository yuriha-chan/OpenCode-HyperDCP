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

type V2Client = {
    session: {
        command(input: { sessionID: string; name: string; text: string }): Promise<unknown>
    }
    message: {
        list(input: {
            sessionID: string
            limit: number
            order?: "asc"
            cursor?: string
        }): Promise<unknown>
    }
}

type V2Message = {
    id?: string
    type?: string
    text?: string
    content?: unknown[]
    output?: string
}

type V2ListPage = {
    data?: V2Message[]
    cursor?: { next?: string }
}

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
    if (typeof message.text === "string") entry.text = message.text
    if (Array.isArray(message.content)) entry.content = mapV2Content(message.content)
    if (typeof message.output === "string") entry.output = message.output
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
                | { data?: V1Message[] }
                | undefined
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

export function createV2TuiTransport(client: unknown): TuiTransport {
    const api = client as V2Client
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
                const input: { sessionID: string; limit: number; order?: "asc"; cursor?: string } =
                    {
                        sessionID,
                        limit: 200,
                    }
                if (cursor === undefined) input.order = "asc"
                else input.cursor = cursor
                const page = (await api.message.list(input)) as V2ListPage | undefined
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
