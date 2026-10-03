/** @jsxImportSource @opentui/solid */
import "@opentui/core"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { Show, For, onCleanup, createSignal, createMemo } from "solid-js"
import { readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { getSessionFilePath } from "../lib/paths"
import { buildSummaryFile, parseSummaryFile } from "../lib/summary-file"
import { buildMemoFile, parseMemoFile } from "../lib/memo-file"

const DCP_MODE = "dcp-routes"
const DCP_BLOCK_MODE = "dcp-block"
const DCP_MEMO_MODE = "dcp-memo"

interface BlockInfo {
    blockId: number
    active: boolean
    activeVersionIndex: number
    topic: string
    batchTopic?: string
    mode?: string
    compressedTokens: number
    summaryTokens: number
    startId: string
    endId: string
    durationMs: number
    deactivatedByUser: boolean
    parentBlockIds: number[]
    includedBlockIds: number[]
    summary: string
    summaryVersions: string[]
}

interface MessageEntry {
    rawId: string
    ref: string
    tokenCount: number
    activeBlockIds: number[]
}

function estimateTokens(text: string): number {
    return Math.round(text.length / 4)
}

function activeSummaryText(block: any): string {
    const idx = typeof block.activeVersionIndex === "number" ? block.activeVersionIndex : 1
    if (idx === 0) return ""
    if (idx >= 2 && Array.isArray(block.summaryVersions) && idx - 2 < block.summaryVersions.length) {
        return block.summaryVersions[idx - 2]
    }
    return block.summary ?? ""
}

function readBlocks(sessionId: string): BlockInfo[] {
    try {
        const path = getSessionFilePath(sessionId)
        const content = readFileSync(path, "utf-8")
        const state = JSON.parse(content)
        const blocks = state?.prune?.messages?.blocksById
        if (!blocks || typeof blocks !== "object") return []
        return Object.values(blocks).map((block: any) => {
            const activeVersionIndex = block.activeVersionIndex ?? 1
            const summaryVersions: string[] = Array.isArray(block.summaryVersions) ? block.summaryVersions : []
            let summaryTokens = block.summaryTokens ?? 0
            if (activeVersionIndex === 0) {
                summaryTokens = 0
            } else if (activeVersionIndex > 1) {
                const versionText = summaryVersions[activeVersionIndex - 2]
                summaryTokens = typeof versionText === "string" ? estimateTokens(versionText) : 0
            }
            return {
                blockId: block.blockId ?? 0,
                active: block.active ?? false,
                activeVersionIndex,
                topic: block.topic ?? "",
                batchTopic: block.batchTopic,
                mode: block.mode,
                compressedTokens: block.compressedTokens ?? 0,
                summaryTokens,
                startId: block.startId ?? "",
                endId: block.endId ?? "",
                durationMs: block.durationMs ?? 0,
                deactivatedByUser: block.deactivatedByUser ?? false,
                parentBlockIds: Array.isArray(block.parentBlockIds) ? block.parentBlockIds : [],
                includedBlockIds: Array.isArray(block.includedBlockIds) ? block.includedBlockIds : [],
                summary: activeSummaryText(block),
                summaryVersions,
            }
        })
    } catch {
        return []
    }
}

function readSingleBlock(sessionId: string, blockId: number): BlockInfo | null {
    const blocks = readBlocks(sessionId)
    return blocks.find((b) => b.blockId === blockId) ?? null
}

function readMessages(sessionId: string): MessageEntry[] {
    try {
        const path = getSessionFilePath(sessionId)
        const content = readFileSync(path, "utf-8")
        const state = JSON.parse(content)

        // Build ref map from messageIds.byRawId (ALL messages known to DCP)
        const byRawId: Record<string, string> =
            state?.messageIds?.byRawId && typeof state.messageIds.byRawId === "object"
                ? state.messageIds.byRawId
                : {}

        // Build compression info from byMessageId (compressed messages only)
        const byMessageId: Record<string, any> =
            state?.prune?.messages?.byMessageId && typeof state.prune.messages.byMessageId === "object"
                ? state.prune.messages.byMessageId
                : {}

        // Collect all unique rawIds from both sources, preserving byRawId order (DCP ref order)
        const seen = new Set<string>()
        const allRawIds: string[] = []
        for (const rawId of Object.keys(byRawId)) {
            if (!seen.has(rawId)) { seen.add(rawId); allRawIds.push(rawId) }
        }
        // Also include compressed-only messages (edge case if byRawId is somehow missing them)
        for (const rawId of Object.keys(byMessageId)) {
            if (!seen.has(rawId)) { seen.add(rawId); allRawIds.push(rawId) }
        }

        return allRawIds.map((rawId) => {
            const entry = byMessageId[rawId]
            const ref = byRawId[rawId] ?? "?"
            return {
                rawId,
                ref,
                tokenCount: entry?.tokenCount ?? 0,
                activeBlockIds: Array.isArray(entry?.activeBlockIds) ? entry.activeBlockIds : [],
            }
        })
    } catch {
        return []
    }
}

function readMemo(sessionId: string): string | null {
    try {
        const path = getSessionFilePath(sessionId)
        const content = readFileSync(path, "utf-8")
        const state = JSON.parse(content)
        return typeof state?.memo === "string" ? state.memo : null
    } catch {
        return null
    }
}

function readStats(sessionId: string): { totalPruneTokens: number; totalMessagesPruned: number; totalToolsPruned: number; compressionRatio: number } | null {
    try {
        const path = getSessionFilePath(sessionId)
        const content = readFileSync(path, "utf-8")
        const state = JSON.parse(content)
        const stats = state?.stats
        if (!stats) return null
        return {
            totalPruneTokens: stats.totalPruneTokens ?? 0,
            totalMessagesPruned: stats.totalMessagesPruned ?? 0,
            totalToolsPruned: stats.totalToolsPruned ?? 0,
            compressionRatio: stats.compressionRatio ?? 0,
        }
    } catch {
        return null
    }
}

function tokenLabel(tokens: number): string {
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}K`
    return String(tokens)
}

function tokenLabelPrecise(tokens: number): string {
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`
    return `${tokens} tok`
}

