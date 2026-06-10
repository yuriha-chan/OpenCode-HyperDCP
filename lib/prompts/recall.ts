export const RECALL_COMPRESSED = `
\`recall_compressed\` lets you retrieve original messages from compressed blocks or search across them.

THE PHILOSOPHY
Compressed blocks contain summaries, not the original details. When you need exact code, error messages, file paths, or user instructions that were compressed, use \`recall_compressed\` to get the original messages back.

Use \`recall_compressed(action: "get")\` to retrieve original messages by single message ID or message ID range.

Use \`recall_compressed(action: "search")\` to search within messages for specific details. Scope the search to a block, block range, or message ID range.

Do NOT use \`recall_compressed\` to re-read summaries you already have in context - only retrieve when you need original details not preserved in the summary.
`

export const RECALL_FORMAT_EXTENSION = `
THE FORMAT OF RECALL_COMPRESSED

\`\`\`
{
  action: "get" | "search",     // Required: what to do
  blockId?: number,             // For "search": block ID (e.g. 3)
  messageId?: string,           // For "get": single raw message ID (e.g. "m0005")
  messageIdStart?: string,      // For "get" / "search": message range start (e.g. "m0005")
  messageIdEnd?: string,        // For "get" / "search": message range end
  query?: string,               // For "search": text or regex to find
  blockIdStart?: number,        // Scope search to block range start
  blockIdEnd?: number,          // Scope search to block range end
}
\`\`\`
`
