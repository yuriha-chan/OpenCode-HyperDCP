# Hook Complexity Improvement Proposals

## Scope

Static analysis of `lib/hooks.ts` and relevant helpers it invokes. These are proposals, not implemented changes or profiling results. Preserve existing behavior, ordering, and persisted state contracts.

Nested message/part traversal is linear in total parts; do not replace necessary traversal merely because loops are nested. Target repeated collection searches instead. Map and Set complexity below assumes expected constant-time access and treats identifier lengths as bounded.

## 1. Index housekeeping history projection

**Priority: highest**

**Location:** `lib/housekeeping/history.ts:98–200`, `projectHousekeepingHistory()`; called from `lib/hooks.ts:161`.

### Existing cost

The function scans all messages and parts for every transaction. Within each part visit it searches the transaction's source parts and iterates its operation records. It also visits every position within each hidden range, including overlapping ranges.

Definitions:

- M: messages.
- P: total parts.
- T: transactions.
- S: total source-part records across transactions.
- O: total operation records across transactions.
- H: total positions visited while marking hidden ranges, counting overlap repeatedly.

Worst-case time: **O((T + 1) × (M + P) + P × (S + O) + H)**, where H can reach O(T × P).

### Proposal

1. Assign flattened part positions during one message/part traversal.
2. Build identity indexes once, using nested Maps rather than ambiguous concatenated keys:
    - Message ID → part ID → matching positions, for source and operation lookup.
    - Message ID → tool call ID → matching positions, for entry/leave lookup.
3. Resolve each transaction by iterating its source and operation records and querying those indexes, instead of rescanning the conversation.
4. Replace per-range insertion into the hidden-position Set with a difference array. For an exclusive interval `(start, end)`, increment at `start + 1` and decrement at `end`, skipping empty intervals. A prefix sum during output construction determines whether each position is hidden.
5. Remove the coordinate-string positional Map (`messageIndex:partIndex`); flattened positions and identity indexes replace its role.

Expected time with unique message/part identities: **O(M + P + T + S + O)**. Auxiliary indexing/range space: **O(P)**. If identities repeat, account for matching-occurrence processing needed to preserve behavior.

### Required behavior preservation

- Entry, leave, and source-boundary variables retain the last matching position in conversation order.
- Record boundary edits for every matching entry/leave part, not just the last match.
- A null boundary part ID is a wildcard; a non-null ID must match exactly.
- Operation matches require message ID, part ID, tool type, and call ID.
- Later transactions overwrite earlier boundary edits at the same position; within a transaction, preserve entry/leave assignment order.
- Preserve fallback range boundaries when the entry is absent.
- Hidden ranges remain exclusive of their endpoints; overlapping ranges form a union.
- Hidden parts are removed before considering boundary edits. Boundary edits apply only to completed tool parts.
- Preserve part/message order, removal of empty messages, and non-mutation of input messages and parts.

## 2. Use membership Sets during compression-block synchronization

**Priority: high**

**Location:** `lib/messages/sync.ts:74–107`, `syncCompressionBlocks()`; called from `lib/hooks.ts:159`.

The block/message association loop repeatedly searches `entry.allBlockIds` and `entry.activeBlockIds` with `.includes()`.

### Proposal

Seed temporary per-message membership Sets once from the normalized arrays. Use `.has()`/`.add()` to decide whether to append IDs, retaining arrays as the ordered output. Also initialize membership Sets for entries created during the association loop.

- Existing membership cost: **O(E × A)** worst case.
- Proposed membership cost: **O(H + E)** expected.
- Additional space: **O(H + E)** worst case.

Here E is block/message associations, A is the maximum membership-array length, and H is total existing membership entries. H in this section is independent of the hidden-range definition above.

Preserve normalization, deduplication, append order, and persisted array shape. Block sorting still costs O(B log B); token counting and coverage traversal remain separate costs.

## 3. Track the latest eligible user message during pruning

**Priority: high**

**Location:** `lib/messages/prune.ts:178–214`, `filterCompressedRanges()`; called through `prune()` at `lib/hooks.ts:212`.

Each summary injection performs `messages.indexOf(msg)` and a backward `getLastUserMessage()` search.

### Proposal

Use indexed forward traversal and maintain a reference to the latest eligible user message. A running reference is preferable to a hash table for this ordered lookup.

- Existing lookup cost: **O(M × S)** worst case, for M messages and S summary lookups, excluding part-level eligibility checks.
- Proposed traversal cost: **O(M + P)**, including eligibility checks over total parts P.
- Additional tracking space: **O(1)**.

Preserve ignored-user filtering and inclusive lookup at the current message. Update the reference from the original input even if that user message is subsequently pruned. Preserve summary and memo placement. Verify duplicate object-reference behavior before replacing `indexOf`, which currently returns the first occurrence of a repeated object.

## 4. Index pending compression-duration matching

**Priority: medium; benefit depends on pending batch size**

**Locations:** `lib/compress/timing.ts:57–74`, `applyPendingCompressionDurations()`; `lib/compress/state.ts:30–50`, `attachCompressionDuration()`. Called from `lib/hooks.ts:602`.

Each pending duration triggers a complete compression-block scan.

### Proposal

Build a temporary nested Map from compression message ID and call ID to all matching blocks. Resolve each pending duration through that index.

- Existing time: **O(K × B)**.
- Proposed expected time: **O(B + K + U)**.
- Additional space: **O(B)**.

Here K is pending durations, B is compression blocks, and U is block updates. With only one pending duration, both approaches remain O(B), and indexing can add overhead.

Preserve updating every matching block, invalid-duration rejection, update counts, and retention of unmatched pending entries. Use exact pair matching through nested Maps or an unambiguous encoding; do not introduce key collisions. Avoid a persistent index unless its lifecycle and invalidation are separately justified.

## 5. Use Sets in disabled full-tool pruning

**Priority: low; no active-path performance benefit**

**Location:** `lib/messages/prune.ts:28–71`, `pruneFullTool()`.

Replace repeated `partsToRemove.includes()` and `messagesToRemove.includes()` calls with Set membership. This reduces filtering from part-count × removal-count and message-count × removal-count searches to linear work in the input and removal collections.

Preserve removal-by-call-ID semantics and output order. The helper's invocation is commented out at line 22. Do not enable it as part of this optimization.

## Work not recommended

- Replacing the message/part traversal at `lib/hooks.ts:175–183`: it already visits each part once, plus text-processing cost.
- Replacing the reverse latest-user scan at `lib/hooks.ts:75–83` with an index solely for one lookup.
- Introducing a hash table for the four fixed internal-agent signature substring searches.
- Changing state contracts or merging hook stages whose ordering affects behavior.

## Verification before implementation acceptance

- Compare projected messages against existing behavior for completed and incomplete housekeeping transactions, absent boundaries, source-boundary fallback, overlapping ranges, ignored users, and duplicate identities.
- Check wildcard and exact part-ID matching, multiple matching blocks, transaction overwrite ordering, empty messages, and input non-mutation.
- Check ordered block-ID arrays and unmatched/invalid duration handling.
- Benchmark increasing conversation size and transaction/source/operation counts separately. Include overlapping ranges and single-duration batches to expose both scaling improvements and indexing overhead.
- Run the relevant existing tests and add targeted regression tests for changed helpers. No tests or benchmarks were run for this proposal document.
