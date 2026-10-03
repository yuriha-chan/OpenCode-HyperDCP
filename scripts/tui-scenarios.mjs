// Scenario definitions for the DCP TUI harness.
//
// A scenario is an ordered list of Playwright-style steps:
//   { keys: "..." , delay?: ms }        type keys, then wait delay (default settle)
//   { waitFor: "marker", timeout?: ms } block until the emulated screen shows marker
//   { assert: "expected" }              assert expected text is on screen
//   { screenshot: "name.png" }          render the colored screen to name.png (chromium headless)
//   { click: "label", delay?: ms }      find label on screen and send a mouse click at its cell
//
// `waitFor` matches what the user sees (the Python driver replays the PTY stream
// into a screen grid). On timeout the scenario aborts and is reported as failed.
//
// Keys use "<Esc>"/"<Enter>"/"<Down>" etc.; the slash command "/dcp-tui-blocks"
// opens the palette entry and <Enter> selects the highlighted command.

export const DEFAULT_WAIT_FOR = "ctrl+p commands"

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
            { screenshot: "dcp-blocks-list.png" },
        ],
    },
    {
        name: "dcp-block-detail",
        title: "Open a block with multiple versions (version tabs)",
        steps: [
            { waitFor: DEFAULT_WAIT_FOR, timeout: 30000 },
            ...openCommand("dcp-tui-blocks"),
            { waitFor: "DCP Blocks", timeout: 5000 },
            { click: "b3", delay: 1500 },
            { waitFor: "Versions:", timeout: 5000 },
            { screenshot: "dcp-block-detail.png" },
        ],
    },
    {
        name: "dcp-block-culled",
        title: "Open a version-0 block (range culled, summary hidden)",
        steps: [
            { waitFor: DEFAULT_WAIT_FOR, timeout: 30000 },
            ...openCommand("dcp-tui-blocks"),
            { waitFor: "DCP Blocks", timeout: 5000 },
            { click: "b2", delay: 1500 },
            { waitFor: "Versions:", timeout: 5000 },
            { screenshot: "dcp-block-culled.png" },
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
            { screenshot: "dcp-block-collapse.png" },
        ],
    },
    {
        name: "dcp-messages",
        title: "Open DCP messages page",
        steps: [
            { waitFor: DEFAULT_WAIT_FOR, timeout: 30000 },
            ...openCommand("dcp-tui-messages"),
            { waitFor: "DCP Messages", timeout: 5000 },
            { screenshot: "dcp-messages.png" },
        ],
    },
    {
        name: "dcp-memo",
        title: "Open DCP memo page",
        steps: [
            { waitFor: DEFAULT_WAIT_FOR, timeout: 30000 },
            ...openCommand("dcp-tui-memo"),
            { waitFor: "DCP Memo", timeout: 5000 },
            { screenshot: "dcp-memo.png" },
        ],
    },
    {
        name: "dcp-block-edit-key",
        title: "On a block detail page, the 'e' binding opens the editor",
        steps: [
            { waitFor: DEFAULT_WAIT_FOR, timeout: 30000 },
            ...openCommand("dcp-tui-blocks"),
            { waitFor: "DCP Blocks", timeout: 5000 },
            { click: "b3", delay: 1200 },
            { waitFor: "Versions:", timeout: 5000 },
            { keys: "e", delay: 500 },
            { screenshot: "dcp-block-edit-key.png" },
            { keys: "<Esc>", delay: 500 },
        ],
    },
]

export function findScenario(name) {
    return scenarios.find((scenario) => scenario.name === name)
}