function truncateText(text: string, maxLen: number): string {
    if (!text || text.length <= maxLen) return text
    return text.slice(0, maxLen) + "…"
}

function statusLabel(block: BlockInfo): string {
    if (block.active) return "active"
    if (block.deactivatedByUser) return "decompressed by user"
    return "inactive"
}

function look(map: Record<string, unknown>) {
    return {
        panel: ink(map, "backgroundPanel", "#1d1d1d"),
        border: ink(map, "border", "#4a4a4a"),
        text: ink(map, "text", "#f0f0f0"),
        muted: ink(map, "textMuted", "#999999"),
        pruned: ink(map, "textMuted", "#999999"),
        compressed: ink(map, "primary", "#47ff3d"),
        decompressed: ink(map, "secondary", "#cf5a42"),
    }
}

function ink(map: Record<string, unknown>, name: string, fallback: string): string {
    const value = map[name]
    if (typeof value === "string") return value
    return fallback
}

function log(api: TuiPluginApi, message: string) {
    return api.client.app.log({
        service: "dcp-blocks",
        level: "info",
        message,
        extra: {},
    })
}

function goHome(api: TuiPluginApi) {
    const sessionID = api.route.current.params?.sessionID as string | undefined
    if (sessionID) {
        api.route.navigate("session", { sessionID })
    } else {
        api.route.navigate("home")
    }
}

function goBack(api: TuiPluginApi, target: string, params?: Record<string, unknown>) {
    if (target === "home") {
        goHome(api)
    } else {
        api.route.navigate(target, params)
    }
}

function runEditor(editor: string, filePath: string): void {
    const parts = editor.split(/\s+/).filter(Boolean)
    const command = parts[0] ?? "vi"
    const args = [...parts.slice(1), filePath]
    spawnSync(command, args, { stdio: "inherit" })
}

