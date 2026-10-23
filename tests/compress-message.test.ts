import "./helpers/storage-env"
import assert from "node:assert/strict"
import test from "node:test"
import { createCompressMessageTool } from "../lib/compress/message"
import type { WithParts } from "../lib/state"
import {
    createHousekeepingHarness,
    ordinaryMessage,
    stageBlock,
    visibleText,
} from "./helpers/housekeeping"

function toolMessage(sessionID: string, id: string, tool: string, output: string): WithParts {
    const message = ordinaryMessage(sessionID, id, "assistant", "I also ran a task tool")
    message.parts.push({
        id: `${id}-tool`,
        messageID: id,
        sessionID,
        type: "tool",
        tool,
        callID: `${id}-call`,
        state: {
            status: "completed",
            input: { description: "demo" },
            output,
            title: tool,
            metadata: {},
            time: { start: 1, end: 2 },
        },
    })
    return message
}

function entry(messageId: string, summary = "Captured the code-path findings.") {
    return { messageId, topic: "Code path note", summary }
}

test("compress message tool appends non-editable format extension", async (t) => {
    const h = await createHousekeepingHarness(t, { mode: "message" })
    const tool = createCompressMessageTool(h.ctx)
    assert.match(tool.description, /THE FORMAT OF COMPRESS/)
    assert.match(tool.description, /messageId: string/)
    assert.match(tool.description, /Raw message ID only: mNNNN/)
})

test("compress message requires housekeeping entry before staging", async (t) => {
    const h = await createHousekeepingHarness(t, { mode: "message" })
    await assert.rejects(
        stageBlock(h),
        /enter_housekeeping|enter.*housekeeping|housekeeping.*mode/i,
    )
    assert.match(visibleText(await h.render()), /Investigate the parser boundary\./)
    await assert.rejects(h.versions(), /block.*1.*not found/i)
    await h.enter()
    assert.match(await stageBlock(h), /stag/i)
    await h.leave()
    assert.match(visibleText(await h.render()), /Parser findings\./)
    h.assertSessionReads()
})

test("compress message appends protected prompt information to the staged summary", async (t) => {
    const sessionID = "ses_message_protect_tag"
    const h = await createHousekeepingHarness(t, {
        mode: "message",
        messages: [
            ordinaryMessage(
                sessionID,
                "request",
                "user",
                "Investigate the issue. <protect>Always preserve release checklist.</protect>",
            ),
        ],
        configure(config) {
            config.compress.protectTags = true
        },
    })
    await h.enter()
    await stageBlock(h, "Captured the investigation request.")
    const summary = await h.versions(1, 1)
    assert.match(
        summary,
        /The following protected prompt information was included in this conversation verbatim:/,
    )
    assert.match(summary, /Always preserve release checklist\./)
    await h.leave()
    const context = visibleText(await h.render())
    assert.match(context, /Captured the investigation request\./)
    assert.match(context, /Always preserve release checklist\./)
    assert.doesNotMatch(context, /Investigate the issue\./)
    h.assertSessionReads()
})

test("compress message ignores protected tags on ignored user notifications", async (t) => {
    const sessionID = "ses_message_ignored_tag"
    const ignored = ordinaryMessage(
        sessionID,
        "ignored",
        "user",
        "Ignored notification. <protect>Do not preserve ignored note.</protect>",
    )
    Object.assign(ignored.parts[0], { ignored: true })
    const h = await createHousekeepingHarness(t, {
        mode: "message",
        messages: [
            ordinaryMessage(sessionID, "request", "user", "Investigate the issue"),
            ignored,
            ordinaryMessage(sessionID, "finding", "assistant", "I mapped the code path"),
        ],
        configure(config) {
            config.compress.protectTags = true
        },
    })
    await h.enter()
    await h.run("compress", { topic: "Ignored notification", content: [entry("m0002")] })
    const summary = await h.versions(1, 1)
    assert.match(summary, /Captured the code-path findings\./)
    assert.doesNotMatch(summary, /protected prompt information|Do not preserve ignored note\./)
    const recalled = await h.run("recall_compressed", { action: "get", messageId: "m0002" })
    assert.match(recalled, /I mapped the code path/)
    assert.doesNotMatch(recalled, /Ignored notification/)
    await h.leave()
    assert.doesNotMatch(await h.versions(1, 1), /Do not preserve ignored note\./)
    h.assertSessionReads()
})

