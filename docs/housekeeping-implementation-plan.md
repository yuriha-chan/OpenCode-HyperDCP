# Housekeeping implementation plan

## Objective

Introduce `enter_housekeeping` and `leave_housekeeping` as agent tools that bracket a
transaction for context maintenance. The transaction accumulates compression,
summary, range, and memo changes, publishes them together on leave, and removes its
working conversation from subsequent model context while retaining its boundaries.

This plan follows the architecture described in `Code_Summary.md` and the existing
server, persistence, message-transform, and tool implementations.

## Behavior contract

| Area          | Required behavior                                                                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry         | `enter_housekeeping` enables mode and returns uncompressed message ranges plus housekeeping guidance. Recursive entry fails without changing the current transaction.                                                                          |
| Required mode | `compress`, `edit_memo`, `rewrite_summary`, `toggle_summary_version`, `expand_block`, `edit_summary`, and `append_summary` require an active transaction.                                                                                      |
| Staging       | Mutations accumulate in an isolated draft. Later housekeeping operations see earlier staged operations. Ordinary context pruning and committed state remain unchanged until leave.                                                             |
| Commit        | `leave_housekeeping` validates and atomically publishes all accumulated edits. It incorporates summary-buffer saving; `save_summary` is removed.                                                                                               |
| Tool access   | During mode, allow housekeeping tools and configurable tool-name exceptions only. Filesystem reads, writes, searches, and shell execution are blocked by default. An explicit exception may permit any such tool, subject to host permissions. |
| References    | Allocate and inject no `mXXXX` references during mode. Housekeeping interaction never receives references later through backfilling. Existing ordinary-message references remain usable.                                                       |
| History       | After successful leave, retain the entry call with a placeholder result and the leave call with its result. Suppress intervening content. Later entry does not reveal previous completed housekeeping content.                                 |
| Revert        | Reverting leave while keeping entry undoes the commit and restores mode with the staged edits at the surviving conversation point. Reverting entry discards that transaction's effects.                                                        |
| Memo          | `read_memo` reads the accumulated draft during mode and the committed memo outside mode.                                                                                                                                                       |
| Nudges        | Outside-mode nudges become concise invitations to enter housekeeping. Detailed ranges and maintenance instructions move to entry guidance.                                                                                                     |

Existing compression permissions, manual-mode restrictions, protected content,
subagent eligibility, and the autotoggle requirement continue to apply.

## 1. Transaction model

### Committed state and draft

Add a housekeeping coordinator under `lib/housekeeping/`. Give it explicit access
to three distinct views:

1. **Committed view:** blocks, coverage, memo, pruning indexes, and published
   statistics used by normal context rendering and existing TUI state readers.
2. **Draft view:** an isolated copy of context-maintenance state used by tools in
   the active transaction. Include block/run counters, summary buffers, expanded
   coverage, memo, and any compression strategy changes that would otherwise
   mutate committed state.
3. **Source view:** ordinary conversation content eligible at entry, identified
   by raw message/part IDs and existing stable references. Exclude housekeeping
   content and synthetic metadata. Freeze source eligibility for the transaction.

Do not replace the shared `SessionState` with a draft across asynchronous calls.
Pass an explicit operation context to mutation and inspection helpers instead.
Clone `Map`, `Set`, block arrays, and nested indexes without sharing mutable data.
Keep permissions and runtime measurements separate from reversible content state.

### Durable transaction record

Extend `lib/state/types.ts` and the persisted schema with records containing:

- Transaction ID, session identity, and entry message/part/call identity.
- Base committed revision and the source boundary/eligible source identities.
- Ordered successful operation records, including their message/part/call identity,
  normalized inputs, allocated IDs, and deterministic outcomes.
- A recoverable draft or checkpoints sufficient to reconstruct it from the base.
- Leave identity, committed revision, and the receipt for a completed transaction.
- History-suppression boundaries and transaction relationships needed for revert
  and branch reconciliation.

Use raw host identities for bookkeeping; transaction records must not require
`mXXXX` references for housekeeping calls. Preserve inactive branch records as
needed for host unrevert, while excluding them from current-branch effects.

The persisted top-level blocks and memo remain the committed view. Persisting a
draft makes it recoverable; it must not expose staged changes as committed data.

### Ordered operation semantics

