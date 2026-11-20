export interface EditorTerminal {
    suspendRenderer(): void | Promise<void>
    resumeRenderer(): void | Promise<void>
}

export async function runEditor(
    terminal: EditorTerminal,
    editor: string,
    filePath: string,
): Promise<void> {
    const parts = editor.split(/\s+/).filter(Boolean)
    await terminal.suspendRenderer()
    try {
        await new Promise<void>((resolve, reject) => {
            const child = spawn(parts[0] ?? "vi", [...parts.slice(1), filePath], {
                stdio: "inherit",
            })
            child.once("error", reject)
            child.once("exit", (code, signal) => {
                if (code === 0) resolve()
                else
                    reject(
                        new Error(
                            `Editor exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
                        ),
                    )
            })
        })
    } finally {
        await terminal.resumeRenderer()
    }
}
import { spawn } from "node:child_process"