test("compress message retries the same host call without creating another staged block", async (t) => {
    const h = await createHousekeepingHarness(t, { mode: "message" })
    await h.enter()
    const args = { topic: "Retry code path", content: [entry("m0002")] }
    const identity = { messageID: "compression-retry", callID: "compression-call" }
    const receipt = await h.run("compress", args, identity)
    assert.match(receipt, /stag/i)
    assert.equal(await h.run("compress", args, identity), receipt)
    assert.match(await h.versions(1, 1), /Captured the code-path findings\./)
    await assert.rejects(h.versions(2), /block.*2.*not found/i)
    await h.leave()
    const context = visibleText(await h.render())
    assert.equal(context.match(/Captured the code-path findings\./g)?.length, 1)
    assert.doesNotMatch(context, /The parser accepts an empty record\./)
    h.assertSessionReads()
})

test("compress message does not partially stage when host preparation fails", async (t) => {
    const h = await createHousekeepingHarness(t, { mode: "message" })
    await h.enter()
    await stageBlock(h, "Earlier successful staged summary.")
    h.client.session.messages.mock.mockImplementationOnce(async () => {
        throw new Error("session messages unavailable")
    })
    await assert.rejects(
        h.run("compress", {
            topic: "Unavailable transcript",
            content: [entry("m0002", "Failed first item."), entry("m0004", "Failed second item.")],
        }),
        /session messages unavailable/,
    )
    assert.match(await h.versions(1, 1), /Earlier successful staged summary\./)
    await assert.rejects(h.versions(2), /block.*2.*not found/i)
    await h.leave()
    const context = visibleText(await h.render())
    assert.match(context, /Earlier successful staged summary\./)
    assert.match(context, /The parser accepts an empty record\./)
    assert.match(context, /Use the documented parser API\./)
    assert.doesNotMatch(context, /Failed first item\.|Failed second item\./)
    h.assertSessionReads()
})

test("compress message rejects compressed block IDs without losing a draft block", async (t) => {
    const h = await createHousekeepingHarness(t, { mode: "message" })
    await h.enter()
    await stageBlock(h)
    await assert.rejects(
        h.run("compress", {
            topic: "Reject block IDs",
            content: [entry("b1", "Rejected block target.")],
        }),
        /Unable to compress any messages\. Found 1 issue:/,
    )
    assert.match(await h.versions(1, 1), /Parser findings\./)
    await assert.rejects(h.versions(2), /block.*2.*not found/i)
    await h.leave()
    assert.doesNotMatch(visibleText(await h.render()), /Rejected block target\./)
    h.assertSessionReads()
})

test("compress message skips protected user references while staging valid assistant entries", async (t) => {
    const h = await createHousekeepingHarness(t, {
        mode: "message",
        configure(config) {
            config.compress.protectUserMessages = true
        },
    })
    await h.enter()
    const receipt = await h.run("compress", {
        topic: "Protected user entries",
        content: [
            entry("BLOCKED", "Rejected protected marker."),
            entry("m0001", "Rejected hidden user reference."),
            entry("m0002"),
        ],
    })
    assert.match(receipt, /stag/i)
    assert.match(receipt, /Skipped 2 issues:/)
    assert.match(receipt, /tagged with `BLOCKED` are protected/)
    assert.match(receipt, /messageId m0001 refers to a protected message/)
    assert.match(await h.versions(1, 1), /Captured the code-path findings\./)
    await assert.rejects(h.versions(2), /block.*2.*not found/i)
    await h.leave()
    const context = visibleText(await h.render())
    assert.match(context, /Investigate the parser boundary\./)
    assert.match(context, /Captured the code-path findings\./)
    assert.doesNotMatch(
        context,
        /The parser accepts an empty record\.|Rejected protected marker\.|Rejected hidden user reference\./,
    )
    h.assertSessionReads()
})

