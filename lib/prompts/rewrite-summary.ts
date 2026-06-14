export const REWRITE_SUMMARY = `Rewrite a compression block's summary to a shorter or focused version.

Use this tool after you have generated a rewritten version of a compression summary. The current summary is visible in the conversation context.

HOW TO USE
- /dcp rewrite <n> [aspect/instruction] — the user triggers a rewrite request
- You see the current summary in context (injected via transform hook)
- You generate the rewritten version based on the instruction
- You save the result using this tool

THE FORMAT
{
  blockId: number,      // Block ID to rewrite (e.g. 1)
  summary: string       // The complete rewritten summary
}
`

export const REWRITE_FORMAT_EXTENSION = `
THE FORMAT OF REWRITE_SUMMARY
\`\`\`
{
  blockId: number,
  summary: string
}
\`\`\`
`
