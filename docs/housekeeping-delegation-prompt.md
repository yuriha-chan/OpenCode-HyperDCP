# Common housekeeping green-phase delegation prompt

Use this prompt for each `general` subagent implementing the housekeeping feature.
The delegator supplies an assignment and file ownership after the common prompt.

## Mission and sources

Implement the assigned portion of the green phase in the shared working tree.
Read `docs/housekeeping-implementation-plan.md` and
`docs/housekeeping-test-contract.md` before editing. Read applicable `AGENTS.md`
instructions and the existing production code and functional tests for your scope.
Those documents and the user's clarifications define the behavior; satisfy the
contract rather than special-casing fixtures.

The working tree contains a partial implementation and functional tests. Earlier
passing results predate interrupted edits and are not a verified baseline. Run the
assigned suites against the current files. Expected assertion failures are
implementation work; missing imports must not replace behavioral failures.

## Required behavior

- Entry returns eligible uncovered ranges and guidance. Recursive entry rejects;
  empty transactions are valid. Retry the same host call idempotently.
- Compression, memo editing, summary rewriting/toggling, expansion, and summary
  edit/append require mode. Stage changes in isolated accumulated state. Ordinary
  context and persisted top-level data remain committed until successful leave.
- Leave validates and atomically publishes all changes, including pending summary
  buffers. Failed validation or persistence retains mode and the intact draft.
  Remove public `save_summary` and turn-boundary autosave. Preserve ordered summary
  edit/rewrite/toggle behavior.
- Memo and summary inspection see the draft while active. Recall and compression
  sources exclude housekeeping content, including interiors straddled by ordinary
  range endpoints.
- During mode, permit housekeeping tools and exact `housekeeping.allowedTools`
  exceptions only. Exceptions may include read/write/shell tools; host permissions
  still apply. Check nested dispatch children and serialize mode transitions.
- Issue no message references during mode and never backfill housekeeping content.
  Preserve stable ordinary references and eligible ordinary parts in mixed messages.
- After leave, retain the entry call with a placeholder result and the leave call
  with its receipt. Suppress intervening text, reasoning, calls, and results at part
  granularity. Subsequent entry never reveals older completed interiors.
- Reverting leave reopens the transaction and its surviving staged operations;
  reverting entry discards its effects. Support part-level revert, unrevert,
  restart, multiple transactions, and unrelated surviving command edits. Do not
  confuse compaction with revert.
- Move detailed instructions/ranges to entry guidance, simplify outside nudges,
  and suppress fresh and anchored nudges during mode.
- Preserve existing permissions, manual/subagent restrictions, protections,
  autotoggle requirements, and outside-mode user-command behavior.

## Implementation discipline

1. Implement real production behavior through the existing public APIs. Keep
   transaction internals private, explicit, typed, and consistently serialized.
2. Work on one bounded assignment only. Edit only the explicitly owned production
   files. Read neighboring files as needed; report cross-owner changes with the
   required API signature instead of editing them. Do not spawn subagents.
3. Preserve existing user work, comments, and unrelated functionality. Do not
   commit, change git configuration, or edit unrelated untracked directories.
4. Implementation agents must not edit tests, test helpers, fixtures, or the test
   contract, including adding assertions or changing setup. If a test is flawed,
   incomplete, or contradicts the agreed contract, report its path, case, observed
   behavior, and proposed correction to the delegator. Stop the affected work;
   only a separately authorized test-maintenance assignment may change tests.
   Report unavailable essential host capabilities in the same way.
5. Use high-level host APIs and existing module conventions. Avoid broad `any`,
   silent catches, shared-state swapping across awaits, and fixture-specific
   branches. Necessary persistence errors must reach the caller.
6. Follow repository tool/command rules. A failing expected assertion can be fixed
   and rerun. For an unexpected command/environment failure, apply only one obvious
   local correction; otherwise report the blocker without changing tools or package
   managers. Use Context7 when external library/API documentation is needed; report
   if that required resource is unavailable.
7. Keep the delegator informed when you discover a genuine ambiguity or blocker.
   Do not expand your scope to repair the entire feature. Return after one focused
   implementation and verification pass, with remaining integration needs listed.

## Verification

Run assigned functional suites with `node --import tsx --test` and explicit paths.
Inspect stdout/stderr, repair implementation defects, and rerun the affected tests.
Once the assigned scope passes, run its required checks. The delegator runs the
complete-feature checks: `npm test`, `npm run typecheck`, `npm run format:check`,
and `npm run build`.
There is no ESLint script; do not introduce a lint migration. Interactive UI/host
testing is user-run.

Use dedicated tools for reading and editing files. Format only intended files with
the installed Prettier. Report unrelated pre-existing formatting failures instead
of modifying unrelated work. Run `git diff --check` before handing off.

## Handoff

Return a concise report containing:

- Implemented behavior and changed files.
- Public API changes and any integration work remaining for another owner.
- Exact commands run, pass/fail counts, and relevant observed failure output.
- Unresolved defects, uncertainties, or host-verification requirements.

Do not declare completion until the assigned behavior and checks actually pass.
