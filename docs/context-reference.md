# Context controls reference

For guided learning, use [Quick start: make and inspect your first block](../README.md#quick-start-make-and-inspect-your-first-block).
For task instructions, see [Work with compressed context](context-tasks.md).
For the model behind these controls, see [Observable summary blocks (DCP blocks)](../README.md#observable-summary-blocks-dcp-blocks).

## Blocks and summary versions

Message references such as `m0005` identify source messages. Block references
such as `b3` identify compressed ranges. A block has a topic, boundaries, a
compression mode, token counts, and a selected summary version.

| Selection                     | What represents an active compressed range in context |
| ----------------------------- | ----------------------------------------------------- |
| Summary version `1`           | The original summary                                  |
| Summary version `2` or higher | A saved rewrite or edit                               |
| Summary version `0` (culled)  | No summary; the covered source messages remain pruned |
| User-decompressed             | The original messages instead of that compression     |

Selecting a tab in the TUI is view-only. The `*` indicates the active summary
version. A saved version and a block's active/decompressed state are distinct:
changing a version is not a substitute for `/dcp recompress` after user
decompression.

The default compression mode is `range`. The `message` mode is also supported;
commands that operate on compression targets can group blocks from the same
message-mode compression run. Use the target IDs displayed by the command's
listing.

## Commands and TUI controls

Enter `/dcp` commands in OpenCode, not in your shell. In the commands below,
`<block>` is a block number such as `3` or a reference such as `b3`;
`<message>` is a message reference such as `m0005`. Brackets denote optional
arguments, not literal characters to type.

### Compression and summaries

| Command                              | Effect                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `/dcp compress [focus]`              | Invoke the agent's compression flow, optionally with a preservation focus             |
| `/dcp manual [on\|off]`              | Set manual mode, or toggle it when no argument is given                               |
| `/dcp view [block]`                  | List compressions or inspect one                                                      |
| `/dcp rewrite <block> [instruction]` | Invoke the agent to write and save a summary version                                  |
| `/dcp toggle <block> [version]`      | List saved versions, or select one; `0` culls the summary                             |
| `/dcp autotoggle [on\|off]`          | Control whether the agent may call `toggle_summary_version`                           |
| `/dcp edit <block> <text>`           | Replace the base summary text, without creating a saved rewrite version               |
| `/dcp edit <block> -a <text>`        | Append to the base summary text                                                       |
| `/dcp edit-file <block> <path>`      | Read a summary document from a file and save it as an active version                  |
| `/dcp decompress [block]`            | List restoration targets or restore one compression's source messages                 |
| `/dcp recompress [block]`            | List or reapply user-decompressed compressions whose origin messages remain available |

The TUI editor uses the `edit-file` path. The plain `edit` command changes the
base summary, so that change need not appear if a later saved version is active.

### Messages, memo, and diagnostics

| Command                     | Effect                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/dcp messages [from] [to]` | List message references and previews; without a range, show the most recent ten                      |
| `/dcp protect [message]`    | List manually protected messages or protect one                                                      |
| `/dcp unprotect <message>`  | Remove manual protection                                                                             |
| `/dcp memo [show]`          | Show the memo                                                                                        |
| `/dcp memo set <text>`      | Replace the memo text                                                                                |
| `/dcp memo clear`           | Clear the memo                                                                                       |
| `/dcp memo-file <path>`     | Replace the memo from a file                                                                         |
| `/dcp context`              | Show the current session's token breakdown                                                           |
| `/dcp stats`                | Show pruning statistics                                                                              |
| `/dcp sweep [n]`            | Prune tool outputs since the last user message, or the last `n` tools, subject to command protection |
| `/dcp debug on <dir>`       | Write post-transform model-query JSON dumps to the directory                                         |
| `/dcp debug off`            | Stop those dumps                                                                                     |

Debug dumps contain model-query content. Choose their storage and sharing
accordingly.

### TUI pages

Open these from the command palette. **Esc** returns from a DCP page.

| Page / palette command                 | Controls and contents                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| **DCP Blocks** — `/dcp-tui-blocks`     | Block list and detail; version tabs are view-only; **e** edits the active summary     |
| **DCP Messages** — `/dcp-tui-messages` | Tracked message chain; **<** pages toward newer messages, **>** toward older messages |
| **DCP Memo** — `/dcp-tui-memo`         | Per-session memo; **e** opens the editor                                              |
| **DCP Skills** — `/dcp-tui-skills`     | Read-only list of this session's loaded skills and their protection status            |

Long block summaries scroll with the mouse wheel, **Up/Down**, **Page Up/Page
Down**, and **Home/End**. Block summaries and memo documents render Markdown.
The editor uses `$VISUAL`, then `$EDITOR`, then `vi`.

Conversation changes refresh after the assistant finishes. The views retain a
valid message page, block selection, and explicitly viewed version. Block and
memo drafts stay private until housekeeping commits; skill loading is immediate
and follows the separate lifecycle below.

## Agent tools

These names refer to tools available to the agent, not slash commands for the
user. OpenCode permissions still apply. Mutation tools in the maintenance pass
require `enter_housekeeping`; complete all intended changes across all affected
blocks before one `leave_housekeeping` call.

| Tool                              | Purpose                                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `enter_housekeeping`              | Open a maintenance transaction and return eligible ranges and guidance                                                        |
| `compress`                        | Submit agent-authored summaries for selected ranges or messages, according to the configured mode                             |
| `expand_block`                    | Extend an existing block's coverage; follow with summary edits                                                                |
| `rewrite_summary`                 | Save a complete summary as an active version                                                                                  |
| `edit_summary` / `append_summary` | Accumulate replacements or additions in a summary editing buffer                                                              |
| `fetch_summary_versions`          | Inspect a block's saved summary versions                                                                                      |
| `toggle_summary_version`          | Select a saved version, including `0`; requires session autotoggle                                                            |
| `recall_compressed`               | Search original messages, optionally scoped to blocks or message ranges; retrieve originals by message ID or message-ID range |
| `edit_memo`                       | Append, remove, or clear memo text items and nested topics                                                                    |
| `read_memo`                       | Read the current memo, including the draft during housekeeping                                                                |
| `leave_housekeeping`              | Publish the accumulated maintenance draft and exit housekeeping                                                               |
| `skill` / `unload_skill`          | Load or unload a session skill; see the lifecycle below                                                                       |

Summary tool inputs are document text, without the injected compression wrapper
or block-reference tag. `recall_compressed` with `action: "get"` takes message
IDs, not a block ID; use `action: "search"` to search within a block and
`fetch_summary_versions` to inspect its summaries.

The memo has root text items and named, nestable topics. `edit_memo` appends
`textItems` and/or `topics`, optionally under a `parent` topic or after a sibling
topic. It removes entries by topic path or text prefix and clears a topic while
keeping the topic itself. Topic nesting is limited to six levels.

## Configuration

HyperDCP reads its own settings from `dcp.jsonc` or `dcp.json`, separately from
OpenCode's plugin-registration files. JSONC accepts comments and trailing commas.

Layers are read in this order; later values override earlier scalar values:

1. Global: `$XDG_CONFIG_HOME/opencode/dcp.jsonc`, or
   `~/.config/opencode/dcp.jsonc` when `XDG_CONFIG_HOME` is unset.
2. Config-directory override: `$OPENCODE_CONFIG_DIR/dcp.jsonc`, when set.
3. Project: `dcp.jsonc` inside the nearest ancestor `.opencode` directory,
   starting from the host-provided working directory.

At each location, `dcp.jsonc` takes precedence over `dcp.json` if both exist.
Protected-tool settings are merged by tool name rather than replacing the
entire inherited collection. Restart OpenCode after changing configuration.

### Settings used by these guides

| Setting                        | Default      | Meaning                                                                     |
| ------------------------------ | ------------ | --------------------------------------------------------------------------- |
| `enabled`                      | `true`       | Enable the plugin                                                           |
| `commands.enabled`             | `true`       | Enable `/dcp` commands                                                      |
| `manualMode.enabled`           | `false`      | Start sessions in manual compression mode                                   |
| `compress.mode`                | `"range"`    | Select `range` or `message` compression                                     |
| `compress.permission`          | `"allow"`    | Compression permission default; explicit host permissions still apply       |
| `compress.minCompressTokens`   | `2000`       | Minimum source size accepted for a compressed range or message              |
| `compress.minContextLimit`     | `50000`      | Lower context threshold used by compression guidance                        |
| `compress.maxContextLimit`     | `100000`     | Upper context threshold used by compression guidance                        |
| `compress.nudgeFrequency`      | `5`          | Turn frequency used by compression nudges                                   |
| `compress.protectedTools`      | `[]`         | Tool outputs retained through compression; separate from command protection |
| `compress.protectUserMessages` | `false`      | Retain user-message text in compressed content                              |
| `compress.protectSubagent`     | `"metadata"` | Subagent retention policy: `none`, `metadata`, or `full`                    |
| `housekeeping.allowedTools`    | `[]`         | Exact ordinary tool names allowed during housekeeping                       |
| `experimental.allowSubAgents`  | `false`      | Allow DCP context management inside subagent sessions                       |

Tool-protection settings accept tool-name arrays such as `["read"]` as well as
per-tool configuration. `commands.protectedTools` applies to command-driven
pruning; it is independent of `compress.protectedTools`. Subagent outputs use
the dedicated policy below, not generic `task` or `subagent` entries in the
compression list.

The [configuration schema](../dcp.schema.json) lists the accepted settings and
shapes. The [configuration implementation](../lib/config.ts) contains defaults
and layer-merging behavior.

### Subagent protection

`compress.protectSubagent` controls the subagent records retained in context:

- `none`: leave subagent messages subject to ordinary compression.
- `metadata`: retain every running execution, plus terminal executions whose
  termination message is covered by the last summary block projected in
  conversation order. Records include the calling reference, child session,
  status, title, steering references, and a result reference for completed
  executions.
- `full`: also retain that execution's delivered report. This does not fetch
  a later answer from the child session.

Records appear after protected skills. Steering a running child adds to its
execution entry; resuming after termination creates a separate entry. Failed
and canceled executions follow the terminal-coverage rule but have no result
reference.

## Skill lifecycle

HyperDCP tracks two lists for each session:

| List             | When it changes                                                      | What it controls                                                |
| ---------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| Loaded skills    | Immediately after a successful native `skill` load or `unload_skill` | Which skills are currently loaded in the session                |
| Protected skills | A successful `leave_housekeeping` copies the loaded list             | Which skill calls and results are injected as protected context |

In **DCP Skills**, **in context** means loaded but not protected; **injected**
means loaded and protected. The page is read-only and shows the session's loaded
list, not the host's full skill inventory.

Loading an already loaded skill requires `force: true`. A failed load leaves
the skill unloaded, including a failed forced reload. Both loading and
unloading are allowed during housekeeping, subject to host permissions, but
skill management alone does not satisfy the leave guard.

Protected skill calls and results are injected immediately after the memo, or
at the same anchor without a memo. Loading or unloading does not change that
protected prefix until a successful leave. Reverting housekeeping restores
the protected list without rolling back immediate loaded status.

Unloading removes the skill's protected injection after the next successful
leave. Its original messages remain in history and can be compressed normally.
Skills are not blanket-protected by default; explicit `protectedTools` settings
still apply. Sessions without recorded skill state start with empty lists
rather than inferring loads from historical calls.

## Host behavior and known issues

- **OpenCode v1:** manual block edits, memo edits, and summary-version toggles
  trigger a user message. See [Known Issues](../KNOWN-ISSUES.md).
- **OpenCode v2:** informational command output and message-style compression
  notifications are queued without waking the agent just to display them.
  Immediate transcript display is not guaranteed. `/dcp compress` and
  `/dcp rewrite` deliberately invoke the agent. Toast notifications use the
  TUI connection.

Return to the [README](../README.md).
