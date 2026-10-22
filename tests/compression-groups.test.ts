import assert from "node:assert/strict"
import test from "node:test"
import { createHousekeepingHarness, visibleText } from "./helpers/housekeeping"

test("compression notifications increment by tool call across range and message modes", async (t) => {
    for (const mode of ["range", "message"] as const) {
        await t.test(mode, async (t) => {
            const h = await createHousekeepingHarness(t, {
                mode,
                configure(config) {
                    config.pruneNotification = "detailed"
                    config.pruneNotificationType = "toast"
                },
            })
            const showToast = t.mock.fn(async (_input: { body: { message: string } }) => {})
            Object.assign(h.client, { tui: { showToast } })
            for (const [index, reference] of ["m0001", "m0002"].entries()) {
                await h.enter()
                const content =
                    mode === "range"
                        ? [
                              {
                                  startId: reference,
                                  endId: reference,
                                  summary: `Summary ${index + 1}.`,
                              },
                          ]
                        : [
                              {
                                  messageId: reference,
                                  topic: `Topic ${index + 1}`,
                                  summary: `Summary ${index + 1}.`,
                              },
                          ]
                assert.match(
                    await h.run("compress", {
                        topic: `Batch ${index + 1}`,
                        content,
                    }),
                    /stag/i,
                )
                assert.equal(showToast.mock.callCount(), index)
                const stagedContext = visibleText(await h.render())
                assert.doesNotMatch(stagedContext, new RegExp(`Summary ${index + 1}\\.`))
                await h.leave()
                assert.equal(showToast.mock.callCount(), index + 1)
                assert.match(
                    showToast.mock.calls[index].arguments[0].body.message,
                    new RegExp(`Compression #${index + 1}`),
                )
            }
            h.assertSessionReads()
        })
    }
})