async function editBlockSummary(api: TuiPluginApi, sessionID: string, blockId: number): Promise<void> {
    const block = readSingleBlock(sessionID, blockId)
    if (!block) {
        api.ui.toast({ variant: "error", message: `Block b${blockId} not found` })
        return
    }

    const original = block.summary ?? ""
    const filePath = join(tmpdir(), `dcp-summary-${blockId}-${Date.now()}.md`)
    writeFileSync(filePath, buildSummaryFile(original), "utf-8")

    const editor = process.env.VISUAL || process.env.EDITOR || "vi"
    api.renderer.suspend()
    try {
        runEditor(editor, filePath)
    } finally {
        api.renderer.resume()
    }

    let edited: string
    try {
        edited = parseSummaryFile(readFileSync(filePath, "utf-8"))
    } catch {
        rmSync(filePath, { force: true })
        api.ui.toast({ variant: "error", message: "Could not read the edited summary" })
        return
    }

    const trimmed = edited.trim()
    if (!trimmed) {
        rmSync(filePath, { force: true })
        api.ui.toast({ variant: "warning", message: "Edited summary is empty; nothing applied" })
        return
    }
    if (trimmed === original.trim()) {
        rmSync(filePath, { force: true })
        api.ui.toast({ variant: "info", message: `No changes to block b${blockId}` })
        return
    }

    writeFileSync(filePath, edited, "utf-8")
    try {
        await (api.client as any).session.command({
            sessionID,
            command: "dcp",
            arguments: `edit-file ${blockId} ${filePath}`,
        })
        api.ui.toast({ variant: "success", message: `Updated summary for block b${blockId}` })
    } catch {
        api.ui.toast({ variant: "error", message: `Failed to apply summary for block b${blockId}` })
    } finally {
        rmSync(filePath, { force: true })
    }
}

function pickBlockToEdit(api: TuiPluginApi, sessionID: string): void {
    const blocks = readBlocks(sessionID)
    if (blocks.length === 0) {
        api.ui.toast({ variant: "info", message: "No compression blocks yet" })
        return
    }
    const options = blocks.map((block) => ({
        title: `b${block.blockId} ${block.topic || "(no topic)"}`,
        value: block.blockId,
        description: `${block.startId}→${block.endId} — ${statusLabel(block)}`,
    }))
    api.ui.dialog.replace(
        () => (
            <api.ui.DialogSelect
                title="Edit block summary"
                placeholder="Search blocks"
                options={options}
                onSelect={(option) => {
                    api.ui.dialog.clear()
                    void editBlockSummary(api, sessionID, option.value as number)
                }}
            />
        ),
        () => {},
    )
}

async function editMemo(api: TuiPluginApi, sessionID: string): Promise<void> {
    const original = readMemo(sessionID) ?? ""
    const filePath = join(tmpdir(), `dcp-memo-${Date.now()}.md`)
    writeFileSync(filePath, buildMemoFile(original), "utf-8")

    const editor = process.env.VISUAL || process.env.EDITOR || "vi"
    api.renderer.suspend()
    try {
        runEditor(editor, filePath)
    } finally {
        api.renderer.resume()
    }

    let edited: string
    try {
        edited = parseMemoFile(readFileSync(filePath, "utf-8"))
    } catch {
        rmSync(filePath, { force: true })
        api.ui.toast({ variant: "error", message: "Could not read the edited memo" })
        return
    }

    const trimmed = edited.trim()
    if (!trimmed) {
        rmSync(filePath, { force: true })
        api.ui.toast({ variant: "warning", message: "Edited memo is empty; nothing applied" })
        return
    }
    if (trimmed === original.trim()) {
        rmSync(filePath, { force: true })
        api.ui.toast({ variant: "info", message: "No changes to the memo" })
        return
    }

    writeFileSync(filePath, edited, "utf-8")
    try {
        await (api.client as any).session.command({
            sessionID,
            command: "dcp",
            arguments: `memo-file ${filePath}`,
        })
        api.ui.toast({ variant: "success", message: "Updated the memo" })
    } catch {
        api.ui.toast({ variant: "error", message: "Failed to apply the memo" })
    } finally {
        rmSync(filePath, { force: true })
    }
}

// --- Sidebar component ---

