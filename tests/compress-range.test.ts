import "./helpers/storage-env"
import assert from "node:assert/strict"
import test from "node:test"
import {
    createHousekeepingHarness,
    ordinaryMessage,
    stageBlock,
    visibleText,
} from "./helpers/housekeeping"

test("compress range requires housekeeping entry before staging", async (t) => {
    const h = await createHousekeepingHarness(t, { mode: "range" })

    await assert.rejects(
        stageBlock(h),
        /enter_housekeeping|enter.*housekeeping|housekeeping.*mode/i,
    )
    const context = visibleText(await h.render())
    assert.match(context, /Investigate the parser boundary\./)
    assert.match(context, /The parser accepts an empty record\./)
    await assert.rejects(h.versions(), /block.*1.*not found/i)

    await h.enter()
    assert.match(await stageBlock(h), /stag/i)
    await h.leave()
    assert.match(visibleText(await h.render()), /Parser findings\./)
    h.assertSessionReads()
})

test("compress range stages a receipt and replaces source context only on leave", async (t) => {
    const h = await createHousekeepingHarness(t, { mode: "range" })
    const entry = await h.enter()
    assert.match(entry, /m0001/)
    assert.match(entry, /m0004/)

    const receipt = await stageBlock(h, "Parser accepts empty records.")
    assert.match(receipt, /stag/i)
    assert.match(receipt, /2 messages/i)
    assert.match(await h.versions(1, 1), /Parser accepts empty records\./)
    const staged = await h.render()
    assert.match(
        visibleText(staged.filter((message) => message.info.id === "source-1")),
        /Investigate the parser boundary\./,
    )
    assert.match(
        visibleText(staged.filter((message) => message.info.id === "source-2")),
        /The parser accepts an empty record\./,
    )
    assert.doesNotMatch(
        visibleText(
            staged.filter((message) => !message.parts.some((part) => part.type === "tool")),
        ),
        /Parser accepts empty records\./,
    )

    await h.leave()
    const committed = visibleText(await h.render())
    assert.match(committed, /Parser accepts empty records\./)
    assert.doesNotMatch(
        committed,
        /Investigate the parser boundary\.|The parser accepts an empty record\./,
    )
    assert.match(committed, /Keep the newline constraint\./)
    assert.match(committed, /Use the documented parser API\./)
    h.assertSessionReads()
})

test("entry freezes an ordinary prefix in the same message as its boundary call", async (t) => {
    const h = await createHousekeepingHarness(t)
    const boundaryMessage = h.history[0]!
    const entry = await h.run(
        "enter_housekeeping",
        {},
        {
            messageID: boundaryMessage.info.id,
            callID: "mixed-entry",
        },
    )
    assert.match(entry, /m0001/)
    assert.match(await stageBlock(h, "Mixed-boundary source summary.", "m0001", "m0001"), /stag/i)
    assert.match(
        await h.run("recall_compressed", { action: "get", messageId: "m0001" }),
        /Investigate the parser boundary\./,
    )
    await h.leave()
    assert.match(visibleText(await h.render()), /Mixed-boundary source summary\./)
    assert.doesNotMatch(visibleText(await h.render()), /Investigate the parser boundary\./)
})

test("housekeeping entry restores subagent references after a session reset", async (t) => {
    const sessionID = "ses_range_subagent_reset"
    const h = await createHousekeepingHarness(t, {
        mode: "range",
        parentID: "ses_parent",
        allowSubAgents: true,
        messages: [
            ordinaryMessage(sessionID, "subagent-prompt", "user", "Investigate the issue"),
            ordinaryMessage(
                sessionID,
                "subagent-finding",
                "assistant",
                "I found the relevant code path",
            ),
            ordinaryMessage(
                sessionID,
                "subagent-followup",
                "user",
                "Please compress the initial findings",
            ),
        ],
    })
    await h.restart()
    const entry = await h.enter()
    assert.match(entry, /m0001/)
    assert.match(entry, /m0002/)
    assert.match(await stageBlock(h, "Captured the investigation and follow-up."), /stag/i)
    const recalled = await h.run("recall_compressed", { action: "get", messageId: "m0001" })
    assert.match(recalled, /I found the relevant code path/)
    assert.doesNotMatch(recalled, /Investigate the issue/)

    await h.leave()
    const context = visibleText(await h.render())
    assert.match(context, /Investigate the issue/)
    assert.match(context, /Captured the investigation and follow-up\./)
    assert.doesNotMatch(
        context,
        /I found the relevant code path|Please compress the initial findings/,
    )
    assert.ok(h.client.session.get.mock.callCount() >= 2)
    h.assertSessionReads()
})

