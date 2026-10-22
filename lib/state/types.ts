import type { CompressionTimingState } from "../compress/timing"
import { Message, Part } from "@opencode-ai/sdk/v2"

export interface WithParts {
    info: Message
    parts: Part[]
}

export type ToolStatus = "pending" | "running" | "completed" | "error"

export interface ToolParameterEntry {
    tool: string
    parameters: any
    status?: ToolStatus
    error?: string
    turn: number
    tokenCount?: number
}

export interface SessionStats {
    pruneTokenCounter: number
    totalPruneTokens: number
}

export interface PrunedMessageEntry {
    tokenCount: number
    allBlockIds: number[]
    activeBlockIds: number[]
}

export type CompressionMode = "range" | "message"

export interface CompressionBlock {
    blockId: number
    runId: number
    active: boolean
    deactivatedByUser: boolean
    compressedTokens: number
    summaryTokens: number
    durationMs: number
    mode?: CompressionMode
    topic: string
    batchTopic?: string
    startId: string
    endId: string
    anchorMessageId: string
    compressMessageId: string
    compressCallId?: string
    includedBlockIds: number[]
    consumedBlockIds: number[]
    parentBlockIds: number[]
    directMessageIds: string[]
    directToolIds: string[]
    effectiveMessageIds: string[]
    effectiveToolIds: string[]
    createdAt: number
    deactivatedAt?: number
    deactivatedByBlockId?: number
    summary: string
    summaryVersions: string[]
    activeVersionIndex: number // 0=disabled, 1=original, 2+=rewrites
    pendingEditBuffer?: string
    pendingExpandedMessageIds?: string[]
}

export interface PruneMessagesState {
    byMessageId: Map<string, PrunedMessageEntry>
    blocksById: Map<number, CompressionBlock>
    activeBlockIds: Set<number>
    activeByAnchorMessageId: Map<string, number>
    nextBlockId: number
    nextRunId: number
    lastSeenUserMessageId: string
    activeMessageIds: string[]
}

export interface Prune {
    tools: Map<string, number>
    messages: PruneMessagesState
}

export interface PendingManualTrigger {
    sessionId: string
    prompt: string
}

export interface MessageIdState {
    byRawId: Map<string, string>
    byRef: Map<string, string>
    nextRef: number
}

export interface Nudges {
    contextLimitAnchors: Set<string>
    turnNudgeAnchors: Set<string>
    iterationNudgeAnchors: Set<string>
}

export interface DebugState {
    enabled: boolean
    directory: string | null
}

export interface SessionState {
    sessionId: string | null
    isSubAgent: boolean
    manualMode: false | "active" | "compress-pending"
    preCompressManualMode: false | "active"
    compressPermission: "ask" | "allow" | "deny" | undefined
    pendingManualTrigger: PendingManualTrigger | null
    prune: Prune
    nudges: Nudges
    stats: SessionStats
    compressionTiming: CompressionTimingState
    toolParameters: Map<string, ToolParameterEntry>
    subAgentResultCache: Map<string, string>
    toolIdList: string[]
    messageIds: MessageIdState
    lastCompaction: number
    currentTurn: number
    modelContextLimit: number | undefined
    systemPromptTokens: number | undefined
    protectedRefs: Set<string>
    memo: string | null
    debug: DebugState
    autotoggle: boolean
    revision: number
    contentRevision: number
    housekeeping: HousekeepingTransaction | null
    housekeepingHistory: HousekeepingTransaction[]
}

export interface HousekeepingDraft {
    prune: Prune
    stats: SessionStats
    memo: string | null
    nudges: Nudges
}

export interface HousekeepingSourcePart {
    messageId: string
    partId: string
}

export interface HousekeepingOperation {
    callId: string
    messageId: string
    partId: string | null
    tool: string
    input: unknown
    result: string
}

export interface HousekeepingOperationResult {
    result: string
}

export interface HousekeepingTransaction {
    id: string
    sessionId: string
    entryMessageId: string
    entryPartId: string | null
    entryCallId: string
    entryCreatedAt: number
    sourceParts: HousekeepingSourcePart[]
    baseRevision: number
    base: HousekeepingDraft
    draft: HousekeepingDraft
    operations: Record<string, string>
    operationResults: Record<string, HousekeepingOperationResult>
    operationRecords: HousekeepingOperation[]
    entryGuidance?: string
    notifications?: Array<{
        blockId: number
        runId: number
        summary: string
        summaryTokens: number
    }>
    batchTopic?: string
    operationOrder: string[]
    operationDrafts: Record<string, HousekeepingDraft>
    reverted?: boolean
    completed?: {
        leaveMessageId: string
        leavePartId: string | null
        leaveCallId: string
        receipt: string
        commitRevision: number
        committedDraft: HousekeepingDraft
    }
}
