# Known Issues

## Resolved: Block Detail page did not refresh after editing a summary

Status: resolved; editor save, terminal restoration, and persistence after restart verified by the user.

Editing a block summary previously applied the edit server-side while the open Block Detail page kept showing the old text. Re-entering the page showed the updated summary.

The editor workflow awaits terminal suspension, child-process exit, and terminal restoration before submitting the saved document. Sidebar and page views observe the same session-scoped cache of committed DCP state, so editor saves refresh mounted views without route remounts. Valid page and explicit summary-version selections are preserved.

The earlier route-remount workarounds and editor-specific polling are not used. This entry no longer represents an outstanding issue; it does not assert that the earlier route-parameter hypotheses were established causes.
