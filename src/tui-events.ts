import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Plugin } from "@opencode/plugin/tui"
import type { TuiSessionCache } from "./tui-cache"

function messageIDFromEvent(eventID: string): string {
    return eventID.replace(/^evt_/, "msg_")
}

export function subscribeV1Refresh(
    event: TuiPluginApi["event"],
    cache: TuiSessionCache,
): () => void {
    const unsubscribe: Array<() => void> = []

    unsubscribe.push(
        event.on("message.updated", (raw) => {
            const properties = raw.properties
            const messageID = properties?.info?.id
            const sessionID = properties?.info?.sessionID ?? properties?.sessionID
            if (sessionID === undefined || messageID === undefined) return
            cache.markMessageChanged(sessionID, messageID)
        }),
    )

    unsubscribe.push(
        event.on("message.part.updated", (raw) => {
            const properties = raw.properties
            const messageID = properties?.part?.messageID
            const sessionID = properties?.part?.sessionID ?? properties?.sessionID
            if (sessionID === undefined || messageID === undefined) return
            cache.markMessageChanged(sessionID, messageID)
        }),
    )

    unsubscribe.push(
        event.on("message.removed", (raw) => {
            const properties = raw.properties
            const messageID = properties?.messageID
            if (properties?.sessionID === undefined || messageID === undefined) return
            cache.removeMessage(properties.sessionID, messageID)
        }),
    )

    unsubscribe.push(
        event.on("session.idle", (raw) => {
            const sessionID = raw.properties.sessionID
            if (sessionID === undefined) return
            void cache.complete(sessionID)
        }),
    )

    return () => {
        for (const stop of unsubscribe) stop()
    }
}

