# Changelog

All notable changes to OpenCode-HyperDCP are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [100.0.0]

First public release of the HyperDCP fork of
[opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning).
The fork point is upstream v3.1.12 (`0657cd2`); the version jumps to `100.0.0` to mark
divergence from upstream versioning and is published under a new package identity
(`@architectural-composition/opencode-hyperdcp`, renamed from `@tarquinen/opencode-dcp`).

### Philosophy

HyperDCP makes the OpenCode context window observable and controllable: every
compression is a visible, reviewable block, and nothing is discarded without a
deliberate decision.

### Added

- **Message review and manual control**: `/dcp view` (list and per-block detail with
  message ranges `startId→endId`) and `/dcp edit` commands; manual message protection
  via `/dcp protect` and `/dcp unprotect`, plus a `/dcp messages` review command.
- **Dynamic recall tool** (`recall_compressed`): search and retrieve the original
  messages folded into any compressed block.
- **Block revision toolkit**: `rewrite_summary` tool plus `/dcp rewrite` and
  `/dcp toggle` commands; `expand_block`, `edit_summary`, `append_summary`, and
  `save_summary` tools with auto-save of the pending edit buffer at turn end.
  A version scheme (`0`=disabled, `1`=original, `2+`=rewrites) backs this.
- **`fetch_summary_versions` tool** to inspect a block's individual summary versions.
- **`toggle_summary_version` tool and `/dcp autotoggle` command**, letting the agent
  switch or cull summary versions when enabled. Autotoggle state persists per session.
- **Persistent memo** (not present upstream): a session memo block placed after the
  last compression block, with the `edit_memo` and `read_memo` tools and the
  `/dcp memo` command, later editable via `$EDITOR`.
- **Size-based tool output pruning** (`compress.maxToolOutputChars`) to truncate
  oversized tool outputs before compression.
- **Protected tools configuration** (`compress.protectedTools`,
  `commands.protectedTools`) with rich per-consumer rules (`protect`, `truncateSize`,
  `truncateDirection`, `keepLast`).
- **`minCompressTokens` config** (default 2000, 0 disables).
- **Uncovered range detection**, injected into nudges and manual triggers so messages
  not covered by any active block are surfaced.
- **TUI sidebar** (new `src/tui.tsx`, plugin id `dcp-blocks`): a collapsible
  `DCP Blocks` sidebar mounted in the `sidebar_content` slot showing each block with
  its range, mode, active version, token cost, and topic.
- **TUI pages**: block detail with per-version tabs, messages view, and an editable
  memo view; `/dcp-tui-blocks`, `/dcp-tui-messages`, and `/dcp-tui-memo` palette
  commands.
- **Block summary editing in `$EDITOR`** via a visudo-style temp-file handoff
  (`/dcp edit-file`) with automatic on-screen refresh after an edit.
- **Memo editing in `$EDITOR`** via `/dcp memo-file`.
- **Debug dumps**: `/dcp debug on <dir>` writes each post-transform LLM query to
  `<dir>/YYYYMMDDHHMMSS.SSSS.json`; `/dcp debug off` stops it.
- **PTY-driven TUI capture harness** under `scripts/` with Playwright-style scenarios
  and PNG screenshots, used to generate the README images.

### Changed

- Package renamed to `@architectural-composition/opencode-hyperdcp`; new description and keywords;
  `docs/screenshots/` now ships in the npm tarball.
- Compression blocks are filtered to the active conversation branch.
- Block metadata (`startId`, `endId`, `topic`, `mode`) is injected as XML attributes;
  the `range='...'` block tag is compacted.
- Nudges fire based on non-compressed token counts.
- Message refs are persisted every turn when new messages appear; unknown refs render
  as `?` instead of being guessed.
- The compress prompts require a topic that reflects actual conversation content.
- `set_memo` was removed in favour of `edit_memo` for surgical memo updates.
- Removed block-consuming logic and the `(bN)` placeholder inlining; added
  no-overlap enforcement for compression ranges.
- Rewrote the README around the plugin's philosophy with screenshots.

### Fixed

- Uncovered range `endId` tracking and adjacent-block reporting.
- Block expansion overlap checks.
- `compressedTokens=0` for batched ranges; token count displays in `/dcp view`.
- `resetOnCompaction` summary safety when persisting message ids.
- Messages-list preview and compression-flag display.

### Removed

- `set_memo` tool (replaced by `edit_memo`).
- Recall-by-blockId as a bulk operation (superseded by targeted `recall_compressed`).

[100.0.0]: https://github.com/yuriha-chan/OpenCode-HyperDCP/releases/tag/v100.0.0