test("compress range preserves protected prompt information in draft and committed summaries", async (t) => {
    const sessionID = "ses_range_protect_tag"
    const h = await createHousekeepingHarness(t, {
        mode: "range",
        messages: [
            ordinaryMessage(
                sessionID,
                "request",
                "user",
                "Investigate the release. <protect>Keep the npm publish token note.</protect>",
            ),
            ordinaryMessage(sessionID, "finding", "assistant", "I checked it"),
        ],
        configure(config) {
            config.compress.protectTags = true
        },
    })
    await h.enter()
    await stageBlock(h, "Captured release investigation.")
    const draft = await h.versions(1, 1)
    assert.match(
        draft,
        /The following protected prompt information was included in this conversation verbatim:/,
    )
    assert.match(draft, /Keep the npm publish token note\./)
    await h.leave()
    const context = visibleText(await h.render())
    assert.match(context, /Captured release investigation\./)
    assert.match(context, /Keep the npm publish token note\./)
    assert.doesNotMatch(context, /I checked it/)
    h.assertSessionReads()
})

test("compress range retains protected user text verbatim when publishing", async (t) => {
    const h = await createHousekeepingHarness(t, {
        mode: "range",
        configure(config) {
            config.compress.protectUserMessages = true
        },
    })
    await h.enter()
    await stageBlock(h)
    assert.match(
        await h.versions(1, 1),
        /The following user messages were sent in this conversation verbatim:/,
    )
    await h.leave()
    const context = visibleText(await h.render())
    assert.match(context, /Investigate the parser boundary\./)
    assert.match(context, /Parser findings\./)
    assert.doesNotMatch(context, /The parser accepts an empty record\./)
    h.assertSessionReads()
})