const BlockList = (props: { api: TuiPluginApi; session_id: string }) => {
    const skin = look(props.api.theme.current)
    const blocks = readBlocks(props.session_id)
    const [collapsed, setCollapsed] = createSignal(false)
    const totalRaw = blocks.reduce((s, b) => s + b.compressedTokens, 0)
    const totalSummary = blocks.reduce((s, b) => s + b.summaryTokens, 0)
    const isEmpty = (block: BlockInfo) => block.summaryTokens === 0

    // Eagerly start SDK message fetch so cache is warm for messages page
    if (!sdkMessagesCache.has(props.session_id)) {
        fetchAllSdkMessages(props.api, props.session_id)
    }

    return (
        <box flexDirection="column" gap={0}>
            <text onMouseDown={() => setCollapsed(!collapsed())}>
                <b>{collapsed() ? "▶" : "▼"} DCP Blocks</b>
            </text>
            <Show when={!collapsed()}>
                <text fg={skin.muted}>
                    <b fg={skin.text}>{blocks.length}</b> block{blocks.length !== 1 ? "s" : ""}
                    {blocks.length > 0 ? <> — {tokenLabel(totalRaw)} → <b fg={skin.text}>{tokenLabel(totalSummary)}</b> (est.)</> : ""}
                </text>
                <Show when={blocks.length === 0}>
                    <text fg={skin.muted}>No compression blocks yet</text>
                </Show>
                <Show when={blocks.length > 0}>
                    <For each={blocks}>
                        {(block) => {
                            const mode = block.mode ?? "range"
                            return (
                                <box flexDirection="row" gap={1} justifyContent="space-between">
                                    <box flexDirection="row" gap={1}>
                                        <text fg={ (block.active && !isEmpty(block)) ? skin.compressed : isEmpty(block) ? skin.pruned : skin.decompressed}>
                                            { isEmpty(block) ? `b${String(block.blockId).padEnd(3)}` : (<b>b{String(block.blockId).padEnd(3)}</b>) }
                                        </text>
                                        <text fg={skin.muted}>
                                            {tokenLabel(block.compressedTokens)}→{tokenLabel(block.summaryTokens)} {mode !== "range" ? `${mode[0]}:` : ""}{block.startId}-{block.endId}
                                        </text>
                                    </box>
                                    {block.topic ? <text fg={skin.muted}>{truncateText(block.topic, 10)}</text> : null}
                                </box>)
                        }}
                    </For>
                </Show>
            </Show>
            <box flexDirection="row" gap={1}>
                <text bold inverse onMouseDown={async () => {
                    await fetchAllSdkMessages(props.api, props.session_id)
                    api.route.navigate("dcp-messages", { sessionID: props.session_id })
                }} onDblClick={async () => {
                    await fetchAllSdkMessages(props.api, props.session_id)
                    api.route.navigate("dcp-messages", { sessionID: props.session_id })
                }}> Messages </text>
            </box>
        </box>
    )
}

// --- Basic page wrapper ---

function PageHeader(props: { api: TuiPluginApi; title: string; backTarget?: string; backParams?: Record<string, unknown> }) {
    const skin = look(props.api.theme.current)
    const backLabel = !props.backTarget || props.backTarget === "home" ? "Session" : props.backTarget === "dcp-blocks" ? "Blocks" : "Back"

    return (
        <box flexDirection="row" gap={1}>
            <box onMouseDown={() => goBack(props.api, props.backTarget ?? "home", props.backParams)}>
                <text fg={skin.text} bold inverse> ← {backLabel} </text>
            </box>
            <text>
                <b>{props.title}</b>
            </text>
        </box>
    )
}

function PageShell(props: { api: TuiPluginApi; title: string; children: any; backTarget?: string; backParams?: Record<string, unknown> }) {
    const skin = look(props.api.theme.current)

    return (
        <box flexDirection="column" gap={1} padding={1}>
            <PageHeader api={props.api} title={props.title} backTarget={props.backTarget} backParams={props.backParams} />
            <text fg={skin.muted}>{"─".repeat(40)}</text>
            {props.children}
        </box>
    )
}

// --- Blocks list detail page ---

