import "./helpers/storage-env"
import assert from "node:assert/strict"
import test from "node:test"
import {
    commitBlock,
    createHousekeepingHarness,
    stageBlock,
    visibleText,
    type HousekeepingHarness,
} from "./helpers/housekeeping"

async function contextText(h: HousekeepingHarness): Promise<string> {
    return visibleText(
        (await h.render()).map((message) => ({
            ...message,
            parts: message.parts.filter((part) => part.type === "text"),
        })),
    )
}

test("toggle_summary_version requires housekeeping even when autotoggle is enabled", async (t) => {
    const h = await createHousekeepingHarness(t)
    await commitBlock(h)
    await h.command("autotoggle on")

    await assert.rejects(
        h.run("toggle_summary_version", { blockId: 1, version: 0 }),
        /enter_housekeeping/i,
    )

    assert.match(await h.versions(), /Active version: v1\b/)
    assert.match(await contextText(h), /Parser findings\./)
    h.assertSessionReads()
})

for (const explicitlyDisabled of [false, true]) {
    test(`toggle_summary_version rejects ${explicitlyDisabled ? "explicitly disabled" : "default disabled"} autotoggle inside housekeeping`, async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)
        if (explicitlyDisabled) {
            await h.command("autotoggle on")
            await h.command("autotoggle off")
        }
        await h.enter()
        await h.run("rewrite_summary", { blockId: 1, summary: "Retained staged rewrite." })

        await assert.rejects(
            h.run("toggle_summary_version", { blockId: 1, version: 0 }),
            /autotoggle/i,
        )

        assert.match(await h.versions(), /Active version: v2\b/)
        assert.match(await contextText(h), /Parser findings\./)
        await h.leave()

        assert.match(await contextText(h), /Retained staged rewrite\./)
        h.assertSessionReads()
    })
}

for (const version of [0, 1, 2, 3]) {
    test(`toggle_summary_version stages ${version === 0 ? "disabled summaries" : `version ${version}`} and publishes only on leave`, async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)
        await h.command("autotoggle on")
        await h.enter()
        await h.run("rewrite_summary", { blockId: 1, summary: "First parser rewrite." })
        await h.run("rewrite_summary", { blockId: 1, summary: "Latest parser rewrite." })

        const result = await h.run("toggle_summary_version", { blockId: 1, version })

        const label = version === 0 ? "disabled" : `v${version}`
        assert.match(result, new RegExp(`block #?1.*${label}\\b`, "i"))
        assert.match(await h.versions(), new RegExp(`Active version: ${label}\\b`))
        assert.match(await h.versions(), /3 version\(s\) available/)
        assert.match(await h.versions(1, 1), /Parser findings\./)
        assert.match(await h.versions(1, 2), /First parser rewrite\./)
        assert.match(await h.versions(1, 3), /Latest parser rewrite\./)
        const before = await contextText(h)
        assert.match(before, /Parser findings\./)
        assert.doesNotMatch(before, /First parser rewrite\.|Latest parser rewrite\./)

        await h.leave()

        assert.match(await h.versions(), new RegExp(`Active version: ${label}\\b`))
        const after = await contextText(h)
        const summaries = ["Parser findings.", "First parser rewrite.", "Latest parser rewrite."]
        for (const [index, summary] of summaries.entries()) {
            assert.equal(after.includes(summary), version === index + 1, after)
        }
        h.assertSessionReads()
    })
}

for (const version of [-1, 1.5, 3]) {
    test(`toggle_summary_version rejects version ${version} and retains the previously selected draft`, async (t) => {
        const h = await createHousekeepingHarness(t)
        await commitBlock(h)
        await h.command("autotoggle on")
        await h.enter()
        await h.run("rewrite_summary", { blockId: 1, summary: "Retained parser rewrite." })
        const before = await h.versions()

        await assert.rejects(h.run("toggle_summary_version", { blockId: 1, version }), /version/i)

        assert.equal(await h.versions(), before)
        assert.match(await contextText(h), /Parser findings\./)
        await h.leave()

        assert.match(await h.versions(), /Active version: v2\b/)
        assert.match(await contextText(h), /Retained parser rewrite\./)
        h.assertSessionReads()
    })
}

