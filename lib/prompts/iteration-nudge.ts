export const ITERATION_NUDGE = `<dcp-system-reminder>
You've been iterating for a while after the last user message.

If there is a closed portion that is unlikely to be referenced immediately (for example, finished research before implementation), start the compress tool on it now.

COMPRESS FLOW
1. Use 'edit_memo' to update the memo. Review user requests on procedures and your command execution formats and extract anything other than content — command patterns, user constraints, tooling preferences. If not applicable, skip.
2. Select the message ranges to compress. Divide a range into multiple ranges if the range includes multiple topics.
3. For each range, use 'compress' tool to compress the selected message range into the summary. If the selected range is the continuation of the previous block about the same topic, you can call 'expand_block', 'edit_summary' / 'append_summary' and 'save_summary' for the existing block instead of creating new summary block.
</dcp-system-reminder>
`
