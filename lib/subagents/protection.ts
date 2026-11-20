import type { CompressionBlock, MessageIdState } from "../state/types"

export type SubagentExecutionStatus = "running" | "completed" | "canceled" | "failed"

export interface SubagentSteeringMessage {
    messageId: string
    callId: string
}

export interface SubagentExecution {
    callingMessageId: string
    callId: string
    sessionId: string
    status: SubagentExecutionStatus
    title: string
    steeringMessages: SubagentSteeringMessage[]
    terminationMessageId?: string
    report?: string
}

export type SubagentObservation =
    | {
          type: "call"
          messageId: string
          callId: string
          sessionId: string
          title?: string
          query?: string
      }
    | {
          type: "terminal"
          messageId: string
          sessionId: string
          callId?: string
          status: Exclude<SubagentExecutionStatus, "running">
          report: string
      }

export type SubagentProtectionMode = "none" | "metadata" | "full"

function identityKey(messageId: string, callId: string): string {
    return `${messageId}\u0000${callId}`
}

function terminalKey(messageId: string, sessionId: string): string {
    return `${messageId}\u0000${sessionId}`
}

function resolveTitle(title: string | undefined, query: string | undefined): string {
    if (title !== undefined && title.trim().length > 0) return title
    return query ? query.slice(0, 120) : ""
}

function cloneExecution(entry: SubagentExecution): SubagentExecution {
    return {
        callingMessageId: entry.callingMessageId,
        callId: entry.callId,
        sessionId: entry.sessionId,
        status: entry.status,
        title: entry.title,
        steeringMessages: entry.steeringMessages.map((steering) => ({
            messageId: steering.messageId,
            callId: steering.callId,
        })),
        ...(entry.terminationMessageId !== undefined
            ? { terminationMessageId: entry.terminationMessageId }
            : {}),
        ...(entry.report !== undefined ? { report: entry.report } : {}),
    }
}

function resolveRef(messageIds: MessageIdState, messageId: string): string {
    return messageIds.byRawId.get(messageId) ?? messageId
}

export function reconcileSubagentExecutions(
    existing: readonly SubagentExecution[],
    observations: readonly SubagentObservation[],
): SubagentExecution[] {
    const result = existing.map(cloneExecution)
    const calls = new Map<string, number>()
    const callIds = new Map<string, number>()
    const steering = new Map<string, number>()
    const terminals = new Map<string, number>()
    const activeBySession = new Map<string, number>()

    for (const [index, entry] of result.entries()) {
        calls.set(identityKey(entry.callingMessageId, entry.callId), index)
        callIds.set(entry.callId, index)
        for (const message of entry.steeringMessages) {
            steering.set(identityKey(message.messageId, message.callId), index)
            callIds.set(message.callId, index)
        }
        if (entry.terminationMessageId !== undefined)
            terminals.set(terminalKey(entry.terminationMessageId, entry.sessionId), index)
        if (entry.status === "running") activeBySession.set(entry.sessionId, index)
    }

    for (const observation of observations) {
        if (observation.type === "call") {
            const identity = identityKey(observation.messageId, observation.callId)
            const knownCall = calls.get(identity)
            if (knownCall !== undefined) {
                activeBySession.set(observation.sessionId, knownCall)
                continue
            }
            const knownSteering = steering.get(identity)
            if (knownSteering !== undefined) {
                activeBySession.set(observation.sessionId, knownSteering)
                continue
            }

            const active = activeBySession.get(observation.sessionId)
            if (active !== undefined && result[active]!.status === "running") {
                result[active]!.steeringMessages.push({
                    messageId: observation.messageId,
                    callId: observation.callId,
                })
                steering.set(identity, active)
                callIds.set(observation.callId, active)
                continue
            }

            const index = result.length
            result.push({
                callingMessageId: observation.messageId,
                callId: observation.callId,
                sessionId: observation.sessionId,
                status: "running",
                title: resolveTitle(observation.title, observation.query),
                steeringMessages: [],
            })
            calls.set(identity, index)
            callIds.set(observation.callId, index)
            activeBySession.set(observation.sessionId, index)
            continue
        }

        let target = observation.callId === undefined ? undefined : callIds.get(observation.callId)
        if (target === undefined)
            target = terminals.get(terminalKey(observation.messageId, observation.sessionId))
        if (target === undefined) target = activeBySession.get(observation.sessionId)
        if (target === undefined) continue

        const entry = result[target]!
        if (entry.terminationMessageId !== undefined) {
            activeBySession.set(observation.sessionId, target)
            continue
        }

        entry.status = observation.status
        entry.terminationMessageId = observation.messageId
        entry.report = observation.report
        terminals.set(terminalKey(observation.messageId, observation.sessionId), target)
        activeBySession.set(entry.sessionId, target)
        activeBySession.set(observation.sessionId, target)
    }

    return result
}

export function selectProtectedSubagents(
    entries: readonly SubagentExecution[],
    mode: SubagentProtectionMode,
    latestProjectedBlock: CompressionBlock | null | undefined,
): SubagentExecution[] {
    if (mode === "none") return []
    const covered = new Set(latestProjectedBlock?.effectiveMessageIds ?? [])
    return entries.filter(
        (entry) =>
            entry.status === "running" ||
            (entry.terminationMessageId !== undefined && covered.has(entry.terminationMessageId)),
    )
}

export function renderProtectedSubagents(
    entries: readonly SubagentExecution[],
    mode: SubagentProtectionMode,
    messageIds: MessageIdState,
): string {
    if (mode === "none") return ""
    const blocks = entries.map((entry) => {
        const lines = [
            "Subagent execution",
            `call: ${resolveRef(messageIds, entry.callingMessageId)}`,
            `session: ${entry.sessionId}`,
            `status: ${entry.status}`,
            `title: ${entry.title}`,
        ]
        if (entry.steeringMessages.length > 0) {
            lines.push(
                `steering: ${entry.steeringMessages
                    .map((message) => resolveRef(messageIds, message.messageId))
                    .join(", ")}`,
            )
        }
        if (entry.status === "completed" && entry.terminationMessageId !== undefined) {
            lines.push(`result: ${resolveRef(messageIds, entry.terminationMessageId)}`)
        }
        if (mode === "full" && entry.report !== undefined) {
            lines.push("report:")
            lines.push(entry.report)
        }
        return lines.join("\n")
    })
    return blocks.join("\n\n")
}