test("compress message supports historical compress tool parts outside housekeeping boundaries", async (t) => {
    const sessionID = "ses_message_legacy_compress"
    const h = await createHousekeepingHarness(t, {
        mode: "message",
        messages: [
            ordinaryMessage(sessionID, "request", "user", "Investigate the issue"),
            toolMessage(
                sessionID,
                "legacy-compression",
                "compress",
                "Historical compression result.",
            ),
        ],
    })
    await h.enter()
    assert.match(
        await h.run("compress", {
            topic: "Historical tool message",
            content: [entry("m0002", "Captured the historical compression call.")],
        }),
        /stag/i,
    )
    await h.leave()
    const context = visibleText(await h.render())
    assert.match(context, /Captured the historical compression call\./)
    assert.doesNotMatch(context, /Historical compression result\./)
    h.assertSessionReads()
})

test("compress message sends one aggregated notification only after leave", async (t) => {
    const h = await createHousekeepingHarness(t, {
        mode: "message",
        configure(config) {
            config.pruneNotification = "detailed"
            config.pruneNotificationType = "toast"
        },
    })
    const showToast = t.mock.fn(async (_input: { body: { message: string } }) => {})
    Object.assign(h.client, { tui: { showToast } })
    await h.enter()
    await h.run("compress", {
        topic: "Batch stale notes",
        content: [entry("m0002"), entry("m0004", "Captured the documented API.")],
    })
    assert.equal(showToast.mock.callCount(), 0)
    await h.leave()
    assert.equal(showToast.mock.callCount(), 1)
    const notification = showToast.mock.calls[0].arguments[0].body.message
    assert.match(notification, /▣ DCP \| -[^,\n]+ removed, \+[^\s\n]+ summary/)
    assert.match(notification, /Compression #1/)
    assert.match(notification, /Topic: Batch stale notes/)
    assert.match(notification, /Items: 2 messages/)
    assert.match(await h.versions(2, 1), /Captured the documented API\./)
    h.assertSessionReads()
})

test("compress message skips messages already covered by earlier staged compression", async (t) => {
    const h = await createHousekeepingHarness(t, { mode: "message" })
    await h.enter()
    await h.run("compress", { topic: "First pass", content: [entry("m0002")] })
    const receipt = await h.run("compress", {
        topic: "Second pass",
        content: [
            entry("m0002", "Rejected repeated summary."),
            entry("m0004", "Captured the documented API."),
        ],
    })
    assert.match(receipt, /stag/i)
    assert.match(receipt, /Skipped 1 issue:/)
    assert.match(receipt, /messageId m0002 is already part of an active compression\./)
    assert.match(await h.versions(1, 1), /Captured the code-path findings\./)
    assert.match(await h.versions(2, 1), /Captured the documented API\./)
    await assert.rejects(h.versions(3), /block.*3.*not found/i)
    await h.leave()
    const context = visibleText(await h.render())
    assert.match(context, /Captured the code-path findings\./)
    assert.match(context, /Captured the documented API\./)
    assert.doesNotMatch(
        context,
        /Rejected repeated summary\.|The parser accepts an empty record\.|Use the documented parser API\./,
    )
    h.assertSessionReads()
})

test("compress message skips invalid batch entries and reports each issue", async (t) => {
    const h = await createHousekeepingHarness(t, { mode: "message" })
    await h.enter()
    const receipt = await h.run("compress", {
        topic: "Mixed entries",
        content: [
            entry("b1", "Rejected block ID."),
            entry("m0002"),
            entry("m9999", "Rejected missing reference."),
            entry("m0002", "Rejected duplicate."),
        ],
    })
    assert.match(receipt, /stag/i)
    assert.match(receipt, /Skipped 3 issues:/)
    assert.match(receipt, /Block IDs like bN are not allowed/)
    assert.match(receipt, /messageId m9999 is not available in the current conversation context/)
    assert.match(receipt, /messageId m0002 was selected more than once in this batch\./)
    assert.match(await h.versions(1, 1), /Captured the code-path findings\./)
    await assert.rejects(h.versions(2), /block.*2.*not found/i)
    await h.leave()
    const context = visibleText(await h.render())
    assert.match(context, /Captured the code-path findings\./)
    assert.match(context, /Use the documented parser API\./)
    assert.doesNotMatch(
        context,
        /Rejected block ID\.|Rejected missing reference\.|Rejected duplicate\./,
    )
    h.assertSessionReads()
})

test("compress message reports all-invalid batches and can subsequently stage successfully", async (t) => {
    const h = await createHousekeepingHarness(t, { mode: "message" })
    await h.enter()
    await assert.rejects(
        h.run("compress", {
            topic: "All invalid",
            content: [entry("b1"), entry("m9999")],
        }),
        /Unable to compress any messages\. Found 2 issues:/,
    )
    await assert.rejects(h.versions(), /block.*1.*not found/i)
    await stageBlock(h, "Valid retry summary.")
    await h.leave()
    assert.match(visibleText(await h.render()), /Valid retry summary\./)
    h.assertSessionReads()
})

test("compress message minimum-token checks skip only undersized entries", async (t) => {
    const sessionID = "ses_message_min_tokens"
    const h = await createHousekeepingHarness(t, {
        mode: "message",
        messages: [
            ordinaryMessage(sessionID, "request", "user", "Investigate the parser."),
            ordinaryMessage(
                sessionID,
                "long-finding",
                "assistant",
                "The parser accepts one record per line. ".repeat(100),
            ),
            ordinaryMessage(sessionID, "short-finding", "assistant", "Short finding."),
        ],
        configure(config) {
            config.compress.minCompressTokens = 100
        },
    })
    await h.enter()
    const receipt = await h.run("compress", {
        topic: "Minimum tokens",
        content: [entry("m0002", "One record per line."), entry("m0003", "Rejected short item.")],
    })
    assert.match(receipt, /stag/i)
    assert.match(receipt, /Skipped 1 issue:/)
    assert.match(receipt, /m0003.*too small/i)
    assert.match(await h.versions(1, 1), /One record per line\./)
    await assert.rejects(h.versions(2), /block.*2.*not found/i)
    await h.leave()
    const context = visibleText(await h.render())
    assert.match(context, /One record per line\./)
    assert.match(context, /Short finding\./)
    assert.doesNotMatch(context, /Rejected short item\.|The parser accepts one record per line\./)
    h.assertSessionReads()
})

test("compress message preserves the draft when host permission is denied", async (t) => {
    const h = await createHousekeepingHarness(t, { mode: "message", permission: "ask" })
    await h.enter()
    await stageBlock(h, "Earlier allowed summary.")
    const callsBefore = h.ask.mock.callCount()
    h.ask.mock.mockImplementationOnce(async () => {
        throw new Error("Host denied compression")
    })
    await assert.rejects(
        h.run("compress", {
            topic: "Denied request",
            content: [entry("m0002", "Denied summary.")],
        }),
        /Host denied compression/,
    )
    assert.deepEqual(h.ask.mock.calls[callsBefore].arguments[0], {
        permission: "compress",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
    })
    assert.match(await h.versions(1, 1), /Earlier allowed summary\./)
    await assert.rejects(h.versions(2), /block.*2.*not found/i)
    await h.leave()
    const context = visibleText(await h.render())
    assert.match(context, /Earlier allowed summary\./)
    assert.match(context, /The parser accepts an empty record\./)
    assert.doesNotMatch(context, /Denied summary\./)
    h.assertSessionReads()
})

test("message compression cannot assign aliases to housekeeping working messages", async (t) => {
    const h = await createHousekeepingHarness(t, { mode: "message" })
    await h.enter()
    h.addText("working-note", "PRIVATE_MESSAGE_WORKING_NOTE")
    await h.render()
    await assert.rejects(
        h.run("compress", { topic: "Ineligible working note", content: [entry("m0005")] }),
        /not available|not found/i,
    )
    await h.leave()
    h.addText("source-5", "Ordinary message after maintenance.", "user")
    await h.render()
    await h.enter()
    const recalled = await h.run("recall_compressed", { action: "get", messageId: "m0005" })
    assert.match(recalled, /Ordinary message after maintenance\./)
    assert.doesNotMatch(recalled, /PRIVATE_MESSAGE_WORKING_NOTE/)
    assert.match(
        await h.run("compress", {
            topic: "Ordinary follow-up",
            content: [entry("m0005", "Post-maintenance findings.")],
        }),
        /stag/i,
    )
    await h.leave()
    const context = visibleText(await h.render())
    assert.match(context, /Post-maintenance findings\./)
    assert.doesNotMatch(
        context,
        /PRIVATE_MESSAGE_WORKING_NOTE|Ordinary message after maintenance\./,
    )
    h.assertSessionReads()
})