const BlocksDetail = (props: { api: TuiPluginApi; params?: Record<string, unknown> }) => {
    const popMode = props.api.mode.push(DCP_MODE)
    onCleanup(popMode)
    const sessionID = props.params?.sessionID as string | undefined
    const skin = look(props.api.theme.current)
    const blocks = sessionID ? readBlocks(sessionID) : []
    const stats = sessionID ? readStats(sessionID) : null
    const totalRaw = blocks.reduce((s, b) => s + b.compressedTokens, 0)
    const totalSummary = blocks.reduce((s, b) => s + b.summaryTokens, 0)
    const isEmpty = (block: BlockInfo) => block.summaryTokens === 0

    if (!sessionID) {
        return (
            <PageShell api={props.api} title="DCP Blocks">
                <text fg={skin.muted}>No active session</text>
            </PageShell>
        )
    }

    if (blocks.length === 0) {
        return (
            <PageShell api={props.api} title="DCP Blocks">
                <text fg={skin.muted}>No compression blocks yet</text>
                {stats && (
                    <text fg={skin.muted}>All time: saved {tokenLabelPrecise(stats.totalPruneTokens)} across {stats.totalMessagesPruned} messages / {stats.totalToolsPruned} tools</text>
                )}
            </PageShell>
        )
    }

    return (
        <PageShell api={props.api} title="DCP Blocks">
            <box flexDirection="row" gap={1}>
                <text fg={skin.muted}>
                    {blocks.length} block{blocks.length !== 1 ? "s" : ""} — {tokenLabelPrecise(totalRaw)} raw → {tokenLabelPrecise(totalSummary)} summary
                </text>
                {stats ? <text fg={skin.muted}> | saved {tokenLabelPrecise(stats.totalPruneTokens)}</text> : null}
            </box>
            <text fg={skin.muted}>{"─".repeat(40)}</text>
            {blocks.map((block) => {
                const mode = block.mode ?? "range"
                const topic = block.topic || null
                const clr = block.active && !isEmpty(block) ? skin.compressed : isEmpty(block) ? skin.pruned : skin.decompressed
                return (
                    <box key={block.blockId} flexDirection="row" gap={1} onMouseDown={() => {
                        log(props.api, `blocks: navigate to dcp-block blockId=${block.blockId}`)
                        props.api.route.navigate("dcp-block", { sessionID, blockId: block.blockId })
                    }}>
                        <text fg={clr} bold>b{String(block.blockId).padEnd(3)}</text>
                        <text fg={skin.muted}>
                            ({tokenLabelPrecise(block.compressedTokens).padStart(5)}→{tokenLabelPrecise(block.summaryTokens).padStart(5)}) {mode.padEnd(7)} {statusLabel(block).padEnd(12)} {block.startId}→{block.endId}
                            {topic ? <b> | {topic}</b> : ""}
                        </text>
                    </box>
                )
            })}
        </PageShell>
    )
}

// --- Individual block detail page ---

const BlockDetail = (props: { api: TuiPluginApi; params?: Record<string, unknown> }) => {
    const popMode = props.api.mode.push(DCP_BLOCK_MODE)
    onCleanup(popMode)
    const sessionID = props.params?.sessionID as string | undefined
    const blockId = props.params?.blockId as number | undefined
    const skin = look(props.api.theme.current)
    const block = sessionID && blockId ? readSingleBlock(sessionID, blockId) : null
    const [selectedVersion, setSelectedVersion] = createSignal<number | null>(null)

    return (
        <PageShell
            api={props.api}
            title="Block Detail"
            backTarget={sessionID ? "dcp-blocks" : undefined}
            backParams={sessionID ? { sessionID } : undefined}
        >
            <Show when={sessionID} fallback={<text fg={skin.muted}>No active session</text>}>
                <Show when={block} fallback={<text fg={skin.muted}>Block b{blockId} not found</text>}>
                    {(b) => {
                        const mode = b().mode ?? "range"
                        const versionCount = b().summaryVersions.length + 2
                        const shownVersion = () => selectedVersion() ?? b().activeVersionIndex
                        const versionText = (idx: number): string => {
                            if (idx === 0) return "(disabled)"
                            if (idx >= 2) {
                                const text = b().summaryVersions[idx - 2]
                                return typeof text === "string" && text.length > 0 ? text : "(empty)"
                            }
                            return b().summary || "(empty)"
                        }
                        return (
                            <>
                                <text fg={skin.text}><b>b{b().blockId} — {b().topic || "(no topic)"}</b></text>
                                <box flexDirection="row" gap={1}>
                                    <text fg={skin.muted}>Versions:</text>
                                    <For each={Array.from({ length: versionCount }, (_, i) => i)}>
                                        {(idx) => {
                                            const isActive = () => idx === b().activeVersionIndex
                                            const isShown = () => idx === shownVersion()
                                            return (
                                                <text
                                                    fg={isShown() ? skin.text : skin.muted}
                                                    onMouseDown={() => setSelectedVersion(idx)}
                                                >
                                                    <Show when={isShown()} fallback={<>{`${isActive() ? "*" : ""}v${idx}`}</>}>
                                                        <b inverse>{`[${isActive() ? "*" : ""}v${idx}]`}</b>
                                                    </Show>
                                                </text>
                                            )
                                        }}
                                    </For>
                                </box>
                                <text fg={skin.muted}>
                                    {b().startId}→{b().endId} | {mode} | {statusLabel(b())} | {tokenLabelPrecise(b().compressedTokens)}→{tokenLabelPrecise(b().summaryTokens)}
                                    {b().durationMs ? ` | ${b().durationMs}ms` : ""}
                                    {b().parentBlockIds.length > 0 ? ` | parents: b${b().parentBlockIds.join(" b")}` : ""}
                                    {b().includedBlockIds.length > 0 ? ` | includes: b${b().includedBlockIds.join(" b")}` : ""}
                                    {b().batchTopic ? ` | batch: ${b().batchTopic}` : ""}
                                </text>
                                <text fg={skin.muted}>{"─".repeat(40)}</text>
                                <text fg={skin.text}>{versionText(shownVersion())}</text>
                            </>
                        )
                    }}
                </Show>
            </Show>
        </PageShell>
    )
}

