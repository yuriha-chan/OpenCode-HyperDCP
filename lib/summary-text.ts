import { formatBlockRef, formatMessageIdTag } from "./message-ids"

export const COMPRESSED_BLOCK_HEADER = "[Compressed conversation section]"

export function summaryDocument(text: string): string {
    const body = text
        .replace(/^\[Compressed conversation section\]\s*/, "")
        .replace(/\s*<dcp-message-id\b[^>]*>b\d+<\/dcp-message-id>\s*$/, "")
    return body === text ? text : body.trim()
}

export function wrapCompressedSummary(blockId: number, summary: string, range?: string): string {
    const attrs = range ? { range } : undefined
    const footer = formatMessageIdTag(formatBlockRef(blockId), attrs)
    const body = summaryDocument(summary).trim()
    if (body.length === 0) {
        return `${COMPRESSED_BLOCK_HEADER}\n${footer}`
    }
    return `${COMPRESSED_BLOCK_HEADER}\n${body}\n\n${footer}`
}