test("compression notifications increment across range then message tools in one session", async (t) => {
    const rangeHarness = await createHousekeepingHarness(t, {
        mode: "range",
        configure(config) {
            config.pruneNotification = "detailed"
            config.pruneNotificationType = "toast"
        },
    })
    const showToast = t.mock.fn(async (_input: { body: { message: string } }) => {})
    Object.assign(rangeHarness.client, { tui: { showToast } })

    await rangeHarness.enter()
    assert.match(
        await rangeHarness.run("compress", {
            topic: "Range note",
            content: [{ startId: "m0001", endId: "m0001", summary: "Range summary." }],
        }),
        /stag/i,
    )
    assert.equal(showToast.mock.callCount(), 0)
    assert.doesNotMatch(visibleText(await rangeHarness.render()), /Range summary\./)
    const rangeReceipt = await rangeHarness.leave()
    assert.match(rangeReceipt, /committed b\d+ v\d+/i)
    assert.equal(showToast.mock.callCount(), 1)
    assert.match(showToast.mock.calls[0].arguments[0].body.message, /Compression #1/)

    const messageHarness = await createHousekeepingHarness(t, {
        mode: "message",
        messages: structuredClone(rangeHarness.history),
        configure(config) {
            config.pruneNotification = "detailed"
            config.pruneNotificationType = "toast"
        },
    })
    assert.equal(messageHarness.sessionID, rangeHarness.sessionID)
    messageHarness.ctx.state = rangeHarness.ctx.state
    Object.assign(messageHarness.client, { tui: { showToast } })

    await messageHarness.run(
        "enter_housekeeping",
        {},
        {
            callID: "message-phase-enter",
            messageID: "message-phase-entry",
        },
    )
    assert.match(
        await messageHarness.run(
            "compress",
            {
                topic: "Message note",
                content: [
                    { messageId: "m0002", topic: "Message note", summary: "Message summary." },
                ],
            },
            { callID: "message-phase-compress", messageID: "message-phase-compression" },
        ),
        /stag/i,
    )
    assert.equal(showToast.mock.callCount(), 1)
    assert.doesNotMatch(visibleText(await messageHarness.render()), /Message summary\./)
    const messageReceipt = await messageHarness.run(
        "leave_housekeeping",
        {},
        { callID: "message-phase-leave", messageID: "message-phase-exit" },
    )
    assert.match(messageReceipt, /committed b\d+ v\d+/i)
    assert.equal(showToast.mock.callCount(), 2)
    assert.match(showToast.mock.calls[1].arguments[0].body.message, /Compression #2/)
    rangeHarness.assertSessionReads()
})

test("decompress groups and recompresses batched message compressions by tool call", async (t) => {
    const h = await createHousekeepingHarness(t, { mode: "message" })
    await h.enter()
    assert.match(
        await h.run("compress", {
            topic: "Batch stale notes",
            content: [
                {
                    messageId: "m0002",
                    topic: "Code path note",
                    summary: "Captured the assistant code-path findings.",
                },
                {
                    messageId: "m0003",
                    topic: "Task output note",
                    summary: "Captured the assistant task-backed follow-up.",
                },
            ],
        }),
        /stag/i,
    )
    const stagedContext = visibleText(await h.render())
    assert.match(stagedContext, /The parser accepts an empty record\./)
    assert.match(stagedContext, /Keep the newline constraint\./)
    assert.match(stagedContext, /Use the documented parser API\./)
    assert.doesNotMatch(stagedContext, /Captured the assistant code-path findings\./)
    assert.doesNotMatch(stagedContext, /Captured the assistant task-backed follow-up\./)
    await h.leave()

    const committedContext = visibleText(await h.render())
    assert.match(committedContext, /Captured the assistant code-path findings\./)
    assert.match(committedContext, /Captured the assistant task-backed follow-up\./)
    assert.doesNotMatch(committedContext, /The parser accepts an empty record\./)
    assert.doesNotMatch(committedContext, /Keep the newline constraint\./)
    assert.match(committedContext, /Use the documented parser API\./)

    let promptCount = h.client.session.prompt.mock.callCount()
    await h.command("decompress")
    assert.equal(h.client.session.prompt.mock.callCount(), ++promptCount)
    const groupedList = h.client.session.prompt.mock.calls.at(-1)?.arguments[0].body as {
        parts: Array<{ text: string }>
    }
    assert.match(
        groupedList.parts[0]?.text ?? "",
        /Compression #1 - 2 messages - Batch stale notes/,
    )
    assert.doesNotMatch(groupedList.parts[0]?.text ?? "", /Code path note/)

    await h.command("decompress 1")
    assert.equal(h.client.session.prompt.mock.callCount(), ++promptCount)
    const decompressedMessage = h.client.session.prompt.mock.calls.at(-1)?.arguments[0].body as {
        parts: Array<{ text: string }>
    }
    assert.match(decompressedMessage.parts[0]?.text ?? "", /Restored compression 1\./)
    const restoredContext = visibleText(await h.render())
    assert.match(restoredContext, /The parser accepts an empty record\./)
    assert.match(restoredContext, /Keep the newline constraint\./)
    assert.match(restoredContext, /Use the documented parser API\./)
    assert.doesNotMatch(restoredContext, /Captured the assistant code-path findings\./)
    assert.doesNotMatch(restoredContext, /Captured the assistant task-backed follow-up\./)

    await h.command("recompress 1")
    assert.equal(h.client.session.prompt.mock.callCount(), ++promptCount)
    const recompressedMessage = h.client.session.prompt.mock.calls.at(-1)?.arguments[0].body as {
        parts: Array<{ text: string }>
    }
    assert.match(recompressedMessage.parts[0]?.text ?? "", /Re-applied compression 1\./)
    const recompressedContext = visibleText(await h.render())
    assert.match(recompressedContext, /Captured the assistant code-path findings\./)
    assert.match(recompressedContext, /Captured the assistant task-backed follow-up\./)
    assert.doesNotMatch(recompressedContext, /The parser accepts an empty record\./)
    assert.doesNotMatch(recompressedContext, /Keep the newline constraint\./)
    assert.match(recompressedContext, /Use the documented parser API\./)
    h.assertSessionReads()
})

test("decompress keeps batched ranges individually restorable", async (t) => {
    const h = await createHousekeepingHarness(t, { mode: "range" })
    await h.enter()
    assert.match(
        await h.run("compress", {
            topic: "Batch stale notes",
            content: [
                {
                    startId: "m0001",
                    endId: "m0001",
                    summary: "Captured the opening user request.",
                },
                {
                    startId: "m0002",
                    endId: "m0002",
                    summary: "Captured the assistant code-path findings.",
                },
            ],
        }),
        /stag/i,
    )
    const stagedContext = visibleText(await h.render())
    assert.match(stagedContext, /Investigate the parser boundary\./)
    assert.match(stagedContext, /The parser accepts an empty record\./)
    assert.doesNotMatch(stagedContext, /Captured the opening user request\./)
    assert.doesNotMatch(stagedContext, /Captured the assistant code-path findings\./)
    await h.leave()

    const committedContext = visibleText(await h.render())
    assert.match(committedContext, /Captured the opening user request\./)
    assert.match(committedContext, /Captured the assistant code-path findings\./)
    assert.doesNotMatch(committedContext, /Investigate the parser boundary\./)
    assert.doesNotMatch(committedContext, /The parser accepts an empty record\./)

    let promptCount = h.client.session.prompt.mock.callCount()
    await h.command("decompress")
    assert.equal(h.client.session.prompt.mock.callCount(), ++promptCount)
    const availableRanges = h.client.session.prompt.mock.calls.at(-1)?.arguments[0].body as {
        parts: Array<{ text: string }>
    }
    assert.match(
        availableRanges.parts[0]?.text ?? "",
        /1 \(.+\)\s+Compression #1 - Batch stale notes/,
    )
    assert.match(
        availableRanges.parts[0]?.text ?? "",
        /2 \(.+\)\s+Compression #1 - Batch stale notes/,
    )

    await h.command("decompress 1")
    assert.equal(h.client.session.prompt.mock.callCount(), ++promptCount)
    const decompressedRange = h.client.session.prompt.mock.calls.at(-1)?.arguments[0].body as {
        parts: Array<{ text: string }>
    }
    assert.match(decompressedRange.parts[0]?.text ?? "", /Restored compression 1\./)
    const oneRestored = visibleText(await h.render())
    assert.match(oneRestored, /Investigate the parser boundary\./)
    assert.match(oneRestored, /Captured the assistant code-path findings\./)
    assert.doesNotMatch(oneRestored, /Captured the opening user request\./)
    assert.doesNotMatch(oneRestored, /The parser accepts an empty record\./)
    h.assertSessionReads()
})
