export const TURN_NUDGE = `<dcp-system-reminder>
Evaluate the conversation for compressible ranges.

If any messages are cleanly closed and unlikely to be needed again, use the compress tool on them.
If direction has shifted, compress earlier ranges that are now less relevant.
If you decide to compress, use 'edit_memo' to update the memo. Review user requests on procedures and your command execution formats and extract anything other than content — command patterns, user constraints, tooling preferences. If not applicable, skip.

The goal is to filter noise and distill key information so context accumulation stays under control.
Keep active context uncompressed.
</dcp-system-reminder>
`
