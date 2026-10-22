export const REWRITE_SUMMARY = `Rewrite a compression block's summary to a shorter or focused version.

Use this tool after you have generated a rewritten version of a compression summary. The current summary is visible in the conversation context.

Summary writing rules
- Make the reusable knowledge claim stand out as a descriptive heading. Put its explanation below and supporting provenance separately, so later readers can find the knowledge without parsing its evidence. Completion reports, ticket closures, commit records, and passing-check lists are not reusable knowledge by themselves.
- Preserve explicit knowledge claims: decisions and rationale, user hints and verdicts, intended design, discoveries, constraints, and useful workarounds.
- Keep established findings distinct from hypotheses and unresolved questions, with brief provenance where useful.
- Organize for easy retrieval well into later problem-solving, with minimal attention, to help avoid repeated mistakes.
- Convert attempts and checks into reusable conclusions rather than a raw event log or checklist of actions.

Summary examples (illustrative)
Good example:
## Configuration file is loaded at startup
Editing the file does not change the running client's configuration (e.g. timeout). Need to restart the client after edits.
(loader.cpp, docs/configuration; the design is intentional per m0032 "startup-only loading should be preserved")

Bad example — it pretends to be epistemic knowledge, but is not reusable in later context:
## The Issue Ticket #455 is finished in commit e4f8321643
#455 "timeout configuration interface should show restart prompt dialogue" is duly implemented and closed. Test passed 201/201, lint & typecheck no error.

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