Serialize entry, mutations, leave, persistence, and reconciliation per session.
Apply each mutation to a disposable draft copy, validate it, durably record its
successful outcome, and then replace the transaction's working draft. A failed
operation leaves both the prior draft and committed state intact.

Preserve invocation order for summary operations:

- Consecutive `edit_summary`/`append_summary` operations share a pending buffer.
- Before a later rewrite or version toggle on that block, materialize the buffer
  as a draft-only summary version. Then execute the later operation against the
  resulting draft. This preserves the later operation's selection of an active
  version.
- At leave, materialize remaining buffers and finalize pending expansions in the
  candidate commit. An invalid or empty summary buffer rejects leave without
  silently dropping edits.
- `fetch_summary_versions` exposes accumulated draft versions and pending buffers
  so subsequent version selections have explicit, stable targets.

Internal buffer materialization never publishes state. There is no public
`save_summary` tool or turn-boundary autosave.

Store allocated block/run IDs in operation outcomes so retry and replay do not
create duplicate blocks or renumber staged results. Treat a repeated host call
identity as a retry and return its recorded result.

## 2. Entry and leave algorithms

### `enter_housekeeping`

Implement an argument-free tool in `lib/housekeeping/tools.ts`:

1. Initialize the correct session and reconcile the current raw conversation
   branch before testing mode or taking a snapshot.
2. Enforce existing eligibility and permission rules; reject recursive entry.
3. Identify the entry call at part/call granularity. Assign any missing references
   to eligible ordinary content preceding entry before switching mode. Never
   assign a reference to the entry interaction itself.
4. Capture the base revision, eligible source view, and draft. Compute uncovered
   ranges from committed coverage using a pure, non-allocating range query.
5. Persist the active transaction and enable the tool-execution restriction as
   one coordinated transition.
6. Return guidance, range boundaries, message counts, token estimates, neighboring
   blocks where useful, and relevant protection/eligibility information. Clearly
   distinguish an empty range list from an inability to compress protected data.

Guidance describes allowed tools, staging, draft inspection, ordered summary
edits, stable existing references, blocked tools, and the requirement to leave.
Entry remains useful for memo or summary maintenance when no uncovered range
exists.

### `leave_housekeeping`

Implement an argument-free tool alongside entry:

Its description must direct the agent to finish and review the entire maintenance
pass before calling it: all intended memo updates, compression, and summary edits
across every affected block. An individual memo or summary edit must not prompt
exit while further planned work remains. This is completion guidance rather than
a requirement to perform compression when no safe compression work is needed.

1. Reconcile the branch and require an active transaction. Acquire the same
   session lock used by staged mutations and wait for preceding operations.
2. Build a candidate committed snapshot from the draft. Finalize pending buffers
   and expansion metadata; validate block relationships, coverage, version
   selections, and the base revision.
3. Prepare the completed transaction record, committed state, statistics, nudge
   changes, and a deterministic receipt containing affected block IDs, versions,
   and memo status. A transaction with no edits can leave successfully.
4. Persist the candidate state and completion record atomically. Only then publish
   the in-memory committed view and leave mode.
5. Emit commit notifications and return the recorded receipt. Notification failure
   must not cause the already-persisted transaction to be applied again.

On validation or persistence failure, retain active mode and the accumulated
draft, return an actionable error, and keep committed context unchanged. Failed
leave attempts remain inside the transaction; only successful leave closes it.

### Persistence guarantees

`saveSessionState` currently logs write errors and does not propagate them. Add a
strict persistence path for transaction transitions with serialized writes,
temporary-file replacement, and errors delivered to the caller. Coordinate other
session saves with that writer so stale saves cannot overwrite a commit.

Persist committed data and transaction status in the same atomic snapshot. On
restart, load either the prior active draft or the completed commit, then reconcile
against raw call identities. A crash after durable commit but before returning the
receipt must recover the committed result without applying operations twice.

## 3. Tool registration and execution restrictions

### Registration

In `index.ts`, register entry/leave, remove `save_summary`, and adjust primary-tool
registration and default permissions. Add housekeeping-mode checks inside every
mutation tool, in addition to the shared host execution guard.

The built-in allowed set during mode is:

- `leave_housekeeping`.
- `compress`, `edit_memo`, `rewrite_summary`, `toggle_summary_version`.
- `expand_block`, `edit_summary`, `append_summary`.
- `read_memo`, `fetch_summary_versions`, `recall_compressed`.