test("compress range batches notifications at leave rather than staging", async (t) => {
    const h = await createHousekeepingHarness(t, {
        mode: "range",
        configure(config) {
            config.pruneNotification = "detailed"
            config.pruneNotificationType = "toast"
        },
    })
    const showToast = t.mock.fn(async (_input: { body: { message: string } }) => {})
    Object.assign(h.client, { tui: { showToast } })
    await h.enter()
    assert.match(
        await h.run("compress", {
            topic: "Batch stale notes",
            content: [
                { startId: "m0001", endId: "m0001", summary: "Initial parser request." },
                { startId: "m0002", endId: "m0002", summary: "Empty records are accepted." },
            ],
        }),
        /stag/i,
    )
    assert.equal(showToast.mock.callCount(), 0)
    assert.match(await h.versions(1, 1), /Initial parser request\./)
    assert.match(await h.versions(2, 1), /Empty records are accepted\./)

    await h.leave()
    assert.equal(showToast.mock.callCount(), 1)
    const notification = showToast.mock.calls[0].arguments[0].body.message
    assert.match(notification, /▣ DCP \| -[^,\n]+ removed, \+[^\s\n]+ summary/)
    assert.match(notification, /Compression #1/)
    assert.match(notification, /Topic: Batch stale notes/)
    assert.match(notification, /Items: 2 messages/)
    const context = visibleText(await h.render())
    assert.match(context, /Initial parser request\./)
    assert.match(context, /Empty records are accepted\./)
    assert.doesNotMatch(
        context,
        /Investigate the parser boundary\.|The parser accepts an empty record\./,
    )
    h.assertSessionReads()
})

test("compress range rejects overlapping batches without losing earlier staged work", async (t) => {
    const h = await createHousekeepingHarness(t, { mode: "range" })
    await h.enter()
    await stageBlock(h, "Keep this staged parser summary.", "m0001", "m0001")
    await assert.rejects(
        h.run("compress", {
            topic: "Overlapping ranges",
            content: [
                { startId: "m0002", endId: "m0003", summary: "Rejected wider summary." },
                { startId: "m0003", endId: "m0004", summary: "Rejected overlapping summary." },
            ],
        }),
        /Overlapping ranges cannot be compressed in the same batch/,
    )
    assert.match(await h.versions(1, 1), /Keep this staged parser summary\./)
    await assert.rejects(h.versions(2), /block.*2.*not found/i)
    await h.leave()
    const context = visibleText(await h.render())
    assert.match(context, /Keep this staged parser summary\./)
    assert.match(context, /The parser accepts an empty record\./)
    assert.match(context, /Keep the newline constraint\./)
    assert.match(context, /Use the documented parser API\./)
    assert.doesNotMatch(context, /Rejected wider summary|Rejected overlapping summary/)
    h.assertSessionReads()
})

test("later range compression can consume a block created in the same draft", async (t) => {
    const h = await createHousekeepingHarness(t, { mode: "range" })
    await h.enter()
    await stageBlock(h, "Initial staged findings.")
    assert.match(
        await stageBlock(h, "Combined parser and newline findings.", "b1", "m0004"),
        /stag/i,
    )
    assert.match(await h.versions(2, 1), /Combined parser and newline findings\./)
    const staged = await h.render()
    assert.match(
        visibleText(staged.filter((message) => message.info.id === "source-1")),
        /Investigate the parser boundary\./,
    )
    assert.match(
        visibleText(staged.filter((message) => message.info.id === "source-4")),
        /Use the documented parser API\./,
    )
    await h.leave()
    const context = visibleText(await h.render())
    assert.match(context, /Combined parser and newline findings\./)
    assert.doesNotMatch(
        context,
        /Initial staged findings\.|Investigate the parser boundary\.|Use the documented parser API\./,
    )
    h.assertSessionReads()
})

for (const { startId, endId, error } of [
    { startId: "source-1", endId: "m0002", error: /startId.*invalid/i },
    { startId: "m0001", endId: "m9999", error: /m9999.*not available|m9999.*not found/i },
    { startId: "b999", endId: "m0004", error: /b999.*not available|b999.*not found/i },
    { startId: "m0004", endId: "m0002", error: /appears after|before end|reversed/i },
]) {
    test(`compress range rejects ${startId}..${endId} without partially staging its batch`, async (t) => {
        const h = await createHousekeepingHarness(t, { mode: "range" })
        await h.enter()
        await assert.rejects(
            h.run("compress", {
                topic: "Invalid boundaries",
                content: [
                    { startId: "m0001", endId: "m0001", summary: "Must not partially stage." },
                    { startId, endId, summary: "Invalid range summary." },
                ],
            }),
            error,
        )
        await assert.rejects(h.versions(), /block.*1.*not found/i)
        await h.leave()
        const context = visibleText(await h.render())
        assert.match(context, /Investigate the parser boundary\./)
        assert.match(context, /Use the documented parser API\./)
        assert.doesNotMatch(context, /Must not partially stage\.|Invalid range summary\./)
        h.assertSessionReads()
    })
}

test("range minimum-token rejection leaves the whole batch unstaged and permits a valid retry", async (t) => {
    const sessionID = "ses_range_min_tokens"
    const h = await createHousekeepingHarness(t, {
        mode: "range",
        messages: [
            ordinaryMessage(
                sessionID,
                "long-request",
                "user",
                "The parser accepts one record per line. ".repeat(100),
            ),
            ordinaryMessage(sessionID, "short-finding", "assistant", "Short finding."),
        ],
        configure(config) {
            config.compress.minCompressTokens = 100
        },
    })
    await h.enter()
    await assert.rejects(
        h.run("compress", {
            topic: "Minimum tokens",
            content: [
                { startId: "m0001", endId: "m0001", summary: "Rejected batch fragment." },
                { startId: "m0002", endId: "m0002", summary: "Too small." },
            ],
        }),
        /only.*tokens|small fragment/i,
    )
    await assert.rejects(h.versions(), /block.*1.*not found/i)
    assert.match(await stageBlock(h, "One record per line.", "m0001", "m0001"), /stag/i)
    await h.leave()
    const context = visibleText(await h.render())
    assert.match(context, /One record per line\./)
    assert.match(context, /Short finding\./)
    assert.doesNotMatch(
        context,
        /Rejected batch fragment\.|The parser accepts one record per line\./,
    )
    h.assertSessionReads()
})

test("range compression asks host permission with the session read arguments intact", async (t) => {
    const h = await createHousekeepingHarness(t, { mode: "range", permission: "ask" })
    await h.enter()
    const callsBefore = h.ask.mock.callCount()
    await stageBlock(h)
    assert.ok(h.ask.mock.callCount() > callsBefore)
    assert.deepEqual(h.ask.mock.calls[callsBefore].arguments[0], {
        permission: "compress",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
    })
    assert.deepEqual(h.client.session.messages.mock.calls.at(-1)?.arguments[0], {
        path: { id: h.sessionID },
    })
    await h.leave()
    h.assertSessionReads()
})

test("range compression preserves staged work after host permission rejection", async (t) => {
    const h = await createHousekeepingHarness(t, { mode: "range", permission: "ask" })
    await h.enter()
    await stageBlock(h, "Earlier allowed range summary.", "m0001", "m0001")
    const callsBefore = h.ask.mock.callCount()
    h.ask.mock.mockImplementationOnce(async () => {
        throw new Error("Host denied compression")
    })

    await assert.rejects(
        stageBlock(h, "Denied range summary.", "m0002", "m0002"),
        /Host denied compression/,
    )
    assert.deepEqual(h.ask.mock.calls[callsBefore].arguments[0], {
        permission: "compress",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
    })
    assert.match(await h.versions(1, 1), /Earlier allowed range summary\./)
    await assert.rejects(h.versions(2), /block.*2.*not found/i)

    assert.match(await stageBlock(h, "Successful retry range summary.", "m0003", "m0003"), /stag/i)
    await h.leave()
    const context = visibleText(await h.render())
    assert.match(context, /Earlier allowed range summary\./)
    assert.match(context, /Successful retry range summary\./)
    assert.doesNotMatch(context, /Denied range summary\./)
    h.assertSessionReads()
})

test("range minimum-token checks exclude a large completed housekeeping interior", async (t) => {
    const h = await createHousekeepingHarness(t, {
        mode: "range",
        configure(config) {
            config.compress.minCompressTokens = 1000
        },
    })
    await h.enter()
    h.addText("large-private-note", "Private maintenance investigation detail. ".repeat(1000))
    await h.leave()
    h.addText("source-5", "Small ordinary follow-up.", "user")
    await h.render()
    await h.enter()
    await assert.rejects(
        stageBlock(h, "Must remain unstaged.", "m0001", "m0005"),
        /only.*tokens|small fragment/i,
    )
    await assert.rejects(h.versions(), /block.*1.*not found/i)
    await h.leave()
    const context = visibleText(await h.render())
    assert.match(context, /Investigate the parser boundary\./)
    assert.match(context, /Small ordinary follow-up\./)
    assert.doesNotMatch(
        context,
        /Private maintenance investigation detail\.|Must remain unstaged\./,
    )
    h.assertSessionReads()
})

test("range compression across completed housekeeping excludes protected working content", async (t) => {
    const h = await createHousekeepingHarness(t, {
        mode: "range",
        configure(config) {
            config.compress.protectTags = true
            config.compress.protectUserMessages = true
        },
    })
    await h.enter()
    h.addText("private-user-note", "<protect>HOUSEKEEPING_PRIVATE_RANGE</protect>", "user")
    await h.leave()
    h.addText("source-5", "Outside after housekeeping.", "user")
    await h.render()
    await h.enter()
    await stageBlock(h, "Ordinary findings across the maintenance boundary.", "m0001", "m0005")
    const summary = await h.versions(1, 1)
    assert.match(summary, /Investigate the parser boundary\./)
    assert.match(summary, /Outside after housekeeping\./)
    assert.doesNotMatch(summary, /HOUSEKEEPING_PRIVATE_RANGE/)
    await h.leave()
    assert.doesNotMatch(visibleText(await h.render()), /HOUSEKEEPING_PRIVATE_RANGE/)
    h.assertSessionReads()
})
