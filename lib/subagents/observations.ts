import { isDeepStrictEqual } from "node:util"
import type { WithParts, SessionState } from "../state"
import type { Logger } from "../logger"
import { saveSessionStateStrict } from "../state/persistence"
import type { NativeSessionMessage } from "../native-session"
import { reconcileSubagentExecutions, type SubagentObservation } from "./protection"

export async function syncSubagentExecutions(
    state: SessionState,
    logger: Logger,
    observations: readonly SubagentObservation[],
): Promise<void> {
    const entries = reconcileSubagentExecutions(state.subagentExecutions, observations)
    if (isDeepStrictEqual(entries, state.subagentExecutions)) return
    const next = structuredClone(state)
    next.subagentExecutions = entries
    await saveSessionStateStrict(next, logger)
    state.subagentExecutions = entries
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined
}

function childId(...values: unknown[]): string | undefined {
    return values
        .map(text)
        .find((value) => value?.trim())
        ?.trim()
}

function terminalStatus(value: unknown): "completed" | "canceled" | "failed" | undefined {
    if (value === "completed") return "completed"
    if (value === "canceled" || value === "cancelled") return "canceled"
    if (value === "failed" || value === "error") return "failed"
    return undefined
}

function body(value: string, tag: string): string {
    const match = value.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*)<\\/${tag}>`))
    return match ? match[1]!.replace(/^\r?\n/, "").replace(/\r?\n$/, "") : value
}

function taskEnvelope(value: string) {
    const match = value.match(/<task\s+id="([^"]+)"\s+state="([^"]+)"[^>]*>/)
    return match ? { sessionId: match[1]!, status: match[2]! } : undefined
}

export function v1SubagentObservations(messages: readonly WithParts[]): SubagentObservation[] {
    const observations: SubagentObservation[] = []
    for (const message of messages) {
        for (const part of message.parts) {
            if (part.type === "tool" && part.tool === "task" && part.state.status !== "pending") {
                const state = part.state
                const input = record(state.input)
                const metadata = record(state.metadata)
                const output =
                    state.status === "completed"
                        ? state.output
                        : state.status === "error"
                          ? state.error
                          : ""
                const envelope = taskEnvelope(output)
                const sessionId = childId(metadata.sessionId, input.task_id, envelope?.sessionId)
                if (!sessionId) continue
                observations.push({
                    type: "call",
                    messageId: message.info.id,
                    callId: part.callID,
                    sessionId,
                    title:
                        text("title" in state ? state.title : undefined) ?? text(input.description),
                    query: text(input.prompt),
                })
                const status =
                    state.status === "error"
                        ? output === "Task cancelled"
                            ? "canceled"
                            : "failed"
                        : terminalStatus(
                              envelope?.status ??
                                  (state.status === "completed" ? "completed" : undefined),
                          )
                if (status)
                    observations.push({
                        type: "terminal",
                        messageId: message.info.id,
                        callId: part.callID,
                        sessionId,
                        status,
                        report: body(output, status === "completed" ? "task_result" : "task_error"),
                    })
            } else if (message.info.role === "user" && part.type === "text" && part.synthetic) {
                const envelope = taskEnvelope(part.text)
                const status = terminalStatus(envelope?.status)
                if (envelope && status)
                    observations.push({
                        type: "terminal",
                        messageId: message.info.id,
                        sessionId: envelope.sessionId,
                        status,
                        report: body(
                            part.text,
                            status === "completed" ? "task_result" : "task_error",
                        ),
                    })
            }
        }
    }
    return observations
}

export function v2SubagentObservations(
    messages: readonly NativeSessionMessage[],
): SubagentObservation[] {
    const observations: SubagentObservation[] = []
    for (const message of messages) {
        if (message.type === "assistant") {
            for (const part of message.content) {
                if (part.type !== "tool" || part.name !== "subagent") continue
                const state = part.state
                const metadata = record("metadata" in state ? state.metadata : undefined)
                const input = record("input" in state ? state.input : undefined)
                const sessionId = childId(metadata.sessionID, input.sessionID)
                if (!sessionId) continue
                observations.push({
                    type: "call",
                    messageId: message.id,
                    callId: part.id,
                    sessionId,
                    title: text(input.description),
                    query: text(input.prompt),
                })
            }
        } else if (message.type === "synthetic" && message.metadata?.source === "subagent") {
            const sessionId = childId(message.metadata.childID)
            const status = terminalStatus(message.metadata.state)
            if (sessionId && status)
                observations.push({
                    type: "terminal",
                    messageId: message.id,
                    sessionId,
                    status,
                    report: body(message.text, "subagent"),
                })
        }
    }
    return observations
}