export function subscribeV2Refresh(
    data: Plugin.Context["data"],
    cache: TuiSessionCache,
): () => void {
    const unsubscribe: Array<() => void> = []
    const compactions = new Map<string, string>()
    const queueAssistant = (sessionID: string, messageID: string) => {
        cache.markMessageChanged(sessionID, messageID)
    }
    const queueDerived = (sessionID: string, eventID: string) => {
        cache.markMessageChanged(sessionID, messageIDFromEvent(eventID))
    }

    unsubscribe.push(
        data.on("session.step.started", (event) =>
            queueAssistant(event.data.sessionID, event.data.assistantMessageID),
        ),
    )
    unsubscribe.push(
        data.on("session.step.first-token", (event) =>
            queueAssistant(event.data.sessionID, event.data.assistantMessageID),
        ),
    )
    unsubscribe.push(
        data.on("session.step.streamed", (event) =>
            queueAssistant(event.data.sessionID, event.data.assistantMessageID),
        ),
    )
    unsubscribe.push(
        data.on("session.step.ended", (event) =>
            queueAssistant(event.data.sessionID, event.data.assistantMessageID),
        ),
    )
    unsubscribe.push(
        data.on("session.step.failed", (event) =>
            queueAssistant(event.data.sessionID, event.data.assistantMessageID),
        ),
    )
    unsubscribe.push(
        data.on("session.text.started", (event) =>
            queueAssistant(event.data.sessionID, event.data.assistantMessageID),
        ),
    )
    unsubscribe.push(
        data.on("session.text.delta", (event) =>
            queueAssistant(event.data.sessionID, event.data.assistantMessageID),
        ),
    )
    unsubscribe.push(
        data.on("session.text.ended", (event) =>
            queueAssistant(event.data.sessionID, event.data.assistantMessageID),
        ),
    )
    unsubscribe.push(
        data.on("session.reasoning.started", (event) =>
            queueAssistant(event.data.sessionID, event.data.assistantMessageID),
        ),
    )
    unsubscribe.push(
        data.on("session.reasoning.delta", (event) =>
            queueAssistant(event.data.sessionID, event.data.assistantMessageID),
        ),
    )
    unsubscribe.push(
        data.on("session.reasoning.ended", (event) =>
            queueAssistant(event.data.sessionID, event.data.assistantMessageID),
        ),
    )
    unsubscribe.push(
        data.on("session.tool.input.started", (event) =>
            queueAssistant(event.data.sessionID, event.data.assistantMessageID),
        ),
    )
    unsubscribe.push(
        data.on("session.tool.input.delta", (event) =>
            queueAssistant(event.data.sessionID, event.data.assistantMessageID),
        ),
    )
    unsubscribe.push(
        data.on("session.tool.input.ended", (event) =>
            queueAssistant(event.data.sessionID, event.data.assistantMessageID),
        ),
    )
    unsubscribe.push(
        data.on("session.tool.called", (event) =>
            queueAssistant(event.data.sessionID, event.data.assistantMessageID),
        ),
    )
    unsubscribe.push(
        data.on("session.tool.progress", (event) =>
            queueAssistant(event.data.sessionID, event.data.assistantMessageID),
        ),
    )
    unsubscribe.push(
        data.on("session.tool.success", (event) =>
            queueAssistant(event.data.sessionID, event.data.assistantMessageID),
        ),
    )
    unsubscribe.push(
        data.on("session.tool.failed", (event) =>
            queueAssistant(event.data.sessionID, event.data.assistantMessageID),
        ),
    )

    unsubscribe.push(
        data.on("session.inbox.delivered", (event) =>
            cache.markMessageChanged(event.data.sessionID, event.data.inboxID),
        ),
    )

    unsubscribe.push(
        data.on("session.agent.selected", (event) => queueDerived(event.data.sessionID, event.id)),
    )
    unsubscribe.push(
        data.on("session.model.selected", (event) => queueDerived(event.data.sessionID, event.id)),
    )
    unsubscribe.push(
        data.on("session.moved", (event) => queueDerived(event.data.sessionID, event.id)),
    )
    unsubscribe.push(
        data.on("session.synthetic", (event) => queueDerived(event.data.sessionID, event.id)),
    )
    unsubscribe.push(
        data.on("session.skill.activated", (event) => queueDerived(event.data.sessionID, event.id)),
    )
    unsubscribe.push(
        data.on("session.instructions.updated", (event) => {
            if (event.data.text === undefined) return
            queueDerived(event.data.sessionID, event.id)
        }),
    )
    unsubscribe.push(
        data.on("session.compaction.started", (event) => {
            const messageID = event.data.inputID ?? messageIDFromEvent(event.id)
            compactions.set(event.data.sessionID, messageID)
            cache.markMessageChanged(event.data.sessionID, messageID)
        }),
    )
    unsubscribe.push(
        data.on("session.compaction.ended", (event) => {
            const messageID = compactions.get(event.data.sessionID) ?? messageIDFromEvent(event.id)
            compactions.delete(event.data.sessionID)
            cache.markMessageChanged(event.data.sessionID, messageID)
        }),
    )
    unsubscribe.push(
        data.on("session.compaction.failed", (event) => {
            const messageID =
                compactions.get(event.data.sessionID) ??
                event.data.inputID ??
                messageIDFromEvent(event.id)
            compactions.delete(event.data.sessionID)
            cache.markMessageChanged(event.data.sessionID, messageID)
        }),
    )

    unsubscribe.push(
        data.on("session.execution.succeeded", (event) => {
            queueDerived(event.data.sessionID, event.id)
            void cache.complete(event.data.sessionID)
        }),
    )
    unsubscribe.push(
        data.on("session.execution.failed", (event) => {
            queueDerived(event.data.sessionID, event.id)
            void cache.complete(event.data.sessionID)
        }),
    )
    unsubscribe.push(
        data.on("session.execution.interrupted", (event) => {
            if (event.data.reason === "shutdown") return
            queueDerived(event.data.sessionID, event.id)
            void cache.complete(event.data.sessionID)
        }),
    )
    unsubscribe.push(
        data.on("session.idle", (event) => {
            void cache.complete(event.data.sessionID)
        }),
    )

    unsubscribe.push(
        data.on("session.revert.committed", (event) => {
            const { sessionID, to } = event.data
            const boundary = cache.get(sessionID).messages
            const start = boundary.findIndex((message) => message.id === to)
            if (start === -1) return
            for (const message of boundary.slice(start)) cache.removeMessage(sessionID, message.id)
        }),
    )

    return () => {
        for (const stop of unsubscribe) stop()
    }
}
