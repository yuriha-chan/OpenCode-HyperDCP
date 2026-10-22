# Housekeeping functional test contract

The behavior in [the implementation plan](housekeeping-implementation-plan.md) is
specified through tools, host hooks, commands, and observable model messages.
Transaction storage, journals, snapshots, and replay helpers remain implementation
details and have no test-facing API.

## Module APIs

| Module                                | Public API exercised by tests                                                        | Observable contract                                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/housekeeping/tools.ts`           | `createEnterHousekeepingTool(ctx)`, `createLeaveHousekeepingTool(ctx)`               | Factories expose `execute({}, toolContext): Promise<string>`. Entry returns uncovered ranges and guidance; leave commits accumulated edits and returns a receipt. Invalid transitions reject. |
| `lib/housekeeping/guard.ts`           | `createToolExecuteBeforeHandler(ctx)`                                                | Returns an asynchronous host before-hook accepting `{ tool, sessionID, callID }` and `{ args }`. Permitted execution resolves; prohibited execution rejects before the executor runs.         |
| `index.ts`                            | Default plugin factory and returned `tool`, `config`, `tool.execute.before` surfaces | Registers both boundaries, keeps supported tools, removes `save_summary`, publishes primary tools, and respects host permission configuration.                                                |
| `lib/compress`                        | `createCompressRangeTool`, `createCompressMessageTool`                               | Requires entry; validates eligible sources and stages compression; context replacement and notifications occur at leave.                                                                      |
| `lib/rewrite-summary.ts`              | `createRewriteSummaryTool`                                                           | Rewrites accumulated draft versions, preserving version history and operation order.                                                                                                          |
| `lib/toggle-summary-version.ts`       | `createToggleSummaryVersionTool`                                                     | Requires entry and autotoggle; selects a valid draft version without publishing it early.                                                                                                     |
| `lib/expand-block.ts`                 | `createExpandBlockTool`, `createEditSummaryTool`, `createAppendSummaryTool`          | Accumulates range and summary edits; leave finalizes buffers without separate save or turn-boundary autosave.                                                                                 |
| `lib/set-memo.ts`, `lib/read-memo.ts` | `createEditMemoTool`, `createReadMemoTool`                                           | Surgical edits use the preceding draft; reads expose that draft during mode and committed memo outside mode.                                                                                  |
| `lib/fetch-summary-versions.ts`       | `createFetchSummaryVersionsTool`                                                     | Reports accumulated versions, active selection, pending edits, and requested full versions through text output.                                                                               |
| `lib/recall.ts`                       | `createRecallCompressedTool`                                                         | Reads ordinary source content and draft coverage, excluding completed housekeeping interiors even across straddling ranges.                                                                   |
| `lib/hooks.ts`                        | `createChatMessageTransformHandler`, `createCommandExecuteHandler`                   | Projects committed context, suppresses completed interiors, reconciles revert/unrevert, and preserves command behavior with active-mode staging.                                              |
| `lib/message-ids.ts`                  | `assignMessageRefs`                                                                  | Existing references remain stable; no allocation occurs during housekeeping or later for excluded content. Allocation counts and projected tags are observable results.                       |
| `lib/messages/uncovered.ts`           | `findUncoveredRanges`, `formatUncoveredRanges`                                       | Finds and formats eligible uncovered ranges without allocating aliases or counting suppressed content.                                                                                        |
| `lib/messages/inject`                 | `injectCompressNudges`                                                               | Outside reminders invite entry concisely; active housekeeping receives neither fresh nor anchored nudges.                                                                                     |
| `lib/prompts/store.ts`                | `PROMPT_KEYS`, `PromptStore.getRuntimePrompts()`, override loading                   | Exposes `housekeeping-guidance` and `housekeepingGuidance`; detailed instructions live in guidance and omit `save_summary`.                                                                   |
| `lib/config.ts`                       | `getInvalidConfigKeys`, `validateConfigTypes`, plugin configuration loading          | Recognizes `housekeeping.allowedTools: string[]`, uses exact exceptions, and rejects invalid types.                                                                                           |

The context passed to factories remains the existing `ToolContext`. Tool execution
uses host session, message, and call identities so retry and revert behavior can be
tested without exposing transaction identities or data structures.

## Suite ownership and scenarios

Existing behavior is specified in its existing suite:

- `compress-range.test.ts` and `compress-message.test.ts`: staging versus commit,
  protections, minimum-token boundaries, partial/atomic batch semantics, retries,
  host permission/read failures, and notification timing.
- `compression-groups.test.ts`: notification numbering across both compression
  modes in one session, grouped message decompression/recompression, and
  independent range restoration through public commands and rendered context.
- `rewrite-summary.test.ts`, `toggle-summary-version.test.ts`, and
  `expand-block.test.ts`: ordered edits, draft inspection, version boundaries,
  overlap rejection, invalid buffers, repair, command edits, and no autosave.
- `recall-compressed.test.ts`: original-message lookup, scoped/broad search,
  invalid input, accumulated coverage, and historical housekeeping exclusion.
- `hooks-permission.test.ts`: exact boundary retention, mixed message parts,
  successive transactions, part-level revert, and unrevert.
- `message-ids.test.ts` and `find-uncovered-ranges.test.ts`: allocation and
  eligibility boundaries, query purity, and later ordinary references.
- `nudge-uncovered-ranges.test.ts` and `prompts.test.ts`: concise outside nudges,
  active-mode suppression, runtime guidance registration, and overrides.
- `host-permissions.test.ts`: plugin registration, primary tools, explicit
  permissions, and removal of the standalone save tool.

`housekeeping.test.ts` covers the added lifecycle API: entry/leave errors, recursive
and concurrent entry, empty transactions, boundary-call retries, accumulated memo
reads, restart, atomic cross-tool leave, failed persistence with repair/retry,
revert recovery, default-deny execution, exact configurable exceptions, host
permission failures, nested dispatch, and configuration validation.

## Fixtures and mocks

`tests/helpers/housekeeping.ts` calls real tool factories, commands, transforms,
configuration, and persistence. It supplies host transcript messages and mocks
only high-level session APIs (`messages`, `get`, `prompt`) and the host permission
request. Tests inspect those mock calls and arguments. Guard tests also verify
that the mock host executor is not called after rejection.

`tests/helpers/storage-env.ts` establishes temporary storage before production
imports, because storage paths are captured at module initialization. Sessions
use distinct IDs, preserve real persisted data for restart tests, and clean up
afterward. The persistence-error scenario obstructs the public session-file path
with a real directory and restores it before retry; it does not mock filesystem
or transaction internals.

Assertions use returned text, rejected promises, public registry/configuration,
projected messages, reference-allocation counts, and host mock calls. They do not
assert transaction layouts or mutate draft structures to simulate operations.

## Test-first execution status

The entry/leave tools and execution guard are implemented. The full repository
suite passes all 421 tests with no failures, cancellations, skips, or pending
tests, including transaction recovery, draft inspection, tool restrictions,
history projection, references, compression grouping, trigger-specific nudges,
and entry-only candidate guidance.

The grouping suite was migrated by a test-only owner and audited before
implementation review. The audit corrected lost cross-mode coverage, assertions
against unselected source content, and reused host call identities. All six tests
in that suite pass without requiring a production change for those cases.

Run the functional suites with `node --import tsx --test` and their explicit paths,
or use `npm test` for the repository suite. Run `npm run typecheck` for production
types and Prettier on the changed files. Host execution-hook propagation and
interactive TUI behavior additionally require user-run host verification.
