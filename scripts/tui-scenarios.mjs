// Scenario definitions for the DCP TUI harness.
//
// A scenario is an ordered list of Playwright-style steps:
//   { keys: "..." , delay?: ms }        type keys, then wait delay (default settle)
//   { waitFor: "marker", timeout?: ms } block until the emulated screen shows marker
//   { screenshot: "expected" }          assert expected text is on screen (null = just capture)
//
// `waitFor` matches what the user sees (the Python driver replays the PTY stream
// into a screen grid). On timeout the scenario aborts and is reported as failed.
//
// Keys use "<Esc>"/"<Enter>"/"<Down>" etc.; the slash command "/dcp-tui-blocks"
// opens the palette entry and <Enter> selects the highlighted command.

export const DEFAULT_WAIT_FOR = "Ask anything"

export function openCommand(name, { delay = 1500 } = {}) {
    return [
        { keys: "/", delay: 500 },
        { keys: name, delay: 300 },
        { keys: "<Enter>", delay },
    ]
}

export const scenarios = [
    {
        name: "dcp-blocks-list",
        title: "Open DCP block list from the palette",
        steps: [
            { waitFor: DEFAULT_WAIT_FOR, timeout: 30000 },
            ...openCommand("dcp-tui-blocks"),
            { waitFor: "DCP Blocks", timeout: 5000 },
            { screenshot: "DCP Blocks" },
        ],
    },
    {
        name: "dcp-block-detail",
        title: "Open first block detail (with version tabs)",
        steps: [
            { waitFor: DEFAULT_WAIT_FOR, timeout: 30000 },
            ...openCommand("dcp-tui-blocks"),
            { waitFor: "DCP Blocks", timeout: 5000 },
            { keys: "<Enter>", delay: 1500 },
            { waitFor: "Versions:", timeout: 5000 },
            { screenshot: "Versions:" },
        ],
    },
    {
        name: "dcp-block-collapse",
        title: "Collapse the block list section",
        steps: [
            { waitFor: DEFAULT_WAIT_FOR, timeout: 30000 },
            ...openCommand("dcp-tui-blocks"),
            { waitFor: "DCP Blocks", timeout: 5000 },
            { keys: "<Space>", delay: 800 },
            { screenshot: "DCP Blocks" },
        ],
    },
    {
        name: "dcp-messages",
        title: "Open DCP messages page",
        steps: [
            { waitFor: DEFAULT_WAIT_FOR, timeout: 30000 },
            ...openCommand("dcp-tui-messages"),
            { waitFor: "DCP Messages", timeout: 5000 },
            { screenshot: "DCP Messages" },
        ],
    },
    {
        name: "dcp-memo",
        title: "Open DCP memo page",
        steps: [
            { waitFor: DEFAULT_WAIT_FOR, timeout: 30000 },
            ...openCommand("dcp-tui-memo"),
            { waitFor: "DCP Memo", timeout: 5000 },
            { screenshot: "DCP Memo" },
        ],
    },
    {
        name: "dcp-block-edit-key",
        title: "On a block detail page, the 'e' binding opens the editor",
        steps: [
            { waitFor: DEFAULT_WAIT_FOR, timeout: 30000 },
            ...openCommand("dcp-tui-blocks"),
            { waitFor: "DCP Blocks", timeout: 5000 },
            { keys: "<Enter>", delay: 1200 },
            { waitFor: "Versions:", timeout: 5000 },
            { keys: "e", delay: 500 },
            { keys: "<Esc>", delay: 500 },
            { screenshot: null },
        ],
    },
]

export function findScenario(name) {
    return scenarios.find((scenario) => scenario.name === name)
}
