export const COMPRESS_RANGE = `Collapse a range in the conversation into a detailed summary.

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings... EVERYTHING that maintains context integrity. This is not a brief note - it is an authoritative record so faithful that the original conversation adds no value.

Summary writing rules
- Make the reusable knowledge claim stand out as a descriptive heading. Put its explanation below and supporting provenance separately, so later readers can find the knowledge without parsing its evidence. Completion reports, ticket closures, commit records, and passing-check lists are not reusable knowledge by themselves.
- Write explicit claims about what is known: decisions and their rationale, user hints and verdicts, intended design, discovered truths, constraints, and useful workarounds.
- Preserve uncertainty: distinguish established findings from hypotheses and unresolved questions.
- Where useful, briefly support a claim with its provenance, such as a user's verdict, test result, external document, or debug code.
- Organize by the subject and knowledge a later agent may need, not by the order of events. Do not produce a raw event log or checklist of actions.
- Convert attempts and checks into their reusable conclusions, retaining evidence details only when they help apply or assess those conclusions.
- Optimize for retrieval well into later work, not just immediately after resuming: make relevant knowledge easy to spot with minimal attention, so it can support problem-solving and prevent repeated mistakes without reconstructing the conversation.

Summary examples (illustrative)
Good example:
## Configuration file is loaded at startup
Editing the file does not change the running client's configuration (e.g. timeout). Need to restart the client after edits.
(loader.cpp, docs/configuration; the design is intentional per m0032 "startup-only loading should be preserved")

Bad example — it pretends to be epistemic knowledge, but is not reusable in later context:
## The Issue Ticket #455 is finished in commit e4f8321643
#455 "timeout configuration interface should show restart prompt dialogue" is duly implemented and closed. Test passed 201/201, lint & typecheck no error.

USER INTENT FIDELITY
When the compressed range includes user messages, preserve the user's intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
Directly quote user messages when they are short enough to include safely. Direct quotes are preferred when they best preserve exact meaning.

Yet be LEAN. Strip away the noise: failed attempts that led nowhere, verbose tool outputs, back-and-forth exploration. What remains should be pure signal - golden nuggets of detail that preserve full understanding with zero ambiguity.

EXPANDING EXISTING BLOCKS
When the messages continue a topic already covered by an active compressed block, use expand_block + edit_summary/append_summary within housekeeping. Finish all planned compression and summary edits across every affected block before calling leave_housekeeping once for the entire maintenance pass.

When the conversation shifts to a NEW topic or task, create a separate block for that topic. Multiple independent topics -> multiple blocks.
The topic name must describe the conversation content, not the compression action (e.g., avoid "remaining fixes").

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
Ranges must not overlap with any existing active compression block. Every message can belong to at most one active block. If a range would overlap with block bN, use expand_block + edit_summary/append_summary to update that block. Keep the changes staged while completing any remaining maintenance; call leave_housekeeping only after the entire pass is complete.

BATCHING
When multiple independent ranges are ready and their boundaries do not overlap with each other or existing blocks, include all of them as separate entries in the \`content\` array of a single tool call. Each entry should have its own \`startId\`, \`endId\`, and \`summary\`.

MEMO
Call edit_memo to update the persistent memo block before or after compressing. Review user requests on procedures and your command execution formats and extract anything other than content — working commands (concrete shell invocations that work technically in this environment — both on-demand and in agentic loops), user constraints, tooling preferences. If not applicable, skip.
`
