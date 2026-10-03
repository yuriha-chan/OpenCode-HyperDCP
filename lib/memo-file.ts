export const MEMO_MARKER = "# --- DCP MEMO BELOW THIS LINE ---"

const MEMO_FILE_HEADER = [
    "# DCP memo",
    "# Edit the text below the marker line. The edited text is used verbatim.",
    "# Save and quit to apply. Content above the marker line is ignored.",
]

export function buildMemoFile(memo: string): string {
    return [...MEMO_FILE_HEADER, MEMO_MARKER, memo].join("\n")
}

export function parseMemoFile(content: string): string {
    const lines = content.split("\n")
    const markerIndex = lines.findIndex((line) => line.trim() === MEMO_MARKER)
    if (markerIndex === -1) {
        return content
    }
    return lines.slice(markerIndex + 1).join("\n")
}