An attempted `enter_housekeeping` while active returns the specific recursive-entry
error. Inspection tools may continue working outside mode against committed state.
An outside-mode mutation fails with instructions to call `enter_housekeeping`.

### Configurable exceptions

Add `housekeeping.allowedTools: string[]`, defaulting to `[]`, to `lib/config.ts`
and `dcp.schema.json`, including validation, defaults, and merge behavior. Treat
entries as exact registered tool names, including namespaced names where relevant.
Exceptions permit execution during mode and do not bypass host permission checks
or a housekeeping mutation's own mode requirement.

Add a `tool.execute.before` handler in `lib/hooks.ts` and wire it through
`index.ts`. Check active mode at execution time. Cover filesystem, shell, MCP,
delegation, and other tools through the same default-deny rule rather than a list
of known filesystem tool names. Plugin-internal API reads and persistence remain
available to implement the transaction.

Verify how the installed host propagates a rejected before-hook and dispatches
parallel/nested tool calls. Every executed child must be checked; allowing a
wrapper must not implicitly allow its children. Mode transitions and parallel
calls must have a defined serialized order, with no tool crossing entry unchecked.

Keep an active transaction's leave path available through normal registration
refreshes. Permission changes must not silently discard its draft or commit it.

## 4. Refactor mutations and draft inspection