// --- Messages detail page ---

const TRUNCATE_LENGTH = 80

function toolPreview(part: any): string {
    const toolName = part.tool || part.name || "tool"
    const input = part.state?.input || part.input

    if ((toolName === "read" || toolName === "edit" || toolName === "write") && input?.filePath) {
        return `[${toolName} ${input.filePath}]`
    }
    if (toolName === "bash" && input?.command) {
        const cmd = String(input.command).replace(/\s+/g, " ").trim()
        if (cmd.length > 50) return `[bash ${cmd.slice(0, 47)}...]`
        return `[bash ${cmd}]`
    }
    return `[${toolName}]`
}

// Module-level cache for SDK messages fetched via v1 API (all messages, not just v2 projected context)
const sdkMessagesCache = new Map<string, Array<any>>()

async function fetchAllSdkMessages(api: TuiPluginApi, sessionID: string): Promise<void> {
    if (sdkMessagesCache.has(sessionID)) return
    try {
        const response = await (api.client as any).session.messages({ sessionID })
        const msgs = response?.data
        if (Array.isArray(msgs)) {
            const all = msgs.map((m: any) => ({
                id: m.info?.id,
                type: m.info?.role,
                content: m.parts,
            }))
            sdkMessagesCache.set(sessionID, all)
        }
    } catch {
        // Cache stays empty; component shows DCP-only entries
    }
}

function extractSdkMessagePreview(msg: any): string {
    if (msg.text && typeof msg.text === "string") {
        const t = msg.text.replace(/\s+/g, " ").trim()
        if (t.length > TRUNCATE_LENGTH) return t.slice(0, TRUNCATE_LENGTH) + "..."
        return t
    }
    if (msg.content && Array.isArray(msg.content)) {
        for (const part of msg.content) {
            if (part.type === "text" && part.text) {
                const t = part.text.replace(/\s+/g, " ").trim()
                if (t.length > TRUNCATE_LENGTH) return t.slice(0, TRUNCATE_LENGTH) + "..."
                return t
            }
            if (part.type === "tool") {
                return toolPreview(part)
            }
        }
    }
    if (msg.output && typeof msg.output === "string") {
        const t = msg.output.replace(/\s+/g, " ").trim()
        if (t.length > TRUNCATE_LENGTH) return t.slice(0, TRUNCATE_LENGTH) + "..."
        return t
    }
    return "(empty)"
}

const PAGE_SIZE = 20

