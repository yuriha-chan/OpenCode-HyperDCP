export const HOUSEKEEPING_GUIDANCE = `Context maintenance is a staged transaction. Use only housekeeping tools and explicitly allowed tools until leave_housekeeping succeeds.

Summary writing rules
- Make the reusable knowledge claim stand out as a descriptive heading. Put its explanation below and supporting provenance separately, so later readers can find the knowledge without parsing its evidence. Completion reports, ticket closures, commit records, and passing-check lists are not reusable knowledge by themselves.
- Write reusable knowledge claims about decisions and rationale, user hints and verdicts, intended design, discoveries, constraints, and workarounds.
- Distinguish established findings from hypotheses and unresolved questions; add brief provenance where useful, such as a user's verdict, test result, external document, or debug code.
- Organize summaries and edits by subject for easy retrieval well into later reasoning, with minimal attention, to support problem-solving and prevent repeated mistakes.
- Convert attempts and checks into reusable conclusions rather than raw event logs or action checklists.
- Preserve essential technical details and user intent faithfully. Prefer direct quotes for short user instructions.

Summary examples (illustrative)
Good example:
## Configuration file is loaded at startup
Editing the file does not change the running client's configuration (e.g. timeout). Need to restart the client after edits.
(loader.cpp, docs/configuration; the design is intentional per m0032 "startup-only loading should be preserved")

Bad example — it pretends to be epistemic knowledge, but is not reusable in later context:
## The Issue Ticket #455 is finished in commit e4f8321643
#455 "timeout configuration interface should show restart prompt dialogue" is duly implemented and closed. Test passed 201/201, lint & typecheck no error.

MAINTENANCE WORKFLOW
1. If applicable, use edit_memo to preserve durable procedural constraints, user preferences, and working commands (including exact flags, arguments, and command order). Keep reusable procedures in the memo and task-specific findings in summaries. Use read_memo only when unsure of the memo's current state, and fetch_summary_versions only when you need existing summary text or version history. Draft inspection is not required.
2. Review the uncovered ranges, active blocks, and message priorities below. Start with older, resolved history and batch as much safely closed, stale material as possible in one pass. These lists describe availability, not a recommendation to compress everything: listed messages are not automatically safe to compress. Keep active work, unresolved questions, and exact source material needed for the next steps uncompressed. Respect protected sources.
3. Separate independent topics into distinct blocks. If a range continues an existing block's topic, use expand_block with edit_summary or append_summary instead of creating an overlapping block. Use compress for new blocks; in message mode, batch individual message summaries.
4. Compression, memo edits, summary rewrites, version changes, expansions, and summary edits remain staged until leave_housekeeping succeeds. Keep existing ordinary message references stable and do not target housekeeping interactions. An empty range list means no uncovered conversation is available; memo and existing-summary maintenance can still be useful.
5. Preserve any essential findings obtained during housekeeping in the memo or summaries before leaving. After successful leave, housekeeping's interior interactions, including reasoning and recall results, are hidden from subsequent model context. The entry boundary and leave receipt remain; entering housekeeping again does not reveal earlier hidden work.
6. Finish the entire maintenance pass before leaving. Updating the memo is only one step: continue with planned compression and complete every intended summary edit across all affected blocks. Do not leave after the memo edit, the first compression, or one block's edit while further work remains. Call leave_housekeeping once to publish all changes together.

Filesystem, shell, delegation, and unrelated tools are blocked unless their exact tool name is configured in housekeeping.allowedTools. Host permissions still apply.

Only after the full maintenance pass is complete, call leave_housekeeping to validate and publish the complete draft. Do not enter recursively. If leave fails, repair the draft and retry; ordinary work resumes only after successful leave.`
