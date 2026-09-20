import { writeFile, mkdir } from "fs/promises"
import { existsSync } from "fs"
import { join } from "path"
import type { DebugState } from "./state/types"

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n)
}

function pad4(n: number): string {
    if (n < 10) return `000${n}`
    if (n < 100) return `00${n}`
    if (n < 1000) return `0${n}`
    return String(n)
}

export function formatDumpTimestamp(date: Date = new Date()): string {
    const yyyy = date.getFullYear()
    const mm = pad2(date.getMonth() + 1)
    const dd = pad2(date.getDate())
    const HH = pad2(date.getHours())
    const MM = pad2(date.getMinutes())
    const SS = pad2(date.getSeconds())
    const ssss = pad4(date.getMilliseconds())
    return `${yyyy}${mm}${dd}${HH}${MM}${SS}.${ssss}`
}

export async function dumpTransformedMessages(
    debug: DebugState | undefined,
    messages: unknown,
): Promise<void> {
    if (!debug?.enabled || !debug.directory) {
        return
    }

    try {
        if (!existsSync(debug.directory)) {
            await mkdir(debug.directory, { recursive: true })
        }
        const filename = `${formatDumpTimestamp()}.json`
        const filepath = join(debug.directory, filename)
        await writeFile(filepath, JSON.stringify(messages, null, 2), "utf-8")
    } catch {
        // Swallow write errors so debug dumps never break the chat pipeline.
    }
}
