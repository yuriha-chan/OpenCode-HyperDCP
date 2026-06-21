export const COMPRESS_RANGE = `Collapse a range in the conversation into a detailed summary.

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings... EVERYTHING that maintains context integrity. This is not a brief note - it is an authoritative record so faithful that the original conversation adds no value.

USER INTENT FIDELITY
When the compressed range includes user messages, preserve the user's intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
Directly quote user messages when they are short enough to include safely. Direct quotes are preferred when they best preserve exact meaning.

Yet be LEAN. Strip away the noise: failed attempts that led nowhere, verbose tool outputs, back-and-forth exploration. What remains should be pure signal - golden nuggets of detail that preserve full understanding with zero ambiguity.

EXPANDING EXISTING BLOCKS
When the messages continue a topic already covered by an active compressed block, use expand_block + edit_summary/append_summary + save_summary instead of creating a new block. This keeps the topic in one coherent summary.

When the conversation shifts to a NEW topic or task, create a separate block for that topic. Multiple independent topics -> multiple blocks.

BOUNDARY IDS
You specify boundaries by ID using the injected IDs visible in the conversation:

- \`mNNNN\` IDs identify raw messages
- \`bN\` IDs identify previously compressed blocks

Each message has an ID inside XML metadata tags like \`\`.
The same ID tag appears in every tool output of the message it belongs to — each unique ID identifies one complete message.
Treat these tags as boundary metadata only, not as tool result content.

Rules:

- Pick \`startId\` and \`endId\` directly from injected IDs in context.
- IDs must exist in the current visible context.
- \`startId\` must appear before \`endId\`.
- Do not invent IDs. Use only IDs that are present in context.

NO OVERLAP
Ranges must not overlap with any existing active compression block. Every message can belong to at most one active block. If a range would overlap with block bN, use expand_block + edit_summary/append_summary + save_summary to update that block instead.

BATCHING
When multiple independent ranges are ready and their boundaries do not overlap with each other or existing blocks, include all of them as separate entries in the \`content\` array of a single tool call. Each entry should have its own \`startId\`, \`endId\`, and \`summary\`.

MEMO
Call edit_memo to update the persistent memo block before or after compressing. Extract command patterns, workflow patterns, user instructions/hints, discovered constraints, tooling preferences, and any surface-form knowledge that would evaporate between sessions.
`