const MessagesDetail = (props: { api: TuiPluginApi; params?: Record<string, unknown> }) => {
    const popMode = props.api.mode.push(DCP_MODE)
    onCleanup(popMode)
    const sessionID = props.params?.sessionID as string | undefined
    const skin = look(props.api.theme.current)
    const [page, setPage] = createSignal((props.params?.page as number) ?? 0)

    // Module-level cache: SDK messages (populated before navigation)
    const sdkMessages = sessionID ? sdkMessagesCache.get(sessionID) : undefined

    // If cache miss (direct navigation), start the fetch as fallback
    if (sessionID && !sdkMessages) {
        fetchAllSdkMessages(props.api, sessionID)
    }

    // DCP byMessageId as compression status lookup
    const dcpMessages = sessionID ? readMessages(sessionID) : []
    const dcpByRawId = new Map(dcpMessages.map((m) => [m.rawId, m]))

    // Build merged display entries (newest first)
    const allEntries: Array<{
        rawId: string; ref: string; tokenCount: number; activeBlockIds: number[]; role: string; preview: string
    }> = sdkMessages && sdkMessages.length > 0
        ? [...sdkMessages].reverse().map((msg: any, i: number) => {
            const dcpEntry = dcpByRawId.get(msg.id)
            return {
                rawId: msg.id,
                ref: dcpEntry?.ref ?? "?",
                tokenCount: dcpEntry?.tokenCount ?? 0,
                activeBlockIds: dcpEntry?.activeBlockIds ?? [],
                role: msg.type || "?",
                preview: extractSdkMessagePreview(msg),
            }
        })
        : [...dcpMessages].reverse().map((entry) => ({
            ...entry,
            role: "?" as string,
            preview: "(empty)" as string,
        }))

    const totalMessages = allEntries.length
    const totalPages = Math.max(1, Math.ceil(totalMessages / PAGE_SIZE))
    const pageEntries = createMemo(() => allEntries.slice(page() * PAGE_SIZE, (page() + 1) * PAGE_SIZE))

    const navTo = (newPage: number) => {
        log(props.api, `messages: navigate to page=${newPage}`)
        setPage(newPage)
    }

    if (!sessionID) {
        return (
            <PageShell api={props.api} title="DCP Messages">
                <text fg={skin.muted}>No active session</text>
            </PageShell>
        )
    }

    return (
        <PageShell api={props.api} title="DCP Messages">
            <box flexDirection="row" gap={1}>
                <text fg={skin.muted}>
                    {totalMessages} messages — page {page() + 1}/{totalPages}
                    {dcpMessages.length > totalMessages ? ` (${dcpMessages.length} tracked)` : ""}
                </text>
            </box>
            <text fg={skin.muted}>{"─".repeat(40)}</text>
            {allEntries.length === 0 ? (
                <text fg={skin.muted}>No messages in this session.</text>
            ) : pageEntries().length === 0 ? (
                <text fg={skin.muted}>Page {page() + 1} is empty.</text>
            ) : (
                pageEntries().map((entry) => {
                    const isCompressed = entry.activeBlockIds.length > 0
                    return (
                        <box key={entry.rawId} flexDirection="row" gap={1}>
                            <text fg={isCompressed ? skin.compressed : skin.text}>
                                {entry.ref} {isCompressed ? "C" : "-"} {String(entry.role).padStart(4)} {tokenLabel(entry.tokenCount).padStart(6)} {entry.preview}
                            </text>
                        </box>
                    )
                })
            )}
            {totalMessages > PAGE_SIZE ? (
                <>
                    <text fg={skin.muted}>{"─".repeat(40)}</text>
                    <box flexDirection="row" gap={1} alignItems="center">
                        {page() > 0 ? (
                                <box onMouseDown={() => navTo(page() - 1)}>
                                    <text bold inverse> ← Newer </text>
                                </box>
                            ) : null}
                            <text fg={skin.muted}>Page {page() + 1} of {totalPages}</text>
                            {page() < totalPages - 1 ? (
                                <box onMouseDown={() => navTo(page() + 1)}>
                                    <text bold inverse> Older → </text>
                                </box>
                        ) : null}
                    </box>
                </>
            ) : null}
        </PageShell>
    )
}

// --- Memo detail page ---

const MemoDetail = (props: { api: TuiPluginApi; params?: Record<string, unknown> }) => {
    const popMode = props.api.mode.push(DCP_MEMO_MODE)
    onCleanup(popMode)
    const sessionID = props.params?.sessionID as string | undefined
    const skin = look(props.api.theme.current)
    const memo = sessionID ? readMemo(sessionID) : null

    if (!sessionID) {
        return (
            <PageShell api={props.api} title="DCP Memo">
                <text fg={skin.muted}>No active session</text>
            </PageShell>
        )
    }

    return (
        <PageShell api={props.api} title="DCP Memo">
            {memo === null ? (
                <text fg={skin.muted}>No memo set</text>
            ) : (
                <>
                    <text fg={skin.muted}>{memo.length} chars</text>
                    <text fg={skin.muted}>{"─".repeat(40)}</text>
                    <text fg={skin.text}>{memo}</text>
                </>
            )}
        </PageShell>
    )
}

// --- Plugin entry ---

