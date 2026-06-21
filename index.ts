import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config"
import { createCompressMessageTool, createCompressRangeTool } from "./lib/compress"
import { createRecallCompressedTool } from "./lib/recall"
import { createRewriteSummaryTool } from "./lib/rewrite-summary"
import {
    createExpandBlockTool,
    createEditSummaryTool,
    createAppendSummaryTool,
    createSaveSummaryTool,
    autoSavePendingBuffers,
} from "./lib/expand-block"
import {
    compressDisabledByOpencode,
    hasExplicitToolPermission,
    type HostPermissionSnapshot,
} from "./lib/host-permissions"
import { Logger } from "./lib/logger"
import { createSessionState } from "./lib/state"
import { PromptStore } from "./lib/prompts/store"
import {
    createChatMessageTransformHandler,
    createCommandExecuteHandler,
    createEventHandler,
    createSystemPromptHandler,
    createTextCompleteHandler,
} from "./lib/hooks"
import { configureClientAuth, isSecureMode } from "./lib/auth"
import { createEditMemoTool } from "./lib/set-memo"
import { createReadMemoTool } from "./lib/read-memo"
import { createFetchSummaryVersionsTool } from "./lib/fetch-summary-versions"
import { startAutoUpdate } from "./lib/update"

const server: Plugin = (async (ctx) => {
    const config = getConfig(ctx)

    if (!config.enabled) {
        return {}
    }

    const logger = new Logger(config.debug)
    const state = createSessionState()
    const prompts = new PromptStore(logger, ctx.directory, config.experimental.customPrompts)
    const hostPermissions: HostPermissionSnapshot = {
        global: undefined,
        agents: {},
    }

    if (isSecureMode()) {
        configureClientAuth(ctx.client)
        // logger.info("Secure mode detected, configured client authentication")
    }

    logger.info("DCP initialized", {
        strategies: config.strategies,
    })

    startAutoUpdate(ctx, config.autoUpdate)

    const compressToolContext = {
        client: ctx.client,
        state,
        logger,
        config,
        prompts,
    }

    return {
        "experimental.chat.system.transform": createSystemPromptHandler(
            state,
            logger,
            config,
            prompts,
        ),
        "experimental.chat.messages.transform": createChatMessageTransformHandler(
            ctx.client,
            state,
            logger,
            config,
            prompts,
            hostPermissions,
        ) as any,
        "experimental.text.complete": createTextCompleteHandler(),
        "command.execute.before": createCommandExecuteHandler(
            ctx.client,
            state,
            logger,
            config,
            ctx.directory,
            hostPermissions,
        ),
        event: createEventHandler(state, logger),
        tool: {
            ...(config.compress.permission !== "deny" && {
                compress:
                    config.compress.mode === "message"
                        ? createCompressMessageTool(compressToolContext)
                        : createCompressRangeTool(compressToolContext),
                recall_compressed: createRecallCompressedTool(compressToolContext),
                rewrite_summary: createRewriteSummaryTool(compressToolContext),
                expand_block: createExpandBlockTool(compressToolContext),
                edit_summary: createEditSummaryTool(compressToolContext),
                append_summary: createAppendSummaryTool(compressToolContext),
                save_summary: createSaveSummaryTool(compressToolContext),
                fetch_summary_versions: createFetchSummaryVersionsTool(compressToolContext),
                edit_memo: createEditMemoTool(compressToolContext),
                read_memo: createReadMemoTool(compressToolContext),
            }),
        },
        config: async (opencodeConfig) => {
            if (
                config.compress.permission !== "deny" &&
                compressDisabledByOpencode(opencodeConfig.permission)
            ) {
                config.compress.permission = "deny"
            }

            if (config.commands.enabled && config.compress.permission !== "deny") {
                opencodeConfig.command ??= {}
                opencodeConfig.command["dcp"] = {
                    template: "",
                    description: "Show available DCP commands",
                }
            }

            const toolsToAdd: string[] = []
            if (config.compress.permission !== "deny" && !config.experimental.allowSubAgents) {
                toolsToAdd.push("compress")
                toolsToAdd.push("recall_compressed")
                toolsToAdd.push("rewrite_summary")
                toolsToAdd.push("expand_block")
                toolsToAdd.push("edit_summary")
                toolsToAdd.push("append_summary")
                toolsToAdd.push("save_summary")
                toolsToAdd.push("fetch_summary_versions")
                toolsToAdd.push("edit_memo")
                toolsToAdd.push("read_memo")
            }

            if (toolsToAdd.length > 0) {
                const existingPrimaryTools = opencodeConfig.experimental?.primary_tools ?? []
                opencodeConfig.experimental = {
                    ...opencodeConfig.experimental,
                    primary_tools: [...existingPrimaryTools, ...toolsToAdd],
                }
            }

            if (!hasExplicitToolPermission(opencodeConfig.permission, "compress")) {
                const permission = opencodeConfig.permission ?? {}
                opencodeConfig.permission = {
                    ...permission,
                    compress: config.compress.permission,
                } as typeof permission
            }

            if (!hasExplicitToolPermission(opencodeConfig.permission, "recall_compressed")) {
                const permission = opencodeConfig.permission ?? {}
                opencodeConfig.permission = {
                    ...permission,
                    recall_compressed: "allow",
                } as typeof permission
            }

            if (!hasExplicitToolPermission(opencodeConfig.permission, "rewrite_summary")) {
                const permission = opencodeConfig.permission ?? {}
                opencodeConfig.permission = {
                    ...permission,
                    rewrite_summary: "allow",
                } as typeof permission
            }

            const expandTools = ["expand_block", "edit_summary", "append_summary", "save_summary", "fetch_summary_versions"]
            for (const toolName of expandTools) {
                if (!hasExplicitToolPermission(opencodeConfig.permission, toolName)) {
                    const permission = opencodeConfig.permission ?? {}
                    opencodeConfig.permission = {
                        ...permission,
                        [toolName]: "allow",
                    } as typeof permission
                }
            }

            if (!hasExplicitToolPermission(opencodeConfig.permission, "edit_memo")) {
                const permission = opencodeConfig.permission ?? {}
                opencodeConfig.permission = {
                    ...permission,
                    edit_memo: "allow",
                } as typeof permission
            }

            if (!hasExplicitToolPermission(opencodeConfig.permission, "read_memo")) {
                const permission = opencodeConfig.permission ?? {}
                opencodeConfig.permission = {
                    ...permission,
                    read_memo: "allow",
                } as typeof permission
            }

            hostPermissions.global = opencodeConfig.permission
            hostPermissions.agents = Object.fromEntries(
                Object.entries(opencodeConfig.agent ?? {}).map(([name, agent]) => [
                    name,
                    agent?.permission,
                ]),
            )
        },
    }
}) satisfies Plugin

export default server
