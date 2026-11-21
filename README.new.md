# OpenCode-HyperDCP

HyperDCP is a context management plugin for [OpenCode](https://opencode.ai).
This plugin offers observable & controllable context environment to optimize for model stability and cost efficiency.

## How does HyperDCP manage the context

### HyperDCP replaces messages with a summary in the agent's context

HyperDCP lets the agent summarize a completed range of conversation, and in subsequent context,
that summary occupies in place of the original message range. This is message compression.

Unlike default compaction, only selected ranges of messages can be compressed at good timings during the session.
Message outside the compressed ranges remain untouched in the context.

### Message recall

![A selected range in session history becomes a summary block in the agent's context; recall can retrieve original detail, while current work stays uncompressed](docs/context-model.svg)

The coding agent can retrieve original message by calling `recall_compressed` tool provided by this plugin.
When later discussion involves details of prior arguments or debug outputs, the agent can search and retrieve the original evidence.

### Observable summary blocks

Unlike compaction, summarized ranges does not get compressed again by default.
Therefore, the context include multiple summaries replacing different message ranges.
They are called **DCP blocks** in HyperDCP.

Created DCP block summaries are listed in the sidebar.
The sidebar shows what ranges are compressed and estimated token size of sum of the original messages and the substituting summary.

The content of DCP block can be inspected using DCP TUI Blocks menu.

![Demo block b3 with version tabs v0, v1, and active v2 above its summary](docs/screenshots/dcp-block-detail.png)

You can decompress the DCP block and restore original messages using `/dcp decompress` command.
Also you can cull the summary itself to clean up the context entirely using `/dcp toggle`, or rewrite the summary using TUI edit screen.

[Changing versions, culling, and restoring messages](docs/context-tasks.md#choose-a-summary-version)

#### Memory for how you work

The **memo** is a separate, per-session document that survives compaction.
Keep working commands, user constraints, and procedural knowledge there so they
do not depend on the wording of a particular topic summary. You and the agent
can edit it; the TUI renders it as Markdown.

See [Keep working instructions in the memo](docs/context-tasks.md#keep-working-instructions-in-the-memo)
for the memo view and editing instructions.

Skills have their own lifecycle. **DCP Skills** shows which skills are loaded
in the current session and which are being injected as protected context.
Loading takes effect immediately; the protected set is updated when a
housekeeping pass commits. See the [skill lifecycle reference](docs/context-reference.md#skill-lifecycle)
for the distinction and its effect on unloading.

### When does the context get summarized?

The agent writes the summaries and calls the compression tools. HyperDCP
supplies guidance and nudges as context grows; a nudge is not itself a
compression operation.

**By default, the agent can request compression without a manual trigger,**
subject to OpenCode permissions. To require an explicit trigger, use
`/dcp manual on`, then `/dcp compress` when you want a maintenance pass.
[Manual mode](docs/context-tasks.md#require-a-manual-trigger) can also be set in
configuration.

Autotoggle is a separate control. `/dcp autotoggle on` allows the agent to
switch an existing block's summary version, including version `0`. It is not a
prerequisite for creating a block, and you do not need it to switch versions
yourself with `/dcp toggle`.

#### One housekeeping pass, one publication

The agent's context-maintenance edits are transactional. `enter_housekeeping`
returns eligible ranges and guidance. Compression, memo edits, expansions, and
summary changes accumulate in a draft. The agent finishes the whole pass before
calling `leave_housekeeping` once to publish it.

The block and memo views show committed state rather than partially edited
drafts. Ordinary tools are blocked during housekeeping by default, so the agent
does not continue implementation halfway through maintaining its context.
Exact-name exceptions can be configured with
[`housekeeping.allowedTools`](docs/context-reference.md#configuration);
they do not override OpenCode permissions.

## Tutorial

### Make and inspect your first block

Use an [installed](#install) OpenCode session with a completed investigation or other
finished conversation worth summarizing. The default range mode rejects ranges
smaller than **2,000 tokens**, so a fresh greeting-only session is not enough.
Compression tools must also be permitted by your OpenCode settings.

1. Enter `/dcp manual on` to keep this exercise under manual control.
2. Request a compression pass:

    ```text
    /dcp compress Preserve the decisions, constraints, and evidence from the completed work; leave the current task uncompressed.
    ```

    The command invokes the agent. It receives instructions to enter
    housekeeping, select completed ranges, write summaries, and commit the
    maintenance pass. Wait for that pass to finish. If there is no eligible
    completed range of sufficient size, continue the session rather than
    compressing the current task just to produce a block.

3. Open **DCP Blocks** from the command palette (`/dcp-tui-blocks`). Find the
   block created by the pass. The list shows its topic, message boundaries, and
   source-to-summary token counts:

    ![DCP Blocks list with block IDs, topics, message boundaries, and token counts](docs/screenshots/dcp-blocks-list.png)

    This capture uses synthetic demo data; your blocks and counts will differ.
    Select your block and read its summary. Check a decision you remember
    against the text; note the block ID and the `*` active-version marker.

4. Press **e** to open the block's active summary in your text editor
   (`$VISUAL`, then `$EDITOR`, then `vi`). Preserve the
   file's delimiter lines, make a useful correction to the summary, then save
   and exit. The saved text becomes another active version.
5. Compare the earlier and edited versions using the tabs. The `*` stays on the
   active version even while you read another one. Press **Esc** to return.

You have made a compressed range inspectable and corrected what represents it
in context. To switch back, follow [Choose a summary version](docs/context-tasks.md#choose-a-summary-version).
To investigate a missing detail, [ask for the original messages](docs/context-tasks.md#recover-an-exact-detail).

Manual mode remains on after the exercise. Leave it on for explicit compression
triggers, or use `/dcp manual off` to allow agent-initiated compression again.

On OpenCode v1, manual block edits, memo edits, and summary-version toggles
trigger a user message. On v2, informational command output may be queued rather
than appearing immediately in the transcript. See [host behavior and known issues](docs/context-reference.md#host-behavior-and-known-issues).

## How-to

### Install

The npm package is `@architectural-composition/opencode-hyperdcp`. It includes
native adapters for OpenCode v1 and v2: the server plugin provides context
operations, while the TUI plugin provides the sidebar and inspection pages.

Merge the package into the `plugin` array in
`~/.config/opencode/opencode.json`, keeping your other settings and plugins:

```json
{
    "$schema": "https://opencode.ai/config.json",
    "plugin": ["@architectural-composition/opencode-hyperdcp"]
}
```

Register the TUI plugin in `~/.config/opencode/tui.json` as well:

```json
{
    "$schema": "https://opencode.ai/tui.json",
    "plugin": ["@architectural-composition/opencode-hyperdcp"]
}
```

Restart OpenCode. In an active session, open the command palette and look for
**DCP Blocks**, **DCP Messages**, **DCP Memo**, and **DCP Skills**. These pages
are the installation checkpoint for the TUI; `/dcp` provides the server command
entry point.

Plugin registration belongs in OpenCode's configuration. HyperDCP's own
settings belong in a separate [`dcp.jsonc` file](docs/context-reference.md#configuration).

- [Correct a summary](docs/context-tasks.md#correct-a-summary)
- [Restore the original messages to the agent's context](docs/context-tasks.md#restore-the-original-messages)

## Reference

- [Commands](docs/context-reference.md#commands-and-tui-controls)
- [Configuration options](docs/context-reference.md#configuration)

## Project

HyperDCP is a fork of
[opencode-dynamic-context-pruning](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning).
See the [changelog](CHANGELOG.md) for release details,
[known issues](KNOWN-ISSUES.md) for host-specific caveats, and
[contribution terms](CONTRIBUTING.md) before contributing.

Report reproducible problems in the [issue tracker](https://github.com/yuriha-chan/OpenCode-HyperDCP/issues).
The project is licensed under [AGPL-3.0-or-later](LICENSE).
