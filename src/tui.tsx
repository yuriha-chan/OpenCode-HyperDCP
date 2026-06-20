/** @jsxImportSource @opentui/solid */
import "@opentui/core"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, Show, For } from "solid-js"
import { readFileSync } from "node:fs"
import { getSessionFilePath } from "../lib/paths"

interface BlockInfo {
    blockId: number
    active: boolean
    activeVersionIndex: number
    topic: string
    mode?: string
    compressedTokens: number
    summaryTokens: number
    startId: string
    endId: string
}

function estimateTokens(text: string): number {
    return Math.round(text.length / 4)
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
                mode: block.mode,
                compressedTokens: block.compressedTokens ?? 0,
                summaryTokens,
                startId: block.startId ?? "",
                endId: block.endId ?? "",
            }
        })
    } catch {
        return []
    }
}

function tokenLabel(tokens: number): string {
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}K`
    return String(tokens)
}

function ink(map: Record<string, unknown>, name: string, fallback: string): string {
    const value = map[name]
    if (typeof value === "string") return value
    return fallback
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

function log(api, message) {
    return api.client.app.log({
         service: "dcp-blocks",
         level: "info",
         message,
         extra: {}
   });
}

const BlockList = (props: { api: TuiPluginApi; session_id: string; }) => {
    log(props.api, "BlockList called");
    // XXX: The TUI does NOT trigger re-render when setBlocks is called, because solid-js instance in the non-builtin plugin differs from the OpenCode client
    const [blocks, setBlocks] = createSignal(readBlocks(props.session_id));
    const skin = look(props.api.theme.current)
    const totalRaw = blocks().reduce((s, b) => s + b.compressedTokens, 0)
    const totalSummary = blocks().reduce((s, b) => s + b.summaryTokens, 0)
    // compress is enabled, summary is disabled (the entire block is pruned from the conversation history)
    const isEmpty = (block) => (block.summaryTokens === 0);

    return (
        <box flexDirection="column" gap={0}>
            <text>
                <b>DCP Blocks</b>
            </text>
            <text fg={skin.muted}>
                <b fg={skin.text}>{blocks().length}</b> block{blocks().length !== 1 ? "s" : ""}
                {blocks().length > 0 ? <> — {tokenLabel(totalRaw)} → <b fg={skin.text}>{tokenLabel(totalSummary)}</b> (est.)</> : ""}
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
                                { isEmpty(block) ? `b${block.blockId}` : (<b>b{block.blockId}</b>) }
                            </text>
                            <text fg={skin.muted}>
                                ({tokenLabel(block.compressedTokens)}→{tokenLabel(block.summaryTokens)} tok) {mode[0]}:{block.startId}-{block.endId}
                            </text>
                        </box>
                       </box> );
                       }}
                </For>
            </Show>
        </box>
    )
}

const tui: TuiPlugin = async (api, options, meta) => {
    api.slots.register({
        order: 350,
        slots: {
            sidebar_content(_ctx, value) {
                return <BlockList api={api} session_id={value.session_id} />
            },
        },
    });
}

const plugin: TuiPluginModule & { id: string } = {
    id: "dcp-blocks",
    tui,
}

export default plugin