| Files                                                                      | Planned changes                                                                                                                                                              |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/compress/pipeline.ts`                                                 | Split source preparation, draft mutation, and commit effects. Remove allocation of references during housekeeping and immediate committed saves/notifications.               |
| `lib/compress/range.ts`, message-mode compression, `lib/compress/state.ts` | Run existing validation and compression against the draft and frozen source view. Report staged results and preserve existing protection, overlap, and minimum-token checks. |
| `lib/rewrite-summary.ts`, `lib/toggle-summary-version.ts`                  | Operate on accumulated draft versions and preserve existing validation, including autotoggle.                                                                                |
| `lib/expand-block.ts`                                                      | Stage ranges and editing buffers; extract internal buffer-finalization logic; remove `createSaveSummaryTool` and `autoSavePendingBuffers`.                                   |
| `lib/set-memo.ts`, `lib/read-memo.ts`                                      | Apply surgical replacements to the draft memo and read that memo while mode is active.                                                                                       |
| `lib/fetch-summary-versions.ts`                                            | Display draft versions and pending edits during mode; remove instructions to call `save_summary`.                                                                            |
| `lib/recall.ts`, `lib/compress/search.ts`                                  | Resolve draft blocks against eligible ordinary source content; exclude suppressed housekeeping parts from retrieval and compression selection.                               |

Range selection must filter content, not merely endpoints: ordinary range
boundaries can straddle an earlier housekeeping interaction. Apply the same
eligibility projection to message-mode compression, expansion, token accounting,
protection snapshots, and recall. Returning raw transcript content through recall
must not reveal completed housekeeping interiors.

Route existing command/TUI mutation entry points through the same serialized state
coordinator. During an active transaction, context-maintenance edits join its draft;
outside mode, preserve their ordinary committed behavior. Track those committed
revisions for reconciliation so reverting an earlier transaction cannot overwrite
unrelated surviving edits. Keep editor-file I/O and explicit user commands distinct
from the agent-tool execution restriction.

## 5. History projection and reference handling

### Part-level projection

Add a pure projection module, such as `lib/housekeeping/history.ts`, which takes
raw messages and reconciled transaction records. Retain the host transcript for
revert and origin checks; transform only the model-visible projection.

For a completed transaction, project:

```text
enter call → guidance → reasoning → compression/recall/edits → leave call → result
```

as:

```text
enter call → placeholder result → leave call → commit result
```

Remove intervening reasoning, text, calls, and results, including configurable
exception-tool interactions. Preserve paired call/results and unrelated parts
outside the boundaries even when a host message contains both. Do not drop a whole
message just because one of its parts belongs to housekeeping.

Keep the current active transaction's surviving working history visible. Completed
transactions remain suppressed independently of whether another transaction is
active. Reverting a completed transaction back into active mode restores only its
own surviving working history, not older completed interiors.

Protect entry placeholders and leave receipts from generic tool-output pruning,
truncation, deduplication, and compression selection. Treat them as control content,
not ordinary compression targets.

### Reference allocation

Centralize reference eligibility in `lib/message-ids.ts` and use it at every
allocation site, including commands and compression preparation:

- While mode is active, allocate no references and inject no reference tags.
- Never allocate references to housekeeping-only messages, control boundaries, or
  suppressed interiors after leave.
- For mixed messages, an existing ordinary reference identifies eligible ordinary
  parts only; do not inject it into housekeeping parts.
- Preserve all existing ordinary mappings and monotonic counters without reusing
  references for different content.

Make `findUncoveredRanges` in `lib/messages/uncovered.ts` a pure query. Move
reference preparation to the appropriate outside-mode lifecycle step, and ensure
range reporting cannot accidentally allocate aliases or advertise raw housekeeping
identities as targets.

## 6. Revert, unrevert, and lifecycle reconciliation

Implement reconciliation before tool execution and before model projection. Use
the current raw branch and host revert boundary, where available, rather than
inferring a revert from already-pruned or suppressed context.

| Surviving branch                                    | Result                                                                                                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry and successful leave survive                  | Keep the transaction committed; suppress its interior.                                                                                             |
| Entry survives, leave does not                      | Restore the base committed state for that transaction and reopen its draft, replaying only successful operations that survive the branch boundary. |
| Entry survives, some later staged operations do not | Rebuild the draft through the last surviving operation, including memo and summary changes.                                                        |
| Entry does not survive                              | Remove that transaction's effects and active mode from the current branch.                                                                         |
| A previously reverted branch is restored            | Recover its recorded transactions and receipts deterministically, without double application.                                                      |

Check message, part, and call identity: a message ID can survive while a particular
entry, mutation, or leave call no longer does. Keep enough checkpoints and ordered
revision history to handle multiple transactions and surviving ordinary command
edits without restoring a stale whole-session snapshot over later valid state.

`lib/messages/sync.ts` currently reconciles compression origins, not memo edits,
summary rewrites, or version toggles. Run transaction reconciliation first, then
rebuild derived compression indexes against raw origins. Hiding a compression call
from model context must not deactivate the block it created.

Integrate loading/reset logic in `lib/state/state.ts` and `lib/state/utils.ts`.
Distinguish host compaction, session switching, restart, and actual branch revert:
absence from a compacted model window is not evidence that a transaction was
reverted. Preserve transaction/suppression metadata across compaction and use
authoritative branch metadata or unfiltered session history for recovery.

## 7. Hook ordering, prompts, and nudges

Restructure the message transform around these dependencies:

1. Load session state and obtain raw branch/lifecycle information.
2. Reconcile transactions and compression origins against raw messages.
3. Classify housekeeping parts and create the ordinary source/model projections.
4. Assign ordinary references only outside mode and refresh eligible indexes.
5. Apply committed compression/memo rendering and history suppression while
   preserving current active housekeeping history and retained boundaries.
6. Inject concise outside-mode nudges and ordinary reference tags when eligible.

Remove the new-user-message call to `autoSavePendingBuffers`. A user message, model
turn ending, or a staged compression must not implicitly commit or leave mode.
Update compression timing/event handling so draft activity does not publish
committed statistics or trigger legacy saves through `message.part.updated`.

Add a housekeeping guidance prompt to `lib/prompts/`, register it in
`lib/prompts/store.ts`, and expose it through the existing prompt-preview path.
Keep the system prompt's lifecycle instruction short. For example:

> Context maintenance requires `enter_housekeeping`. Complete and review all intended
> memo updates, compression, and summary edits across every affected block before
> calling `leave_housekeeping` once to publish the whole maintenance pass and resume
> ordinary work.

Keep context-limit nudges urgent and turn/iteration nudges conditional on safely
closed material. Their shared exit instruction should be:

> Call `enter_housekeeping` for uncompressed ranges and guidance. Complete and
> review the entire maintenance pass before calling `leave_housekeeping` once to
> apply all changes.

Move detailed range lists, maintenance workflow, tool restrictions, and editing
instructions into entry guidance. Suppress both fresh and previously anchored
nudges during mode; update their anchors only with successful commit or reconciled
state changes. Do not clear them merely because a compression was staged.

Remove `save_summary` instructions from tool descriptions, compression prompts,
manual command guidance, prompt overrides/defaults, and user documentation. Loading
existing stored blocks and historical tool results must remain supported.

## 8. Implementation sequence

1. **Host integration contract:** verify execution-hook rejection, child-tool
   dispatch, call/part identities, branch/revert visibility, and compaction events
   against installed host types and focused fixtures. Record the supported
   lifecycle signals before building reconciliation around them.
2. **State and persistence:** implement typed transaction records, isolated views,
   strict atomic persistence, per-session serialization, and deterministic
   operation replay/recovery. Load sessions without housekeeping metadata normally.
3. **Mutation service:** refactor compression, summary, expansion, and memo helpers
   to operate on explicit views; add draft inspection and internal summary
   finalization; coordinate existing command/TUI mutations.
4. **Entry/leave and access policy:** add tools, registration, mode guards, host
   execution guard, exception configuration, and staged/commit receipts. Remove
   public `save_summary` and turn-boundary autosave together.
5. **History and references:** implement raw-branch reconciliation, part-level
   suppression, source eligibility, reference-allocation guards, and coverage/
   recall integration. Protect retained boundary receipts.
6. **Prompt integration:** relocate detailed guidance, simplify nudges and system
   instructions, and align descriptions, prompt previews, schema, and README.
7. **Verification:** complete the behavioral tests and repository checks below,
   then request user-run interactive checks.

## 9. Verification and acceptance criteria

Use the existing Node test runner and mocked tool/session fixtures. Cover behavior
across components rather than testing only helper implementation details.

| Scenario           | Acceptance criteria                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode lifecycle     | Entry returns guidance/ranges; recursive entry fails; leave without mode fails; empty leave succeeds.                                                                                                           |
| Required mode      | Every listed mutation rejects outside mode without changing state; inspection remains usable.                                                                                                                   |
| Accumulation       | Stage compression, rewrite, expansion, summary edits, toggle, and memo replacements in sequence; later operations see the draft and ordinary context/TUI data retain committed values.                          |
| Commit             | A single leave publishes the full draft and finalizes summary buffers/expansions; no `save_summary` registration or turn-boundary autosave remains.                                                             |
| Ordering           | Edit-then-toggle, edit-then-rewrite, rewrite-then-edit, multiple edits, and toggling a draft-created version preserve invocation order and stable version identities.                                           |
| Memo               | Consecutive replacements use accumulated text; `read_memo` reflects it during mode and committed text after leave.                                                                                              |
| Tool restriction   | Default-deny read/write/search/shell, unrelated plugin/MCP tools, and delegation; exact exceptions work while host denials remain effective; nested/parallel dispatch cannot bypass checks.                     |
| References         | No allocation, counter increment, or injected tag during mode; no later backfill of interiors; ordinary references remain stable, including mixed messages and later transactions.                              |
| Suppression        | Retain paired entry/placeholder and leave/receipt; remove reasoning, text, and intermediate tool interactions; preserve adjacent outside parts; a second entry does not expose the first interior.              |
| Source eligibility | Ranges spanning housekeeping, expansion, message-mode compression, broad recall searches, and token estimates all exclude housekeeping content.                                                                 |
| Revert             | Test before entry, within staged operations, immediately before/after leave, part-level boundaries, multiple transactions, ordinary command edits, and unrevert; restore draft memo/versions as well as blocks. |
| Failure/retry      | Mutation validation failure leaves the prior draft intact; failed leave/persistence keeps mode active; duplicate calls, interrupted writes, and restart around commit never partially apply or double-apply.    |
| Lifecycle          | Restart/session switching restores active drafts; compaction does not masquerade as revert; stale saves/events cannot overwrite a commit.                                                                       |
| Prompts            | Outside nudges contain entry instructions without detailed ranges; entry guidance contains the ranges/workflow; no nudges appear during mode.                                                                   |
| Compatibility      | Existing permission/manual/autotoggle/protection behavior is exercised; stored sessions without transaction fields load; existing TUI readers receive committed state.                                          |

Extend existing tests for compression modes, summary tools, recall, message IDs,
uncovered ranges, nudges, prompts, permissions, and command editor routes. Add
focused housekeeping transaction, history-projection, and recovery suites using
temporary session-storage directories and explicit host call/part fixtures.

For implementation verification, run `npm run typecheck`, `npm test`,
`npm run format:check`, and `npm run build`. The package does not define an ESLint
script; do not introduce a lint-tool migration as part of this feature. Ask the
user to exercise interactive enter/edit/leave, blocked and excepted tools,
revert/unrevert, restart, and TUI committed-state visibility.
