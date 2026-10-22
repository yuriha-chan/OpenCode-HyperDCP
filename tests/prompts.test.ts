import "./helpers/storage-env"
import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Logger } from "../lib/logger"
import { PROMPT_KEYS, PromptStore } from "../lib/prompts/store"
import { SYSTEM as SYSTEM_PROMPT } from "../lib/prompts/system"

function createPromptStoreFixture(overrideContent?: string, overrideFileName = "system.md") {
    const rootDir = mkdtempSync(join(tmpdir(), "opencode-dcp-prompts-"))
    const configHome = join(rootDir, "config")
    const workspaceDir = join(rootDir, "workspace")

    mkdirSync(configHome, { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })

    const previousConfigHome = process.env.XDG_CONFIG_HOME
    const previousOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR

    process.env.XDG_CONFIG_HOME = configHome
    delete process.env.OPENCODE_CONFIG_DIR

    if (overrideContent !== undefined) {
        const overrideDir = join(configHome, "opencode", "dcp-prompts", "overrides")
        mkdirSync(overrideDir, { recursive: true })
        writeFileSync(join(overrideDir, overrideFileName), overrideContent, "utf-8")
    }

    const store = new PromptStore(new Logger(false), workspaceDir, true)

    return {
        store,
        cleanup() {
            if (previousConfigHome === undefined) {
                delete process.env.XDG_CONFIG_HOME
            } else {
                process.env.XDG_CONFIG_HOME = previousConfigHome
            }

            if (previousOpencodeConfigDir === undefined) {
                delete process.env.OPENCODE_CONFIG_DIR
            } else {
                process.env.OPENCODE_CONFIG_DIR = previousOpencodeConfigDir
            }

            rmSync(rootDir, { recursive: true, force: true })
        },
    }
}

test("system prompt overrides handle reminder tags safely", async (t) => {
    await t.test("plain-text mentions do not invalidate copied system prompt overrides", () => {
        const fixture = createPromptStoreFixture(
            `${SYSTEM_PROMPT.trim()}\n\nExtra override line.\n`,
        )

        try {
            const runtimeSystemPrompt = fixture.store.getRuntimePrompts().system

            assert.match(runtimeSystemPrompt, /Extra override line\./)
            assert.match(runtimeSystemPrompt, /environment-injected metadata/)
        } finally {
            fixture.cleanup()
        }
    })

    await t.test("fully wrapped overrides are normalized to a single runtime wrapper", () => {
        const fixture = createPromptStoreFixture(
            `<dcp-system-reminder>\nWrapped override body\n</dcp-system-reminder>\n`,
        )

        try {
            const runtimeSystemPrompt = fixture.store.getRuntimePrompts().system
            const openingTags = runtimeSystemPrompt.match(/<dcp-system-reminder\b[^>]*>/g) ?? []
            const closingTags = runtimeSystemPrompt.match(/<\/dcp-system-reminder>/g) ?? []

            assert.equal(openingTags.length, 1)
            assert.equal(closingTags.length, 1)
            assert.match(runtimeSystemPrompt, /Wrapped override body/)
        } finally {
            fixture.cleanup()
        }
    })

    await t.test("malformed boundary wrappers are rejected", () => {
        const baselineFixture = createPromptStoreFixture()
        const malformedFixture = createPromptStoreFixture(
            `<dcp-system-reminder>\nMalformed override body\n`,
        )

        try {
            const baselineSystemPrompt = baselineFixture.store.getRuntimePrompts().system
            const malformedSystemPrompt = malformedFixture.store.getRuntimePrompts().system

            assert.equal(malformedSystemPrompt, baselineSystemPrompt)
            assert.doesNotMatch(malformedSystemPrompt, /Malformed override body/)
        } finally {
            malformedFixture.cleanup()
            baselineFixture.cleanup()
        }
    })
})

test("prompt store exposes bundled message-mode compress prompt", () => {
    const fixture = createPromptStoreFixture()

    try {
        const runtimePrompts = fixture.store.getRuntimePrompts()

        assert.match(runtimePrompts.compressMessage, /selected individual messages/i)
        assert.match(
            runtimePrompts.compressMessage,
            /Only use raw message IDs of the form `mNNNN`\./,
        )
        assert.match(runtimePrompts.compressMessage, /priority="high"/)
        assert.match(runtimePrompts.compressMessage, /high-priority messages/i)
        assert.match(runtimePrompts.compressMessage, /BLOCKED/)
        assert.match(runtimePrompts.compressMessage, /cannot be compressed/i)
        assert.doesNotMatch(runtimePrompts.compressMessage, /THE FORMAT OF COMPRESS/)
    } finally {
        fixture.cleanup()
    }
})

test("compress-message overrides preserve plain-text metadata mentions", () => {
    const fixture = createPromptStoreFixture(
        [
            "Override body.",
            "",
            'Each message has an ID inside XML metadata tags like `<dcp-message-id priority="high">m0007</dcp-message-id>`.',
            "Messages marked as `<dcp-message-id>BLOCKED</dcp-message-id>` cannot be compressed.",
        ].join("\n"),
        "compress-message.md",
    )

    try {
        const runtimePrompts = fixture.store.getRuntimePrompts()

        assert.match(runtimePrompts.compressMessage, /Override body\./)
        assert.match(
            runtimePrompts.compressMessage,
            /<dcp-message-id priority="high">m0007<\/dcp-message-id>/,
        )
        assert.match(runtimePrompts.compressMessage, /<dcp-message-id>BLOCKED<\/dcp-message-id>/)
    } finally {
        fixture.cleanup()
    }
})