const tui: TuiPlugin = async (api, options, meta) => {
    api.slots.register({
        order: 350,
        slots: {
            sidebar_content(_ctx, value) {
                return <BlockList api={api} session_id={value.session_id} />
            },
        },
    })

    api.route.register([
        {
            name: "dcp-blocks",
            render: ({ params }) => <BlocksDetail api={api} params={params} />,
        },
        {
            name: "dcp-block",
            render: ({ params }) => <BlockDetail api={api} params={params} />,
        },
        {
            name: "dcp-messages",
            render: ({ params }) => <MessagesDetail api={api} params={params} />,
        },
        {
            name: "dcp-memo",
            render: ({ params }) => <MemoDetail api={api} params={params} />,
        },
    ])

    // Escape handler for DCP routes
    api.keymap.registerLayer({
        commands: [
            {
                name: "dcp-tui.blocks",
                title: "DCP Blocks",
                category: "Plugin",
                namespace: "palette",
                slashName: "dcp-tui-blocks",
                run() {
                    const sessionID = api.route.current.params?.sessionID as string | undefined
                    if (sessionID) {
                        api.route.navigate("dcp-blocks", { sessionID })
                    } else {
                        api.route.navigate("dcp-blocks")
                    }
                },
            },
            {
                name: "dcp-tui.messages",
                title: "DCP Messages",
                category: "Plugin",
                namespace: "palette",
                slashName: "dcp-tui-messages",
                async run() {
                    const sessionID = api.route.current.params?.sessionID as string | undefined
                    if (sessionID) {
                        await fetchAllSdkMessages(api, sessionID)
                        api.route.navigate("dcp-messages", { sessionID })
                    } else {
                        api.route.navigate("dcp-messages")
                    }
                },
            },
            {
                name: "dcp-tui.memo",
                title: "DCP Memo",
                category: "Plugin",
                namespace: "palette",
                slashName: "dcp-tui-memo",
                run() {
                    const sessionID = api.route.current.params?.sessionID as string | undefined
                    if (sessionID) {
                        api.route.navigate("dcp-memo", { sessionID })
                    } else {
                        api.route.navigate("dcp-memo")
                    }
                },
            },
            {
                name: "dcp-tui.edit",
                title: "DCP Edit Block Summary",
                category: "Plugin",
                namespace: "palette",
                slashName: "dcp-tui-edit",
                run() {
                    const current = api.route.current
                    const sessionID = current.params?.sessionID as string | undefined
                    const blockId = current.params?.blockId as number | undefined
                    if (!sessionID) {
                        api.ui.toast({ variant: "info", message: "No active session" })
                        return
                    }
                    if (current.name === "dcp-block" && typeof blockId === "number") {
                        void editBlockSummary(api, sessionID, blockId)
                    } else {
                        pickBlockToEdit(api, sessionID)
                    }
                },
            },
            {
                name: "dcp-tui.edit-memo",
                title: "DCP Edit Memo",
                category: "Plugin",
                namespace: "palette",
                slashName: "dcp-tui-edit-memo",
                run() {
                    const sessionID = api.route.current.params?.sessionID as string | undefined
                    if (!sessionID) {
                        api.ui.toast({ variant: "info", message: "No active session" })
                        return
                    }
                    void editMemo(api, sessionID)
                },
            },
        ],
    })

    // Global Escape binding for DCP routes — always registered, navigates to session
    api.keymap.registerLayer({
        commands: [
            {
                name: "dcp-tui.back",
                title: "Go back to session",
                category: "Plugin",
                hidden: true,
                run() {
                    const name = api.route.current.name
                    const sessionID = api.route.current.params?.sessionID as string | undefined
                    if (name === "dcp-block" && sessionID) {
                        api.route.navigate("dcp-blocks", { sessionID })
                    } else if (sessionID) {
                        api.route.navigate("session", { sessionID })
                    } else {
                        api.route.navigate("home")
                    }
                },
            },
        ],
        bindings: [{ key: "escape", cmd: "dcp-tui.back", desc: "Back" }],
    })

    api.keymap.registerLayer({
        mode: DCP_BLOCK_MODE,
        bindings: [{ key: "e", cmd: "dcp-tui.edit", desc: "Edit summary" }],
    })

    api.keymap.registerLayer({
        mode: DCP_MEMO_MODE,
        bindings: [{ key: "e", cmd: "dcp-tui.edit-memo", desc: "Edit memo" }],
    })
}

const plugin: TuiPluginModule & { id: string } = {
    id: "dcp-blocks",
    tui,
}

export default plugin
