// Synthetic opencode session transcript for the TUI capture harness.
//
// The DCP state fixture (demo-pizza-bot.json) only seeds the plugin's own
// storage; the host session still contains the throwaway bootstrap exchange.
// This transcript replaces it with a neutral housekeeping pass so demo
// screenshots show real session UI (tool calls, sidebar) without a personal
// session. Regenerate nothing: it is deterministic from the constants below.

const USER_TEXT =
    "Oven handoff is finished and tested. Run housekeeping: add the retraction deadline to the memo, compress the finished oven work, and switch the deposit summary to v2."

const ASSISTANT_INTRO =
    "Running one housekeeping pass for the memo, compression, and version change."

const ASSISTANT_OUTRO =
    "Housekeeping committed: the memo records the retraction deadline, the oven work is compressed into b4, and b6 is now on v2."

function part(type, payload, time) {
    return { type, ...payload, time: { start: time, end: time + 4 } }
}

export function buildDemoTranscript({ sessionId, directory, model }) {
    const providerID = model?.providerID ?? "opencode"
    const modelID = model?.modelID ?? "deepseek-v4.1-flash-free"
    const base = Date.now() - 60_000
    const userId = "msg_demo0235"
    const assistantId = "msg_demo0236"

    const userData = {
        role: "user",
        time: { created: base },
        agent: "build",
        model: { providerID, modelID },
        summary: { diffs: [] },
    }

    const assistantData = {
        parentID: userId,
        role: "assistant",
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: {
            total: 84512,
            input: 80000,
            output: 4512,
            reasoning: 0,
            cache: { write: 0, read: 0 },
        },
        modelID,
        providerID,
        time: { created: base + 1000, completed: base + 9000 },
        finish: "stop",
    }

    const tool = (name, callID, input, output, offset) => {
        const start = base + offset
        return part(
            "tool",
            {
                tool: name,
                callID,
                state: {
                    status: "completed",
                    input,
                    output,
                    metadata: {},
                    title: name,
                    time: { start, end: start + 600 },
                },
            },
            start,
        )
    }

    const parts = [
        part("text", { text: USER_TEXT }, base),
        part("step-start", { snapshot: "" }, base + 1000),
        part("text", { text: ASSISTANT_INTRO }, base + 1200),
        tool("enter_housekeeping", "call_demo_enter", {}, "Housekeeping mode active.", 1600),
        tool(
            "edit_memo",
            "call_demo_memo_1",
            {
                action: "append",
                parent: "Constraints",
                textItems: ["Peel retraction is logged against a 1.4 s deadline."],
            },
            "Memo edited (612 rendered characters).",
            2600,
        ),
        tool(
            "edit_memo",
            "call_demo_memo_2",
            {
                action: "append",
                parent: "Takeaways",
                textItems: ["The oven slot IR beam needs a 50 ms debounce."],
            },
            "Memo edited (698 rendered characters).",
            3600,
        ),
        tool(
            "compress",
            "call_demo_compress",
            {
                topic: "Oven handoff and temperature safety",
                content: [
                    {
                        startId: "m0109",
                        endId: "m0147",
                        summary:
                            "## Oven handoff\nThe peel retracts fully within 1.4 s before the gate closes.",
                    },
                ],
            },
            "Compressed m0109-m0147 into block b4 (28.6K -> 104 tokens).",
            4600,
        ),
        tool(
            "toggle_summary_version",
            "call_demo_toggle",
            { blockId: 6, version: 2 },
            "Block #6 summary set to v2.",
            5600,
        ),
        tool("leave_housekeeping", "call_demo_leave", {}, "Housekeeping committed.", 6600),
        part("text", { text: ASSISTANT_OUTRO }, base + 7600),
        part(
            "step-finish",
            {
                reason: "stop",
                snapshot: "",
                tokens: {
                    total: 84512,
                    input: 80000,
                    output: 4512,
                    reasoning: 0,
                    cache: { write: 0, read: 0 },
                },
                cost: 0,
            },
            base + 7800,
        ),
    ]

    return {
        sessionId,
        title: "Doughbot firmware — demo session",
        messages: [
            { id: userId, data: userData, parts: [parts[0]] },
            { id: assistantId, data: assistantData, parts: parts.slice(1) },
        ],
    }
}
