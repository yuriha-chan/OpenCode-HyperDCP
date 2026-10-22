import "./helpers/storage-env"
import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import { assignMessageRefs } from "../lib/message-ids"
import { checkSession, createSessionState, type WithParts } from "../lib/state"
import { createHousekeepingHarness, ordinaryMessage, visibleText } from "./helpers/housekeeping"

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function buildCompactedMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-assistant-summary",
                role: "assistant",
                sessionID,
                agent: "assistant",
                summary: true,
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-assistant-summary",
                    sessionID,
                    "msg-assistant-summary-part",
                    "Compaction summary",
                ),
            ],
        },
        {
            info: {
                id: "msg-user-follow-up",
                role: "user",
                sessionID,
                agent: "assistant",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-follow-up",
                    sessionID,
                    "msg-user-follow-up-part",
                    "Continue after compaction",
                ),
            ],
        },
    ]
}

test("checkSession resets message id aliases after native compaction", async () => {
    const sessionID = `ses_message_ids_after_compaction_${Date.now()}`
    const messages = buildCompactedMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)

    state.sessionId = sessionID
    state.messageIds.byRawId.set("old-message-1", "m0001")
    state.messageIds.byRawId.set("old-message-2", "m0002")
    state.messageIds.byRef.set("m0001", "old-message-1")
    state.messageIds.byRef.set("m0002", "old-message-2")
    state.messageIds.nextRef = 3

    await checkSession({} as any, state, logger, messages, false)

    // After compaction: messageIds preserved, summaries disabled
    assert.equal(state.lastCompaction, 2)
    assert.equal(state.messageIds.byRawId.size, 2)
    assert.equal(state.messageIds.byRef.size, 2)
    assert.equal(state.messageIds.nextRef, 3)

    const assigned = assignMessageRefs(state, messages)

    assert.equal(assigned, 2)
    assert.equal(state.messageIds.byRawId.get("msg-assistant-summary"), "m0003")
    assert.equal(state.messageIds.byRawId.get("msg-user-follow-up"), "m0004")
    assert.equal(state.messageIds.byRef.get("m0003"), "msg-assistant-summary")
    assert.equal(state.messageIds.byRef.get("m0004"), "msg-user-follow-up")
    assert.equal(state.messageIds.nextRef, 5)
})

const referenceTag = /<dcp-message-id\b[^>]*>(m\d{4})<\/dcp-message-id>/
const injectedTag = /<dcp-message-id\b[^>]*>(?:m\d{4}|BLOCKED)<\/dcp-message-id>/

function modelReference(messages: WithParts[], messageID: string): string {
    const message = messages.find((message) => message.info.id === messageID)
    assert.ok(message, `expected ordinary model message ${messageID}`)
    const match = visibleText([message]).match(referenceTag)
    assert.ok(match, `expected an ordinary reference tag for ${messageID}`)
    return match[1]!
}

test("housekeeping allocates no references or tags and never backfills interiors or control calls", async (t) => {
    const h = await createHousekeepingHarness(t)
    const initial = await h.render()
    const ordinaryRefs = ["source-1", "source-2", "source-3", "source-4"].map(
        (id) => [id, modelReference(initial, id)] as const,
    )
    assert.deepEqual(
        ordinaryRefs.map(([, ref]) => ref),
        ["m0001", "m0002", "m0003", "m0004"],
    )

    h.addText("mixed-reference-message", "Ordinary prefix with a stable reference.")
    assert.equal(modelReference(await h.render(), "mixed-reference-message"), "m0005")
    const mixed = h.history.at(-1)!
    await h.run("enter_housekeeping", {}, { messageID: mixed.info.id, callID: "refs-enter" })
    mixed.parts.push({
        id: "mixed-internal-text",
        messageID: mixed.info.id,
        sessionID: h.sessionID,
        type: "text",
        text: "Private reference work in a mixed host message.",
    })
    await h.run("read_memo", {}, { messageID: mixed.info.id, callID: "refs-read" })
    h.addText("interior-reference-message", "Private reference work in an interior-only message.")
    assert.equal(assignMessageRefs(h.ctx.state, h.history), 0)
    assert.equal(
        assignMessageRefs(h.ctx.state, [
            ordinaryMessage(h.sessionID, "unseen-reference-probe", "assistant", "Unseen probe."),
        ]),
        0,
    )
    const active = await h.render()
    assert.match(visibleText(active), /Private reference work/)
    assert.doesNotMatch(visibleText(active), injectedTag)

    await h.leave()
    h.addText("ordinary-after-leave", "Ordinary work resumes.")
    const completed = await h.render()
    assert.doesNotMatch(visibleText(completed), /Private reference work/)
    for (const [id, ref] of ordinaryRefs) {
        assert.equal(modelReference(completed, id), ref)
    }
    assert.equal(modelReference(completed, mixed.info.id), "m0005")
    assert.equal(modelReference(completed, "ordinary-after-leave"), "m0006")
    assert.equal(assignMessageRefs(h.ctx.state, h.history), 0)
    const mixedModel = completed.find((message) => message.info.id === mixed.info.id)!
    assert.ok(!mixedModel.parts.some((part) => part.id === "mixed-internal-text"))
    for (const part of completed.flatMap((message) => message.parts)) {
        if (part.type === "tool" && part.state.status === "completed") {
            assert.doesNotMatch(part.state.output, injectedTag)
        }
    }

    const nextGuidance = await h.enter()
    assert.doesNotMatch(nextGuidance, /Private reference work|interior-reference-message|refs-read/)
    assert.equal(assignMessageRefs(h.ctx.state, h.history), 0)
    const nextActive = await h.render()
    assert.doesNotMatch(visibleText(nextActive), injectedTag)
    assert.doesNotMatch(visibleText(nextActive), /Private reference work/)
    await h.leave()
    h.addText("ordinary-after-second-leave", "Continue with stable ordinary references.")
    const resumed = await h.render()
    assert.equal(modelReference(resumed, "ordinary-after-second-leave"), "m0007")
    assert.equal(modelReference(resumed, "ordinary-after-leave"), "m0006")
    assert.equal(assignMessageRefs(h.ctx.state, h.history), 0)
    h.assertSessionReads()
})

test("entry prepares missing preceding ordinary references without assigning its own interaction", async (t) => {
    const h = await createHousekeepingHarness(t)
    h.addText("ordinary-not-yet-rendered", "Ordinary text added immediately before entry.")
    const guidance = await h.enter()
    assert.match(guidance, /m0005/)
    assert.equal(assignMessageRefs(h.ctx.state, h.history), 0)
    assert.doesNotMatch(visibleText(await h.render()), injectedTag)

    await h.leave()
    h.addText("ordinary-next", "The next ordinary message.")
    const projected = await h.render()
    assert.equal(modelReference(projected, "ordinary-not-yet-rendered"), "m0005")
    assert.equal(modelReference(projected, "ordinary-next"), "m0006")
    assert.equal(assignMessageRefs(h.ctx.state, h.history), 0)
    h.assertSessionReads()
})
