# Known Issues

## Block Detail page does not refresh after editing a summary

Status: unresolved

When editing a block summary from the TUI (palette command `dcp-tui-edit` or the `e` binding on the Block Detail page), the edit is applied server-side, but the open Block Detail page keeps showing the old text. Re-entering the page shows the updated summary.

Attempts that did not change the behavior:

- Remounting the page by cycling between two identical route names (`dcp-block` / `dcp-block-alt`).
- Polling the session state file until the block summary matches the edited text, then remounting (poll stops when the user leaves the page or a newer edit supersedes it).

Root cause unconfirmed. Candidates: `route.current`/params do not match after the handoff command, or the remount does not re-read the state file.
