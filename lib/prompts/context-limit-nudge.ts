export const CONTEXT_LIMIT_NUDGE = `<dcp-system-reminder>
CRITICAL WARNING: MAX CONTEXT LIMIT REACHED

You are at or beyond the configured max context threshold. This is an emergency context-recovery moment.

You MUST start the COMPRESS FLOW now. Do not continue normal exploration until compression is handled.

If you are in the middle of a critical atomic operation, finish that atomic step first, then compress immediately.

COMPRESS FLOW
1. Use 'edit_memo' to update the memo. Review user requests on procedures and your command execution formats and extract anything other than content — working commands (concrete shell invocations that work technically in this environment — both on-demand and in agentic loops), user constraints, tooling preferences. If not applicable, skip.
2. Select the message ranges to compress. Divide a range into multiple ranges if the range includes multiple topics.
3. For each range, use 'compress' tool to compress the selected message range into the summary. If the selected range is the continuation of the previous block about the same topic, you can call 'expand_block', 'edit_summary' / 'append_summary' and 'save_summary' for the existing block instead of creating new summary block.

SELECTION PROCESS
Start from older, resolved history and capture as much stale context as safely possible in one pass.
Avoid the newest active working messages unless it is clearly closed.

SUMMARY REQUIREMENTS
Your summary MUST cover all essential details from the selected messages so work can continue.
If the compressed range includes user messages, preserve user intent exactly. Prefer direct quotes for short user messages to avoid semantic drift.
</dcp-system-reminder>
`