test("toggle_summary_version rejects an unknown block without damaging a valid draft", async (t) => {
    const h = await createHousekeepingHarness(t)
    await commitBlock(h)
    await h.command("autotoggle on")
    await h.enter()
    await h.run("rewrite_summary", { blockId: 1, summary: "Retained draft." })
    const before = await h.versions()

    await assert.rejects(
        h.run("toggle_summary_version", { blockId: 999, version: 1 }),
        /block.*not found/i,
    )

    assert.equal(await h.versions(), before)
    await h.run("toggle_summary_version", { blockId: 1, version: 1 })
    await h.leave()

    assert.match(await h.versions(), /Active version: v1\b/)
    assert.match(await h.versions(1, 2), /Retained draft\./)
    assert.match(await contextText(h), /Parser findings\./)
    h.assertSessionReads()
})

test("toggle_summary_version can select the original on a block with no rewrites", async (t) => {
    const h = await createHousekeepingHarness(t)
    await commitBlock(h)
    await h.command("autotoggle on")
    await h.enter()

    await h.run("toggle_summary_version", { blockId: 1, version: 1 })
    await h.leave()

    assert.match(await h.versions(), /Active version: v1\b/)
    assert.match(await h.versions(), /1 version\(s\) available/)
    assert.match(await contextText(h), /Parser findings\./)
    h.assertSessionReads()
})

test("a rejected version toggle does not materialize or discard an earlier pending buffer", async (t) => {
    const h = await createHousekeepingHarness(t)
    await commitBlock(h)
    await h.command("autotoggle on")
    await h.enter()
    await h.run("append_summary", { blockId: 1, text: " Retained pending detail." })
    const before = await h.versions()

    await assert.rejects(h.run("toggle_summary_version", { blockId: 1, version: 3 }), /version/i)

    assert.equal(await h.versions(), before)
    await h.run("append_summary", { blockId: 1, text: " Continued." })
    await h.leave()

    assert.match(await h.versions(), /Active version: v2\b/)
    assert.match(await h.versions(), /2 version\(s\) available/)
    assert.match(await h.versions(1, 2), /Parser findings\. Retained pending detail\. Continued\./)
    assert.match(await contextText(h), /Parser findings\. Retained pending detail\. Continued\./)
    h.assertSessionReads()
})

test("toggle_summary_version can select a rewrite of a block created in the same transaction", async (t) => {
    const h = await createHousekeepingHarness(t)
    await h.command("autotoggle on")
    await h.enter()
    await stageBlock(h)
    await h.run("rewrite_summary", { blockId: 1, summary: "Selected draft rewrite." })
    await h.run("rewrite_summary", { blockId: 1, summary: "Unselected later rewrite." })

    await h.run("toggle_summary_version", { blockId: 1, version: 2 })

    assert.match(await h.versions(), /Active version: v2\b/)
    const before = await h.render()
    assert.ok(before.some((message) => message.info.id === "source-1"))
    assert.doesNotMatch(await contextText(h), /Selected draft rewrite\./)
    await h.leave()

    assert.match(await h.versions(), /Active version: v2\b/)
    assert.match(await contextText(h), /Selected draft rewrite\./)
    assert.doesNotMatch(await contextText(h), /Unselected later rewrite\./)
    h.assertSessionReads()
})

test("toggle retries after restart return the recorded result without changing selection", async (t) => {
    const h = await createHousekeepingHarness(t)
    await commitBlock(h)
    await h.command("autotoggle on")
    await h.enter()
    await h.run("rewrite_summary", { blockId: 1, summary: "Toggle retry version." })
    const first = await h.run(
        "toggle_summary_version",
        { blockId: 1, version: 2 },
        { callID: "toggle-retry" },
    )
    await h.restart()
    assert.equal(
        await h.run(
            "toggle_summary_version",
            { blockId: 1, version: 1 },
            { callID: "toggle-retry" },
        ),
        first,
    )
    assert.match(await h.versions(), /Active version: v2\b/)
    await h.leave()
})
