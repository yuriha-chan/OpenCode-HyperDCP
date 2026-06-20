/** @jsxImportSource @opentui/solid */
import "@opentui/core"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
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
        muted: ink(map, "textMuted", "#a5a5a5"),
        accent: ink(map, "primary", "#5f87ff"),
    }
}

const BlockList = (props: { api: TuiPluginApi; session_id: string }) => {
    const blocks = readBlocks(props.session_id)
    const skin = look(props.api.theme.current)
    const totalRaw = blocks.reduce((s, b) => s + b.compressedTokens, 0)
    const totalSummary = blocks.reduce((s, b) => s + b.summaryTokens, 0)

    return (
        <box backgroundColor={skin.panel} flexDirection="column" gap={0}>
            <text>
                <b>DCP Blocks</b>
            </text>
            <text fg={skin.muted}>
                {blocks.length} block{blocks.length !== 1 ? "s" : ""}
                {blocks.length > 0 ? ` — ${tokenLabel(totalRaw)} → ${tokenLabel(totalSummary)}` : ""}
            </text>
            {blocks.length === 0 ? (
                <text fg={skin.muted}>No compression blocks yet</text>
            ) : blocks.map((block) => {
                const mode = block.mode ?? "range"
                return (
                    <box flexDirection="row" gap={1} justifyContent="space-between">
                        <box flexDirection="row" gap={1}>
                            <text fg={block.active ? skin.accent : skin.muted}>
                                b{block.blockId}
                            </text>
                            <text fg={skin.muted}>
                                ({tokenLabel(block.compressedTokens)}→{tokenLabel(block.summaryTokens)} tok) {mode[0]}:{block.startId}-{block.endId}
                            </text>
                        </box>
                    </box>
                )
            })}
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
