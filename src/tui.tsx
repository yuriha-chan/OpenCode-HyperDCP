/** @jsxImportSource @opentui/solid */
import { TextAttributes, type TextNodeOptions } from "@opentui/core"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Plugin as TuiPluginV2 } from "@opencode/plugin/tui"
import type { KeymapCommand, Route } from "@opencode/plugin/tui/context"
import { Show, For, onCleanup, createSignal, createMemo, createEffect } from "solid-js"
import { readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runEditor } from "./editor"
import { buildSummaryFile, parseSummaryFile } from "../lib/summary-file"
import { buildMemoFile, parseMemoFile } from "../lib/memo-file"
import { createV1TuiTransport, createV2TuiTransport } from "./tui-client"
import { subscribeNotificationToasts } from "../lib/notification-rpc"
import { createTuiSessionCache, type TuiSessionCache } from "./tui-cache"
import { createDcpStateReader, type BlockInfo, type TuiCacheSnapshot } from "./tui-state"
import { subscribeV1Refresh, subscribeV2Refresh } from "./tui-events"
import { clampMessagePage, retainSummaryVersion } from "./tui-presentation"

const DCP_MODE = "dcp-routes"
const DCP_BLOCK_MODE = "dcp-block"
const DCP_MEMO_MODE = "dcp-memo"
const PLUGIN_ID = "dcp-blocks"

type DcpPage = "dcp-blocks" | "dcp-block" | "dcp-messages" | "dcp-memo"

type DcpPageState = {
    page?: DcpPage
    sessionID?: string
    blockId?: number
}

interface DcpUi {
    colors(): ReturnType<typeof look>
    current(): DcpPageState
    openPage(page: DcpPage, data?: Record<string, unknown>): void
    openSession(sessionID?: string): void
    enterMode(mode: string): () => void
    notify(input: { variant: "info" | "success" | "warning" | "error"; message: string }): void
    chooseBlock(options: { title: string; value: number; description: string }[], onSelect: (id: number) => void): void
    suspendRenderer(): void | Promise<void>
    resumeRenderer(): void | Promise<void>
    sendEditCommand(sessionID: string, argumentsText: string): Promise<unknown>
    cache: TuiSessionCache
    log?(message: string): void
}