test("prompt store exposes bundled range-mode compress prompt", () => {
    const fixture = createPromptStoreFixture()

    try {
        const runtimePrompts = fixture.store.getRuntimePrompts()

        assert.match(runtimePrompts.compressRange, /Collapse a range in the conversation/i)
        assert.match(runtimePrompts.compressRange, /BATCHING/)
        assert.match(runtimePrompts.compressRange, /MEMO/)
        assert.match(runtimePrompts.compressRange, /content` array/)
    } finally {
        fixture.cleanup()
    }
})

test("prompt store registers housekeeping guidance for preview and runtime entry instructions", () => {
    const fixture = createPromptStoreFixture()

    try {
        assert.ok((PROMPT_KEYS as readonly string[]).includes("housekeeping-guidance"))
        const runtime = fixture.store.getRuntimePrompts() as ReturnType<
            PromptStore["getRuntimePrompts"]
        > & {
            housekeepingGuidance?: string
        }
        const guidance = runtime.housekeepingGuidance
        assert.ok(guidance, "entry guidance must be available through the runtime prompt API")
        assert.match(guidance, /leave_housekeeping/)
        assert.match(guidance, /compress/)
        assert.match(guidance, /read_memo/)
        assert.match(guidance, /fetch_summary_versions/)
        assert.match(guidance, /edit_summary|append_summary/)
        assert.match(guidance, /stag|draft/i)
        assert.match(guidance, /reference|mNNNN|mXXXX/i)
        assert.match(guidance, /block|restrict|allow/i)
        assert.match(guidance, /edit_memo/)
        assert.match(guidance, /working commands/i)
        assert.match(guidance, /procedur|preferences/i)
        assert.match(guidance, /older.*resolved|resolved.*older/i)
        assert.match(guidance, /batch|one pass/i)
        assert.match(guidance, /independent topics/i)
        assert.match(guidance, /expand_block/)
        assert.match(guidance, /active work|active context/i)
        assert.match(guidance, /user intent/i)
        assert.match(guidance, /hidden|suppressed|disappear/i)
        assert.match(guidance, /findings.*memo|memo.*findings/is)
        assert.match(guidance, /fail.*repair.*retry/is)
        assert.doesNotMatch(guidance, /save_summary/)
    } finally {
        fixture.cleanup()
    }
})

test("housekeeping guidance overrides are exposed through the public runtime prompt API", () => {
    const fixture = createPromptStoreFixture(
        "Complete and review the entire maintenance pass before calling leave_housekeeping. Custom entry guidance.",
        "housekeeping-guidance.md",
    )

    try {
        fixture.store.reload()
        const runtime = fixture.store.getRuntimePrompts() as ReturnType<
            PromptStore["getRuntimePrompts"]
        > & {
            housekeepingGuidance?: string
        }
        assert.ok(runtime.housekeepingGuidance)
        assert.match(runtime.housekeepingGuidance, /Custom entry guidance\./)
        assert.match(runtime.housekeepingGuidance, /leave_housekeeping/)
    } finally {
        fixture.cleanup()
    }
})

test("system and outside-mode nudges describe entry and leave without detailed maintenance ranges", () => {
    const fixture = createPromptStoreFixture()

    try {
        const runtime = fixture.store.getRuntimePrompts()
        for (const [name, prompt] of Object.entries({
            system: runtime.system,
            context: runtime.contextLimitNudge,
            turn: runtime.turnNudge,
            iteration: runtime.iterationNudge,
        })) {
            assert.match(prompt, /enter_housekeeping/, `${name} must direct entry`)
            assert.match(prompt, /leave_housekeeping/, `${name} must direct commit and exit`)
            assert.doesNotMatch(prompt, /UNCOVERED MESSAGE RANGES|m\d{4}\s*→|save_summary/)
            if (name !== "system") {
                assert.ok(prompt.length < 1000, `${name} should be a concise invitation`)
            }
        }
        for (const [name, prompt] of Object.entries(runtime)) {
            assert.doesNotMatch(prompt, /save_summary/, `${name} must not advertise save_summary`)
        }
    } finally {
        fixture.cleanup()
    }
})

test("maintenance nudges preserve distinct urgency and safe entry conditions", () => {
    const fixture = createPromptStoreFixture()

    try {
        const { contextLimitNudge, turnNudge, iterationNudge } = fixture.store.getRuntimePrompts()
        assert.match(contextLimitNudge, /max(?:imum)? context|context threshold/i)
        assert.match(
            contextLimitNudge,
            /must.*enter_housekeeping|enter_housekeeping.*immediately/is,
        )
        assert.match(contextLimitNudge, /pause|do not continue/i)
        assert.match(contextLimitNudge, /critical atomic|atomic step/i)
        assert.match(turnNudge, /direction|turn boundary/i)
        assert.match(turnNudge, /if.*closed/is)
        assert.match(iterationNudge, /iterat.*last user|last user.*iterat/is)
        assert.match(iterationNudge, /if.*closed/is)
        assert.match(iterationNudge, /research.*implementation/is)
        for (const nudge of [turnNudge, iterationNudge]) {
            assert.match(nudge, /active.*uncompressed|preserve.*active/i)
            assert.doesNotMatch(nudge, /critical warning|max(?:imum)? context/i)
        }
        assert.notEqual(turnNudge, iterationNudge)
    } finally {
        fixture.cleanup()
    }
})
