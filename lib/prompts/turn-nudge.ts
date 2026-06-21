export const TURN_NUDGE = `<dcp-system-reminder>
Evaluate the conversation for compressible ranges.

If any messages are cleanly closed and unlikely to be needed again, use the compress tool on them.
If direction has shifted, compress earlier ranges that are now less relevant.
If you decide to compress, use 'edit_memo' to update the memo. Extract command patterns, workflow patterns, user instructions/hints, discovered constraints, tooling preferences, and any surface-form knowledge that would evaporate between sessions.

The goal is to filter noise and distill key information so context accumulation stays under control.
Keep active context uncompressed.
</dcp-system-reminder>
`
