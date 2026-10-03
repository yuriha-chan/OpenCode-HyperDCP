export const SUMMARY_MARKER = "# --- DCP SUMMARY BELOW THIS LINE ---"

const SUMMARY_FILE_HEADER = [
    "# DCP block summary",
    "# Edit the text below the marker line. The edited text is used verbatim.",
    "# Save and quit to apply. Content above the marker line is ignored.",
]

export function buildSummaryFile(summary: string): string {
    return [...SUMMARY_FILE_HEADER, SUMMARY_MARKER, summary].join("\n")
}

export function parseSummaryFile(content: string): string {
    const lines = content.split("\n")
    const markerIndex = lines.findIndex((line) => line.trim() === SUMMARY_MARKER)
    if (markerIndex === -1) {
        return content
    }
    return lines.slice(markerIndex + 1).join("\n")
}