function isDcpPage(name: string): name is DcpPage {
    return name === "dcp-blocks" || name === "dcp-block" || name === "dcp-messages" || name === "dcp-memo"
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function useSessionSnapshot(ui: DcpUi, sessionID: () => string | undefined) {
    const [snapshot, setSnapshot] = createSignal<TuiCacheSnapshot>(ui.cache.get(sessionID() ?? ""))
    createEffect(() => {
        const id = sessionID()
        if (!id) {
            setSnapshot(ui.cache.get(""))
            return
        }
        setSnapshot(ui.cache.get(id))
        const stop = ui.cache.observe(id, () => setSnapshot(ui.cache.get(id)))
        onCleanup(stop)
    })
    return snapshot
}

function versionTextOf(versions: string[], idx: number): string {
    if (idx <= 0) return ""
    const text = versions[idx - 1]
    return typeof text === "string" ? text : ""
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

function goBack(ui: DcpUi, target: DcpPage | "home", params?: Record<string, unknown>) {
    if (target === "home") {
        ui.openSession(ui.current().sessionID)
    } else {
        ui.openPage(target, params)
    }
}

async function editBlockSummary(ui: DcpUi, sessionID: string, blockId: number): Promise<void> {
    await ui.cache.refreshCommitted(sessionID)
    const block = ui.cache.get(sessionID).state.blocks.find((candidate) => candidate.blockId === blockId)
    if (!block) {
        ui.notify({ variant: "error", message: `Block b${blockId} not found` })
        return
    }

    const original = versionTextOf(block.versions, block.activeVersionIndex)
    const filePath = join(tmpdir(), `dcp-summary-${blockId}-${Date.now()}.md`)
    writeFileSync(filePath, buildSummaryFile(original), "utf-8")

    const editor = process.env.VISUAL || process.env.EDITOR || "vi"
    try {
        await runEditor(ui, editor, filePath)
    } catch {
        rmSync(filePath, { force: true })
        ui.notify({ variant: "error", message: "Could not complete the summary editor" })
        return
    }

    let edited: string
    try {
        edited = parseSummaryFile(readFileSync(filePath, "utf-8"))
    } catch {
        rmSync(filePath, { force: true })
        ui.notify({ variant: "error", message: "Could not read the edited summary" })
        return
    }

    const trimmed = edited.trim()
    if (!trimmed) {
        rmSync(filePath, { force: true })
        ui.notify({ variant: "warning", message: "Edited summary is empty; nothing applied" })
        return
    }
    if (trimmed === original.trim()) {
        rmSync(filePath, { force: true })
        ui.notify({ variant: "info", message: `No changes to block b${blockId}` })
        return
    }

    writeFileSync(filePath, edited, "utf-8")
    try {
        await ui.sendEditCommand(sessionID, `edit-file ${blockId} ${filePath}`)
        await ui.cache.refreshCommitted(sessionID)
        ui.notify({ variant: "success", message: `Updated summary for block b${blockId}` })
    } catch (e) {
        ui.notify({ variant: "error", message: `Failed to apply summary for block b${blockId}` })
    } finally {
        rmSync(filePath, { force: true })
    }
}

async function pickBlockToEdit(ui: DcpUi, sessionID: string): Promise<void> {
    await ui.cache.refreshCommitted(sessionID)
    const blocks = ui.cache.get(sessionID).state.blocks
    if (blocks.length === 0) {
        ui.notify({ variant: "info", message: "No compression blocks yet" })
        return
    }
    const options = blocks.map((block) => ({
        title: `b${block.blockId} ${block.topic || "(no topic)"}`,
        value: block.blockId,
        description: `${block.startId}→${block.endId} — ${statusLabel(block)}`,
    }))
    ui.chooseBlock(options, (blockId) => {
        void editBlockSummary(ui, sessionID, blockId)
    })
}

async function editMemo(ui: DcpUi, sessionID: string): Promise<void> {
    await ui.cache.refreshCommitted(sessionID)
    const original = ui.cache.get(sessionID).state.memo ?? ""
    const filePath = join(tmpdir(), `dcp-memo-${Date.now()}.md`)
    writeFileSync(filePath, buildMemoFile(original), "utf-8")

    const editor = process.env.VISUAL || process.env.EDITOR || "vi"
    try {
        await runEditor(ui, editor, filePath)
    } catch {
        rmSync(filePath, { force: true })
        ui.notify({ variant: "error", message: "Could not complete the memo editor" })
        return
    }

    let edited: string
    try {
        edited = parseMemoFile(readFileSync(filePath, "utf-8"))
    } catch {
        rmSync(filePath, { force: true })
        ui.notify({ variant: "error", message: "Could not read the edited memo" })
        return
    }

    const trimmed = edited.trim()
    if (!trimmed) {
        rmSync(filePath, { force: true })
        ui.notify({ variant: "warning", message: "Edited memo is empty; nothing applied" })
        return
    }
    if (trimmed === original.trim()) {
        rmSync(filePath, { force: true })
        ui.notify({ variant: "info", message: "No changes to the memo" })
        return
    }

    writeFileSync(filePath, edited, "utf-8")
    try {
        await ui.sendEditCommand(sessionID, `memo-file ${filePath}`)
        await ui.cache.refreshCommitted(sessionID)
        ui.notify({ variant: "success", message: "Updated the memo" })
    } catch {
        ui.notify({ variant: "error", message: "Failed to apply the memo" })
    } finally {
        rmSync(filePath, { force: true })
    }
}

// --- Sidebar component ---

const BlockList = (props: { ui: DcpUi; session_id: string }) => {
    const skin = props.ui.colors()
    const snapshot = useSessionSnapshot(props.ui, () => props.session_id)
    const blocks = createMemo(() => snapshot().state.blocks)
    const [collapsed, setCollapsed] = createSignal(false)
    const totalRaw = createMemo(() => blocks().reduce((s, b) => s + b.compressedTokens, 0))
    const totalSummary = createMemo(() => blocks().reduce((s, b) => s + b.summaryTokens, 0))
    const isEmpty = (block: BlockInfo) => block.summaryTokens === 0

    return (
        <box flexDirection="column" gap={0}>
            <text onMouseDown={() => setCollapsed(!collapsed())}>
                <b>{collapsed() ? "▶" : "▼"} DCP Blocks</b>
            </text>
            <Show when={!collapsed()}>
                <text fg={skin.muted}>
                    <b style={{ fg: skin.text } satisfies TextNodeOptions}>{blocks().length}</b> block{blocks().length !== 1 ? "s" : ""}
                    {blocks().length > 0 ? <> — {tokenLabel(totalRaw())} → <b style={{ fg: skin.text } satisfies TextNodeOptions}>{tokenLabel(totalSummary())}</b> (est.)</> : ""}
                </text>
                <Show when={blocks().length === 0}>
                    <text fg={skin.muted}>No compression blocks yet</text>
                </Show>
                <Show when={blocks().length > 0}>
                    <For each={blocks()}>
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
                <text fg={skin.panel} bg={skin.text} attributes={TextAttributes.BOLD} onMouseDown={() => {
                    props.ui.openPage("dcp-messages", { sessionID: props.session_id })
                }}> Messages </text>
            </box>
        </box>
    )
}

// --- Basic page wrapper ---

function PageHeader(props: { ui: DcpUi; title: string; backTarget?: DcpPage | "home"; backParams?: Record<string, unknown> }) {
    const skin = props.ui.colors()
    const backLabel = !props.backTarget || props.backTarget === "home" ? "Session" : props.backTarget === "dcp-blocks" ? "Blocks" : "Back"

    return (
        <box flexDirection="row" gap={1}>
            <box onMouseDown={() => goBack(props.ui, props.backTarget ?? "home", props.backParams)}>
                <text fg={skin.panel} bg={skin.text} attributes={TextAttributes.BOLD}> ← {backLabel} </text>
            </box>
            <text>
                <b>{props.title}</b>
            </text>
        </box>
    )
}

function PageShell(props: { ui: DcpUi; title: string; children: any; backTarget?: DcpPage | "home"; backParams?: Record<string, unknown> }) {
    const skin = props.ui.colors()

    return (
        <box flexDirection="column" gap={1} padding={1}>
            <PageHeader ui={props.ui} title={props.title} backTarget={props.backTarget} backParams={props.backParams} />
            <text fg={skin.muted}>{"─".repeat(40)}</text>
            {props.children}
        </box>
    )
}

// --- Blocks list detail page ---

const BlocksDetail = (props: { ui: DcpUi; params?: Record<string, unknown> }) => {
    const popMode = props.ui.enterMode(DCP_MODE)
    onCleanup(popMode)
    const sessionID = () => props.params?.sessionID as string | undefined
    const skin = props.ui.colors()
    const snapshot = useSessionSnapshot(props.ui, sessionID)
    const blocks = createMemo(() => snapshot().state.blocks)
    const stats = createMemo(() => snapshot().state.stats)
    const totalRaw = createMemo(() => blocks().reduce((s, b) => s + b.compressedTokens, 0))
    const totalSummary = createMemo(() => blocks().reduce((s, b) => s + b.summaryTokens, 0))
    const isEmpty = (block: BlockInfo) => block.summaryTokens === 0

    return (
        <PageShell ui={props.ui} title="DCP Blocks">
            <Show when={sessionID()} fallback={<text fg={skin.muted}>No active session</text>}>
                <Show when={blocks().length > 0} fallback={
                    <>
                        <text fg={skin.muted}>No compression blocks yet</text>
                        <Show when={stats()}>
                            <text fg={skin.muted}>All time: saved {tokenLabelPrecise(stats()!.totalPruneTokens)} across {stats()!.totalMessagesPruned} messages / {stats()!.totalToolsPruned} tools</text>
                        </Show>
                    </>
                }>
                    <box flexDirection="row" gap={1}>
                        <text fg={skin.muted}>
                            {blocks().length} block{blocks().length !== 1 ? "s" : ""} — {tokenLabelPrecise(totalRaw())} raw → {tokenLabelPrecise(totalSummary())} summary
                        </text>
                        <Show when={stats()}>
                            <text fg={skin.muted}> | saved {tokenLabelPrecise(stats()!.totalPruneTokens)}</text>
                        </Show>
                    </box>
                    <text fg={skin.muted}>{"─".repeat(40)}</text>
                    <For each={blocks()}>
                        {(block) => {
                            const mode = block.mode ?? "range"
                            const topic = block.topic || null
                            const clr = block.active && !isEmpty(block) ? skin.compressed : isEmpty(block) ? skin.pruned : skin.decompressed
                            return (
                                <box flexDirection="row" gap={1} onMouseDown={() => {
                                    props.ui.log?.(`blocks: navigate to dcp-block blockId=${block.blockId}`)
                                    const id = sessionID()
                                    if (!id) return
                                    props.ui.openPage("dcp-block", { sessionID: id, blockId: block.blockId })
                                }}>
                                    <text fg={clr} attributes={TextAttributes.BOLD}>b{String(block.blockId).padEnd(3)}</text>
                                    <text fg={skin.muted}>
                                        ({tokenLabelPrecise(block.compressedTokens).padStart(5)}→{tokenLabelPrecise(block.summaryTokens).padStart(5)}) {mode.padEnd(7)} {statusLabel(block).padEnd(12)} {block.startId}→{block.endId}
                                        {topic ? <b> | {topic}</b> : ""}
                                    </text>
                                </box>
                            )
                        }}
                    </For>
                </Show>
            </Show>
        </PageShell>
    )
}

// --- Individual block detail page ---

const BlockDetail = (props: { ui: DcpUi; params?: Record<string, unknown> }) => {
    const popMode = props.ui.enterMode(DCP_BLOCK_MODE)
    onCleanup(popMode)
    const sessionID = () => props.params?.sessionID as string | undefined
    const blockId = () => props.params?.blockId as number | undefined
    const skin = props.ui.colors()
    const snapshot = useSessionSnapshot(props.ui, sessionID)
    const block = createMemo(() => {
        const id = blockId()
        return id === undefined ? null : snapshot().state.blocks.find((candidate) => candidate.blockId === id) ?? null
    })
    const [selectedVersion, setSelectedVersion] = createSignal<number | null>(null)
    let routeKey = `${sessionID() ?? ""}:${blockId() ?? ""}`
    createEffect(() => {
        const nextKey = `${sessionID() ?? ""}:${blockId() ?? ""}`
        if (nextKey === routeKey) return
        routeKey = nextKey
        setSelectedVersion(null)
    })
    createEffect(() => {
        const selected = selectedVersion()
        if (selected === null) return
        const retained = retainSummaryVersion(selected, block() ?? undefined)
        if (retained !== selected) setSelectedVersion(retained)
    })
    const readCurrent = (): BlockInfo | null => block()

    return (
        <PageShell
            ui={props.ui}
            title="Block Detail"
            backTarget={sessionID() ? "dcp-blocks" : undefined}
            backParams={sessionID() ? { sessionID: sessionID() } : undefined}
        >
            <Show when={sessionID()} fallback={<text fg={skin.muted}>No active session</text>}>
                <Show when={readCurrent()} fallback={<text fg={skin.muted}>Block b{blockId()} not found</text>}>
                    {(() => {
                        const b = () => readCurrent()!
                        const mode = () => b().mode ?? "range"
                        const versionCount = () => b().versions.length + 1
                        const shownVersion = () => selectedVersion() ?? b().activeVersionIndex
                        const versionText = (idx: number): string => {
                            if (idx === 0) return "(disabled)"
                            const text = versionTextOf(b().versions, idx)
                            return text.length > 0 ? text : "(empty)"
                        }
                        return (
                            <>
                                <text fg={skin.text}><b>b{b().blockId} — {b().topic || "(no topic)"}</b></text>
                                <box flexDirection="row" gap={1}>
                                    <text fg={skin.muted}>Versions:</text>
                                    <For each={Array.from({ length: versionCount() }, (_, i) => i)}>
                                        {(idx) => {
                                            const isActive = () => idx === b().activeVersionIndex
                                            const isShown = () => idx === shownVersion()
                                            return (
                                                <text
                                                    fg={isShown() ? skin.text : skin.muted}
                                                    onMouseDown={() => setSelectedVersion(idx)}
                                                >
                                                    <Show when={isShown()} fallback={<>{`${isActive() ? "*" : ""}v${idx}`}</>}>
                                                        <b style={{ attributes: TextAttributes.BOLD | TextAttributes.INVERSE } satisfies TextNodeOptions}>{`[${isActive() ? "*" : ""}v${idx}]`}</b>
                                                    </Show>
                                                </text>
                                            )
                                        }}
                                    </For>
                                </box>
                                <text fg={skin.muted}>
                                    {b().startId}→{b().endId} | {mode()} | {statusLabel(b())} | {tokenLabelPrecise(b().compressedTokens)}→{tokenLabelPrecise(b().summaryTokens)}
                                    {b().durationMs ? ` | ${b().durationMs}ms` : ""}
                                    {b().parentBlockIds.length > 0 ? ` | parents: b${b().parentBlockIds.join(" b")}` : ""}
                                    {b().includedBlockIds.length > 0 ? ` | includes: b${b().includedBlockIds.join(" b")}` : ""}
                                    {b().batchTopic ? ` | batch: ${b().batchTopic}` : ""}
                                </text>
                                <text fg={skin.muted}>{"─".repeat(40)}</text>
                                <text fg={skin.text}>{versionText(shownVersion())}</text>
                            </>
                        )
                    })()}
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

const MessagesDetail = (props: { ui: DcpUi; params?: Record<string, unknown> }) => {
    const popMode = props.ui.enterMode(DCP_MODE)
    onCleanup(popMode)
    const sessionID = () => props.params?.sessionID as string | undefined
    const skin = props.ui.colors()
    const snapshot = useSessionSnapshot(props.ui, sessionID)
    const [page, setPage] = createSignal((props.params?.page as number) ?? 0)

    // DCP byMessageId as compression status lookup
    const dcpMessages = createMemo(() => snapshot().state.trackedMessages)
    const dcpByRawId = createMemo(() => new Map(dcpMessages().map((m) => [m.rawId, m])))

    // Build merged display entries (newest first)
    const allEntries = createMemo<Array<{
        rawId: string; ref: string; tokenCount: number; activeBlockIds: number[]; role: string; preview: string
    }>>(() => {
        const sdkMessages = snapshot().messages
        if (sdkMessages.length > 0) {
            return [...sdkMessages].reverse().map((msg) => {
                const dcpEntry = dcpByRawId().get(msg.id)
                return {
                    rawId: msg.id,
                    ref: dcpEntry?.ref ?? "?",
                    tokenCount: dcpEntry?.tokenCount ?? 0,
                    activeBlockIds: dcpEntry?.activeBlockIds ?? [],
                    role: msg.type || "?",
                    preview: extractSdkMessagePreview(msg),
                }
            })
        }
        return [...dcpMessages()].reverse().map((entry) => ({
            ...entry,
            role: "?" as string,
            preview: "(empty)" as string,
        }))
    })

    const totalMessages = createMemo(() => allEntries().length)
    const totalPages = createMemo(() => Math.max(1, Math.ceil(totalMessages() / PAGE_SIZE)))
    const pageEntries = createMemo(() => allEntries().slice(page() * PAGE_SIZE, (page() + 1) * PAGE_SIZE))
    createEffect(() => {
        const current = page()
        const clamped = clampMessagePage(current, totalMessages(), PAGE_SIZE)
        if (clamped !== current) setPage(clamped)
    })

    const navTo = (newPage: number) => {
        props.ui.log?.(`messages: navigate to page=${newPage}`)
        setPage(newPage)
    }

    return (
        <PageShell ui={props.ui} title="DCP Messages">
            <Show when={sessionID()} fallback={<text fg={skin.muted}>No active session</text>}>
                <box flexDirection="row" gap={1}>
                    <text fg={skin.muted}>
                        {totalMessages()} messages — page {page() + 1}/{totalPages()}
                        {dcpMessages().length > totalMessages() ? ` (${dcpMessages().length} tracked)` : ""}
                    </text>
                </box>
                <text fg={skin.muted}>{"─".repeat(40)}</text>
                {allEntries().length === 0 ? (
                    <text fg={skin.muted}>No messages in this session.</text>
                ) : pageEntries().length === 0 ? (
                    <text fg={skin.muted}>Page {page() + 1} is empty.</text>
                ) : (
                    pageEntries().map((entry) => {
                        const isCompressed = entry.activeBlockIds.length > 0
                        return (
                            <box flexDirection="row" gap={1}>
                                <text fg={isCompressed ? skin.compressed : skin.text}>
                                    {entry.ref} {isCompressed ? "C" : "-"} {String(entry.role).padStart(4)} {tokenLabel(entry.tokenCount).padStart(6)} {entry.preview}
                                </text>
                            </box>
                        )
                    })
                )}
                {totalMessages() > PAGE_SIZE ? (
                    <>
                        <text fg={skin.muted}>{"─".repeat(40)}</text>
                        <box flexDirection="row" gap={1} alignItems="center">
                            {page() > 0 ? (
                                    <box onMouseDown={() => navTo(page() - 1)}>
                                        <text fg={skin.panel} bg={skin.text} attributes={TextAttributes.BOLD}> ← Newer </text>
                                    </box>
                                ) : null}
                                <text fg={skin.muted}>Page {page() + 1} of {totalPages()}</text>
                                {page() < totalPages() - 1 ? (
                                    <box onMouseDown={() => navTo(page() + 1)}>
                                        <text fg={skin.panel} bg={skin.text} attributes={TextAttributes.BOLD}> Older → </text>
                                    </box>
                            ) : null}
                        </box>
                    </>
                ) : null}
            </Show>
        </PageShell>
    )
}

// --- Memo detail page ---

const MemoDetail = (props: { ui: DcpUi; params?: Record<string, unknown> }) => {
    const popMode = props.ui.enterMode(DCP_MEMO_MODE)
    onCleanup(popMode)
    const sessionID = () => props.params?.sessionID as string | undefined
    const skin = props.ui.colors()
    const snapshot = useSessionSnapshot(props.ui, sessionID)
    const memo = createMemo(() => snapshot().state.memo)

    return (
        <PageShell ui={props.ui} title="DCP Memo">
            <Show when={sessionID()} fallback={<text fg={skin.muted}>No active session</text>}>
                <Show when={memo() !== null} fallback={<text fg={skin.muted}>No memo set</text>}>
                    <text fg={skin.muted}>{memo()!.length} chars</text>
                    <text fg={skin.muted}>{"─".repeat(40)}</text>
                    <text fg={skin.text}>{memo()!}</text>
                </Show>
            </Show>
        </PageShell>
    )
}

// --- Shared actions ---

function openBlocks(ui: DcpUi): void {
    const sessionID = ui.current().sessionID
    ui.openPage("dcp-blocks", sessionID ? { sessionID } : undefined)
}

function openMessages(ui: DcpUi): void {
    const sessionID = ui.current().sessionID
    if (sessionID) {
        ui.openPage("dcp-messages", { sessionID })
    } else {
        ui.openPage("dcp-messages")
    }
}

function openMemo(ui: DcpUi): void {
    const sessionID = ui.current().sessionID
    ui.openPage("dcp-memo", sessionID ? { sessionID } : undefined)
}

function editCurrentBlock(ui: DcpUi): void {
    const current = ui.current()
    if (!current.sessionID) {
        ui.notify({ variant: "info", message: "No active session" })
        return
    }
    if (current.page === "dcp-block" && typeof current.blockId === "number") {
        void editBlockSummary(ui, current.sessionID, current.blockId)
    } else {
        void pickBlockToEdit(ui, current.sessionID)
    }
}

function editCurrentMemo(ui: DcpUi): void {
    const sessionID = ui.current().sessionID
    if (!sessionID) {
        ui.notify({ variant: "info", message: "No active session" })
        return
    }
    void editMemo(ui, sessionID)
}

function backToSession(ui: DcpUi): void {
    const current = ui.current()
    if (current.page === "dcp-block" && current.sessionID) {
        ui.openPage("dcp-blocks", { sessionID: current.sessionID })
    } else if (current.sessionID) {
        ui.openSession(current.sessionID)
    } else {
        ui.openSession()
    }
}

// --- v1 native registration ---

const tui: TuiPlugin = async (api, options, meta) => {
    const transport = createV1TuiTransport(api.client)
    const log = (message: string) => {
        void api.client.app.log({
            service: "dcp-blocks",
            level: "info",
            message,
            extra: {},
        })
    }
    const readState = createDcpStateReader()
    const cache = createTuiSessionCache({
        readSessionMessages: (sessionID) => transport.readSessionMessages(sessionID),
        readSessionMessage: (sessionID, messageID) => transport.readSessionMessage(sessionID, messageID),
        readState,
        onError: (error) => log(`refresh error: ${formatError(error)}`),
    })
    const unsubscribeRefresh = subscribeV1Refresh(api.event, cache)
    api.lifecycle.onDispose(() => {
        unsubscribeRefresh()
        cache.dispose()
    })
    const ui: DcpUi = {
        colors: () => look(api.theme.current),
        current: () => {
            const route = api.route.current as { name: string; params?: Record<string, unknown> }
            return {
                page: isDcpPage(route.name) ? route.name : undefined,
                sessionID: typeof route.params?.sessionID === "string" ? route.params.sessionID : undefined,
                blockId: typeof route.params?.blockId === "number" ? route.params.blockId : undefined,
            }
        },
        openPage: (page, data) => api.route.navigate(page, data),
        openSession: (sessionID) => {
            if (sessionID) {
                api.route.navigate("session", { sessionID })
            } else {
                api.route.navigate("home")
            }
        },
        enterMode: (mode) => api.mode.push(mode),
        notify: (input) => api.ui.toast(input),
        chooseBlock: (options, onSelect) => {
            api.ui.dialog.replace(
                () => (
                    <api.ui.DialogSelect
                        title="Edit block summary"
                        placeholder="Search blocks"
                        options={options}
                        onSelect={(option) => {
                            api.ui.dialog.clear()
                            onSelect(option.value as number)
                        }}
                    />
                ),
                () => {},
            )
        },
        suspendRenderer: () => api.renderer.suspend(),
        resumeRenderer: () => api.renderer.resume(),
        sendEditCommand: (sessionID, argumentsText) => transport.sendEditCommand(sessionID, argumentsText),
        cache,
        log,
    }

    api.slots.register({
        order: 350,
        slots: {
            sidebar_content(_ctx, value) {
                return <BlockList ui={ui} session_id={value.session_id} />
            },
        },
    })

    api.route.register([
        {
            name: "dcp-blocks",
            render: ({ params }) => <BlocksDetail ui={ui} params={params} />,
        },
        {
            name: "dcp-block",
            render: ({ params }) => <BlockDetail ui={ui} params={params} />,
        },
        {
            name: "dcp-messages",
            render: ({ params }) => <MessagesDetail ui={ui} params={params} />,
        },
        {
            name: "dcp-memo",
            render: ({ params }) => <MemoDetail ui={ui} params={params} />,
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
                    openBlocks(ui)
                },
            },
            {
                name: "dcp-tui.messages",
                title: "DCP Messages",
                category: "Plugin",
                namespace: "palette",
                slashName: "dcp-tui-messages",
                run() {
                    openMessages(ui)
                },
            },
            {
                name: "dcp-tui.memo",
                title: "DCP Memo",
                category: "Plugin",
                namespace: "palette",
                slashName: "dcp-tui-memo",
                run() {
                    openMemo(ui)
                },
            },
            {
                name: "dcp-tui.edit",
                title: "DCP Edit Block Summary",
                category: "Plugin",
                namespace: "palette",
                slashName: "dcp-tui-edit",
                run() {
                    editCurrentBlock(ui)
                },
            },
            {
                name: "dcp-tui.edit-memo",
                title: "DCP Edit Memo",
                category: "Plugin",
                namespace: "palette",
                slashName: "dcp-tui-edit-memo",
                run() {
                    editCurrentMemo(ui)
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
                    backToSession(ui)
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

// --- v2 native registration ---

function v2PageState(route: Route): DcpPageState {
    if (route.type === "home") return {}
    if (route.type === "session") return { sessionID: route.sessionID }
    if (route.id !== PLUGIN_ID) return {}
    const data = route.data ?? {}
    return {
        page: isDcpPage(route.name) ? route.name : undefined,
        sessionID: typeof data.sessionID === "string" ? data.sessionID : undefined,
        blockId: typeof data.blockId === "number" ? data.blockId : undefined,
    }
}

function v2EditBlockCommand(ui: DcpUi, bind?: string): KeymapCommand {
    return {
        id: "dcp-tui.edit",
        title: "DCP Edit Block Summary",
        group: "Plugin",
        palette: true,
        slash: { name: "dcp-tui-edit" },
        bind,
        run: () => editCurrentBlock(ui),
    }
}

function v2EditMemoCommand(ui: DcpUi, bind?: string): KeymapCommand {
    return {
        id: "dcp-tui.edit-memo",
        title: "DCP Edit Memo",
        group: "Plugin",
        palette: true,
        slash: { name: "dcp-tui-edit-memo" },
        bind,
        run: () => editCurrentMemo(ui),
    }
}

function v2BackCommand(ui: DcpUi, bind?: string): KeymapCommand {
    return {
        id: "dcp-tui.back",
        title: "Go back to session",
        group: "Plugin",
        bind,
        run: () => backToSession(ui),
    }
}

function v2Commands(ui: DcpUi): KeymapCommand[] {
    return [
        {
            id: "dcp-tui.blocks",
            title: "DCP Blocks",
            group: "Plugin",
            palette: true,
            slash: { name: "dcp-tui-blocks" },
            run: () => openBlocks(ui),
        },
        {
            id: "dcp-tui.messages",
            title: "DCP Messages",
            group: "Plugin",
            palette: true,
            slash: { name: "dcp-tui-messages" },
            run: () => openMessages(ui),
        },
        {
            id: "dcp-tui.memo",
            title: "DCP Memo",
            group: "Plugin",
            palette: true,
            slash: { name: "dcp-tui-memo" },
            run: () => openMemo(ui),
        },
        v2EditBlockCommand(ui),
        v2EditMemoCommand(ui),
        v2BackCommand(ui),
    ]
}

const setup: TuiPluginV2.Definition["setup"] = (context) => {
    const transport = createV2TuiTransport(context.client)
    const readState = createDcpStateReader()
    const cache = createTuiSessionCache({
        readSessionMessages: (sessionID) => transport.readSessionMessages(sessionID),
        readSessionMessage: (sessionID, messageID) => transport.readSessionMessage(sessionID, messageID),
        readState,
        onError: (error) => console.error("dcp-blocks: refresh error", error),
    })
    const unsubscribeRefresh = subscribeV2Refresh(context.data, cache)
    const ui: DcpUi = {
        colors: () => look(context.theme),
        current: () => v2PageState(context.ui.router.current()),
        openPage: (page, data) => context.ui.router.navigate({ type: "plugin", name: page, data }),
        openSession: (sessionID) => context.ui.router.navigate(sessionID ? { type: "session", sessionID } : { type: "home" }),
        enterMode: (mode) => context.keymap.mode.push(mode),
        notify: (input) => context.ui.toast.show(input),
        chooseBlock: (options, onSelect) => {
            void context.ui.dialog
                .select({ title: "Edit block summary", placeholder: "Search blocks", options })
                .then((value) => {
                    if (value !== undefined) onSelect(value)
                })
        },
        suspendRenderer: () => context.renderer.suspend(),
        resumeRenderer: () => context.renderer.resume(),
        sendEditCommand: (sessionID, argumentsText) => transport.sendEditCommand(sessionID, argumentsText),
        cache,
    }

    context.ui.slot({
        append: "sidebar.content",
        render(input) {
            return <BlockList ui={ui} session_id={input.sessionID} />
        },
    })

    context.ui.router.register({
        name: "dcp-blocks",
        render: ({ data }) => <BlocksDetail ui={ui} params={data} />,
    })
    context.ui.router.register({
        name: "dcp-block",
        render: ({ data }) => <BlockDetail ui={ui} params={data} />,
    })
    context.ui.router.register({
        name: "dcp-messages",
        render: ({ data }) => <MessagesDetail ui={ui} params={data} />,
    })
    context.ui.router.register({
        name: "dcp-memo",
        render: ({ data }) => <MemoDetail ui={ui} params={data} />,
    })

    context.keymap.layer(() => ({ mode: "global", commands: v2Commands(ui) }))
    context.keymap.layer(() => ({
        mode: DCP_MODE,
        commands: [v2BackCommand(ui, "escape")],
    }))
    context.keymap.layer(() => ({
        mode: DCP_BLOCK_MODE,
        commands: [v2EditBlockCommand(ui, "e"), v2BackCommand(ui, "escape")],
    }))
    context.keymap.layer(() => ({
        mode: DCP_MEMO_MODE,
        commands: [v2EditMemoCommand(ui, "e"), v2BackCommand(ui, "escape")],
    }))

    const unsubscribeToasts = context.location
        ? subscribeNotificationToasts(context.client, context.location, (toast) => {
            context.ui.toast.show(toast)
        })
        : undefined

    return () => {
        unsubscribeToasts?.()
        unsubscribeRefresh()
        cache.dispose()
    }
}

const plugin: TuiPluginModule & TuiPluginV2.Definition = {
    id: PLUGIN_ID,
    tui,
    setup,
}

export default plugin
