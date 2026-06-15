import type { PluginConfig } from "../config"
import type { WithParts } from "../state"

const HEAD_CHARS = 500
const TAIL_CHARS = 500
const SINGLE_LINE_SNIPPET = 200

function truncateSingleLongLine(text: string): string | null {
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line && line.length > HEAD_CHARS) {
            const head = line.slice(0, SINGLE_LINE_SNIPPET)
            const tail = line.slice(-SINGLE_LINE_SNIPPET)
            return `[Note: line ${i + 1} is a single line of ${line.length.toLocaleString()} chars — truncated to show first/last ${SINGLE_LINE_SNIPPET} chars]\n${head}...\n...${tail}`
        }
    }
    return null
}

export function truncateToolOutputs(config: PluginConfig, messages: WithParts[]): number {
    const maxChars = config.compress.maxToolOutputChars
    if (!maxChars || maxChars <= 0) {
        return 0
    }

    let truncated = 0

    for (const message of messages) {
        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type !== "tool") continue
            const toolPart = part as any
            if (toolPart.state?.status !== "completed") continue
            if (typeof toolPart.state?.output !== "string") continue

            const output: string = toolPart.state.output
            if (output.length <= maxChars) continue

            const lines = output.split("\n")
            const totalBytes = Buffer.byteLength(output, "utf-8")

            const head = output.slice(0, HEAD_CHARS)
            const tail = output.slice(-TAIL_CHARS)

            const parts_: string[] = []
            parts_.push(
                `[Tool output truncated: ${totalBytes.toLocaleString()} bytes, ${lines.length.toLocaleString()} lines, ${output.length.toLocaleString()} chars]\n`,
            )
            parts_.push(head)

            const singleLineNote = truncateSingleLongLine(output)
            if (singleLineNote) {
                parts_.push("\n\n" + singleLineNote)
            }

            parts_.push("\n...\n")
            parts_.push(tail)

            toolPart.state.output = parts_.join("")
            truncated++
        }
    }

    return truncated
}
