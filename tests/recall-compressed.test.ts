import "./helpers/storage-env"
import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { normalizeNativeHistory } from "../lib/native-session"
import {
    createHousekeepingHarness,
    ordinaryMessage,
    stageBlock,
    visibleText,
    type HousekeepingHarness,
} from "./helpers/housekeeping"

test("v2 synthetic reports remain separate original sources for recall", async (t) => {
    const sessionID = "ses_synthetic_recall"
    const native = [
        {
            id: "msg_report_1",
            type: "synthetic",
            text: "Found parser bug",
            description: "Child finished",
            time: { created: 1 },
        },
        {
            id: "msg_report_2",
            type: "synthetic",
            text: "Fixed parser bug",
            description: "Child finished again",
            time: { created: 2 },
        },
    ]
    const original = structuredClone(native)
    const messages = normalizeNativeHistory(native, sessionID)
    assert.deepEqual(
        messages.map((message) => message.info.id),
        native.map((message) => message.id),
    )
    const h = await createHousekeepingHarness(t, { messages })
    const first = await h.run("recall_compressed", { action: "get", messageId: "m0001" })
    const second = await h.run("recall_compressed", { action: "get", messageId: "m0002" })
    assert.match(first, /Found parser bug/)
    assert.doesNotMatch(first, /Fixed parser bug|Child finished/)
    assert.match(second, /Fixed parser bug/)
    assert.doesNotMatch(second, /Found parser bug|Child finished/)
    assert.deepEqual(native, original)
})

for (const kind of ["inline", "uri"] as const) {
    test(`v2 ${kind} plain-text attachments remain readable original recall sources`, async (t) => {
        const files = [
            {
                mime: "text/plain",
                data: Buffer.from("Attachment parser finding: λ accepts empty records.").toString(
                    "base64",
                ),
                source:
                    kind === "inline"
                        ? { type: "inline" as const }
                        : { type: "uri" as const, uri: "file:///project/notes.txt" },
                ...(kind === "inline" ? { name: "notes.txt", description: "Parser evidence" } : {}),
            },
        ]
        if (kind === "inline")
            files.push({
                mime: "text/plain",
                data: "",
                source: { type: "inline" },
                name: "empty.txt",
            })
        const native = [
            { id: "msg_attached_note", type: "user", text: "Review the attached note.", files },
        ]
        const original = structuredClone(native)
        const h = await createHousekeepingHarness(t, {
            messages: normalizeNativeHistory(native, `ses_attachment_${kind}`),
        })
        const result = await h.run("recall_compressed", { action: "get", messageId: "m0001" })
        assert.match(result, /Review the attached note\./)
        assert.match(result, /Attachment parser finding: λ accepts empty records\./)
        assert.ok(
            result.includes(
                `Attached file: ${kind === "inline" ? "notes.txt" : "file:///project/notes.txt"}`,
            ),
        )
        if (kind === "inline") {
            assert.match(result, /Description: Parser evidence/)
            assert.match(result, /Attached file: empty\.txt/)
        }
        assert.deepEqual(native, original)
    })
}

for (const kind of ["uri", "inline"] as const) {
    test(`v2 ${kind} directory attachments remain readable original recall sources`, async (t) => {
        const native = [
            {
                id: "msg_attached_directory",
                type: "user",
                text: "Review this directory.",
                files: [
                    {
                        mime: "application/x-directory",
                        data: Buffer.from("parser.ts\nλ.test.ts").toString("base64"),
                        source:
                            kind === "uri"
                                ? { type: "uri" as const, uri: "file:///project/parser%20fixtures" }
                                : { type: "inline" as const },
                        name: "fixtures",
                        description: "Parser examples",
                    },
                    {
                        mime: "application/x-directory",
                        data: "",
                        source: { type: "inline" as const },
                    },
                ],
            },
        ]
        const original = structuredClone(native)
        const h = await createHousekeepingHarness(t, {
            messages: normalizeNativeHistory(native, `ses_directory_${kind}`),
        })
        const result = await h.run("recall_compressed", { action: "get", messageId: "m0001" })
        assert.match(result, /Review this directory\./)
        assert.ok(
            result.includes(
                `Attached directory: ${kind === "uri" ? "/project/parser fixtures" : "fixtures"}\nDescription: Parser examples\n\nparser.ts\nλ.test.ts`,
            ),
        )
        assert.match(result, /Attached directory: directory/)
        assert.doesNotMatch(result, /undefined|parser%20fixtures/)
        assert.deepEqual(native, original)
    })
}

for (const mime of ["image/png", "application/pdf"]) {
    test(`v2 ${mime} attachments preserve media and readable file locations`, async (t) => {
        const data = Buffer.from("BINARY_PAYLOAD_NOT_RECALL_TEXT").toString("base64")
        const native = [
            {
                id: "msg_media",
                type: "user",
                text: "Inspect the attachment.",
                files: [
                    {
                        mime,
                        data,
                        name: "evidence",
                        source: { type: "uri" as const, uri: "file:///project/media%20evidence" },
                    },
                ],
            },
        ]
        const original = structuredClone(native)
        const messages = normalizeNativeHistory(native, "ses_media")
        const media = messages[0]!.parts.filter((part) => part.type === "file")
        assert.equal(media.length, 1)
        assert.equal(media[0]!.mime, mime)
        assert.equal(media[0]!.filename, "evidence")
        assert.equal(media[0]!.url, `data:${mime};base64,${data}`)
        const h = await createHousekeepingHarness(t, { messages })
        const result = await h.run("recall_compressed", { action: "get", messageId: "m0001" })
        assert.match(result, /Inspect the attachment\./)
        assert.match(result, /Attached file: \/project\/media evidence/)
        assert.doesNotMatch(result, /BINARY_PAYLOAD_NOT_RECALL_TEXT/)
        assert.deepEqual(native, original)
    })
}

test("v2 media history deduplicates only matching mentioned inline images", () => {
    const image = {
        mime: "image/png",
        data: "YQ==",
        source: { type: "inline" as const },
        mention: { text: "@image" },
    }
    const pdf = { mime: "application/pdf", data: "Yg==", source: { type: "inline" as const } }
    const native = [
        {
            id: "msg_inline_media",
            type: "user",
            files: [image, { ...image }, { ...image, data: "Yw==" }, pdf, { ...pdf }],
        },
    ]
    const original = structuredClone(native)
    const messages = normalizeNativeHistory(native, "ses_inline_media")
    const media = messages[0]!.parts.filter((part) => part.type === "file")
    assert.deepEqual(
        media.map((part) => part.url),
        [
            "data:image/png;base64,YQ==",
            "data:image/png;base64,Yw==",
            "data:application/pdf;base64,Yg==",
            "data:application/pdf;base64,Yg==",
        ],
    )
    assert.equal(new Set(messages[0]!.parts.map((part) => part.id)).size, messages[0]!.parts.length)
    assert.deepEqual(native, original)
})

test("v2 empty synthetic text does not substitute its display description", () => {
    const messages = normalizeNativeHistory(
        [
            {
                id: "msg_empty_report",
                type: "synthetic",
                text: "",
                description: "Display only",
                time: { created: 7 },
            },
        ],
        "ses_empty_report",
    )
    assert.equal(messages.length, 1)
    assert.equal(messages[0]!.info.role, "user")
    assert.equal(messages[0]!.info.time.created, 7)
    assert.equal(visibleText(messages), "")
})

async function createRecallHarness(t: TestContext, mode: "message" | "range" = "message") {
    const sessionID = `ses_recall_${t.name.replace(/\W/g, "_")}`
    const finding = ordinaryMessage(
        sessionID,
        "msg-2",
        "assistant",
        "Found the issue in token.ts line 42.",
    )
    finding.parts.push({
        id: "read-part",
        messageID: "msg-2",
        sessionID,
        type: "tool",
        tool: "read",
        callID: "read-call",
        state: {
            status: "completed",
            input: { filePath: "token.ts" },
            output: "export function validateToken...",
            title: "read",
            metadata: {},
            time: { start: 1, end: 2 },
        },
    })
    return createHousekeepingHarness(t, {
        mode,
        messages: [
            ordinaryMessage(
                sessionID,
                "msg-1",
                "user",
                "Fix the auth bug: tokens expire too early",
            ),
            finding,
            ordinaryMessage(
                sessionID,
                "msg-3",
                "assistant",
                "Applied fix: changed expiry from 5m to 30m.",
            ),
            ordinaryMessage(sessionID, "msg-4", "user", "Also check the database connection pool"),
            ordinaryMessage(
                sessionID,
                "msg-5",
                "assistant",
                "Pool size is 10, configured in db.ts.",
            ),
        ],
    })
}

async function stageMessages(h: HousekeepingHarness, refs: string[]) {
    return h.run("compress", {
        topic: "Investigation notes",
        content: refs.map((messageId) => ({
            messageId,
            topic: "Source note",
            summary: `Condensed source ${messageId}.`,
        })),
    })
}

async function createRecallGapHarness(t: TestContext, missing: string[]) {
    const h = await createRecallHarness(t)
    await h.enter()
    h.setHistory(h.history.filter((message) => !missing.includes(message.info.id)))
    return h
}

for (const action of ["get", "search"] as const) {
    const operation =
        action === "get"
            ? (h: HousekeepingHarness, start: string, end: string) =>
                  h.run("recall_compressed", { action, messageIdStart: start, messageIdEnd: end })
            : (h: HousekeepingHarness, start: string, end: string) =>
                  h.run("recall_compressed", {
                      action,
                      query: ".",
                      messageIdStart: start,
                      messageIdEnd: end,
                  })

    for (const { title, start, end, missing, expected, expectedRef, excluded, error } of [
        {
            title: "malformed start endpoint",
            start: "x0001",
            end: "m0002",
            missing: [],
            expected: "",
            error: /invalid|malformed|reference/i,
        },
        {
            title: "malformed end endpoint",
            start: "m0001",
            end: "x0002",
            missing: [],
            expected: "",
            error: /invalid|malformed|reference/i,
        },
        {
            title: "reversed existing endpoints",
            start: "m0004",
            end: "m0002",
            missing: [],
            expected: "",
            error: /reversed|start.*before|after.*end/i,
        },
        {
            title: "missing start resolves to nearest next existing reference",
            start: "m0002",
            end: "m0003",
            missing: ["msg-2"],
            expectedRef: "m0003",
            expected: "Applied fix: changed expiry from 5m to 30m.",
            excluded: /Found the issue in token\.ts|database connection pool/,
        },
        {
            title: "missing end resolves to nearest previous existing reference",
            start: "m0002",
            end: "m0003",
            missing: ["msg-3"],
            expectedRef: "m0002",
            expected: "Found the issue in token.ts line 42.",
            excluded: /Applied fix|database connection pool/,
        },
        {
            title: "both missing endpoints resolve inward",
            start: "m0002",
            end: "m0004",
            missing: ["msg-2", "msg-4"],
            expectedRef: "m0003",
            expected: "Applied fix: changed expiry from 5m to 30m.",
            excluded: /Found the issue in token\.ts|database connection pool/,
        },
        {
            title: "start beyond maximum reference",
            start: "m9999",
            end: "m9999",
            missing: [],
            expected: "",
            error: /reference|available|found|selectable/i,
        },
        {
            title: "end before minimum reference",
            start: "m0001",
            end: "m0000",
            missing: [],
            expected: "",
            error: /reference|available|found|selectable/i,
        },
    ]) {
        test(`recall ${action} range: ${title}`, async (t) => {
            const h = await createRecallGapHarness(t, missing)
            if (error) {
                await assert.rejects(operation(h, start, end), error)
                assert.match(
                    await operation(h, "m0001", "m0001"),
                    /Investigate the auth bug|Fix the auth bug|1 message|1 match/i,
                )
            } else {
                const result = await operation(h, start, end)
                assert.match(result, /1 message|1 match/)
                assert.ok(result.includes(action === "get" ? expected : expected.slice(0, 38)))
                assert.doesNotMatch(result, excluded ?? /$^/)
                if (action === "search") assert.match(result, new RegExp(`\\b${expectedRef}\\b`))
            }
            h.assertSessionReads()
        })
    }

    test(`recall ${action} range rejects intervals with no selectable references`, async (t) => {
        const h = await createRecallGapHarness(t, ["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"])
        await assert.rejects(
            operation(h, "m0001", "m0005"),
            /selectable|available|found|no messages/i,
        )
        h.assertSessionReads()
    })

    test(`recall ${action} range rejects endpoints whose inward rounding creates an empty or reversed interval`, async (t) => {
        const h = await createRecallGapHarness(t, ["msg-2", "msg-3"])
        await assert.rejects(operation(h, "m0002", "m0003"), /reversed|empty|selectable|reference/i)
        h.assertSessionReads()
    })

    test(`recall ${action} range keeps exact endpoints inclusive`, async (t) => {
        const h = await createRecallHarness(t)
        const result = await operation(h, "m0001", "m0002")
        assert.match(result, /Fix the auth bug/)
        assert.match(result, action === "get" ? /Found the issue in token\.ts/ : /2 match/)
        assert.doesNotMatch(result, /Applied fix|database connection/)
        h.assertSessionReads()
    })
}

test("recall get reports an individually missing message reference", async (t) => {
    const h = await createRecallHarness(t)
    await assert.rejects(
        h.run("recall_compressed", { action: "get", messageId: "m9999" }),
        /m9999.*not found/i,
    )
    h.assertSessionReads()
})

// ── "get" tests ─────────────────────────────────────────────────────────────

test("recall get by messageId returns original committed compressed content", async (t) => {
    const h = await createRecallHarness(t)
    await h.enter()
    await stageMessages(h, ["m0001", "m0002"])
    await h.leave()
    const context = visibleText(await h.render())
    assert.match(context, /Condensed source m0001\./)
    assert.doesNotMatch(context, /Fix the auth bug/)

    const result = await h.run("recall_compressed", { action: "get", messageId: "m0001" })
    assert.match(result, /Fix the auth bug/)
    assert.match(result, /1 message/)
    assert.doesNotMatch(result, /Condensed source/)
    assert.deepEqual(h.client.session.messages.mock.calls.at(-1)?.arguments[0], {
        path: { id: h.sessionID },
    })
    h.assertSessionReads()
})

test("recall get by messageId reads a single staged source without committing it", async (t) => {
    const h = await createRecallHarness(t)
    await h.enter()
    await stageMessages(h, ["m0001", "m0002"])
    const result = await h.run("recall_compressed", { action: "get", messageId: "m0001" })
    assert.match(result, /Fix the auth bug/)
    assert.match(result, /m0001/)
    assert.match(result, /1 message/)
    assert.doesNotMatch(result, /token\.ts|database connection/)
    const staged = await h.render()
    assert.match(
        visibleText(staged.filter((message) => message.info.id === "msg-1")),
        /Fix the auth bug/,
    )
    await h.leave()
    assert.doesNotMatch(visibleText(await h.render()), /Fix the auth bug/)
    h.assertSessionReads()
})

test("recall get by messageId range returns only the requested staged sources", async (t) => {
    const h = await createRecallHarness(t)
    await h.enter()
    await stageMessages(h, ["m0001", "m0002", "m0003"])
    const result = await h.run("recall_compressed", {
        action: "get",
        messageIdStart: "m0001",
        messageIdEnd: "m0002",
    })
    assert.match(result, /Fix the auth bug/)
    assert.match(result, /token\.ts/)
    assert.match(result, /\[tool:read\] export function validateToken/)
    assert.match(result, /2 message/)
    assert.doesNotMatch(result, /Applied fix.*30m|database connection/)
    await h.leave()
    h.assertSessionReads()
})

test("recall get with no target returns an actionable error outside housekeeping", async (t) => {
    const h = await createRecallHarness(t)
    await assert.rejects(
        h.run("recall_compressed", { action: "get" }),
        /messageId|provide.*target/i,
    )
    h.assertSessionReads()
})

test("recall get rejects block IDs as raw message targets", async (t) => {
    const h = await createRecallHarness(t)
    await h.enter()
    await stageMessages(h, ["m0001"])
    await assert.rejects(
        h.run("recall_compressed", { action: "get", blockId: 1 }),
        /Cannot use blockId.*get|provide.*messageId/i,
    )
    assert.match(await h.versions(1, 1), /Condensed source m0001\./)
    await h.leave()
    h.assertSessionReads()
})

test("recall get returns uncompressed ordinary messages outside housekeeping", async (t) => {
    const h = await createRecallHarness(t)
    const result = await h.run("recall_compressed", { action: "get", messageId: "m0005" })
    assert.match(result, /Pool size is 10, configured in db\.ts\./)
    assert.match(result, /1 message/)
    assert.doesNotMatch(result, /Fix the auth bug/)
    h.assertSessionReads()
})

// ── "search" tests ───────────────────────────────────────────────────────────

test("recall search finds matching original text across committed blocks", async (t) => {
    const h = await createRecallHarness(t)
    await h.enter()
    await stageMessages(h, ["m0001", "m0002", "m0004", "m0005"])
    await h.leave()
    const result = await h.run("recall_compressed", { action: "search", query: "token" })
    assert.match(result, /tokens expire too early/)
    assert.match(result, /token\.ts/)
    assert.match(result, /2 match/)
    assert.doesNotMatch(result, /database|pool size|Condensed source/i)
    h.assertSessionReads()
})

test("recall search scoped to a block resolves earlier staged compression", async (t) => {
    const h = await createRecallHarness(t)
    await h.enter()
    await stageMessages(h, ["m0001"])
    await stageMessages(h, ["m0004"])
    const result = await h.run("recall_compressed", { action: "search", query: ".", blockId: 1 })
    assert.match(result, /auth/)
    assert.match(result, /1 match/)
    assert.doesNotMatch(result, /database|pool/i)
    const secondBlock = await h.run("recall_compressed", {
        action: "search",
        query: "database",
        blockId: 2,
    })
    assert.match(secondBlock, /database connection pool/)
    await h.leave()
    h.assertSessionReads()
})

test("recall search scoped to a block range reads multiple staged tool calls", async (t) => {
    const h = await createRecallHarness(t)
    await h.enter()
    await stageMessages(h, ["m0001"])
    await stageMessages(h, ["m0002"])
    await stageMessages(h, ["m0004"])
    const result = await h.run("recall_compressed", {
        action: "search",
        query: "token",
        blockIdStart: 1,
        blockIdEnd: 2,
    })
    assert.match(result, /auth/)
    assert.match(result, /line 42/)
    assert.match(result, /2 match/)
    assert.doesNotMatch(result, /database|pool/)
    await h.leave()
    h.assertSessionReads()
})

test("recall broad search includes draft-only blocks without publishing their compression", async (t) => {
    const h = await createRecallHarness(t)
    await h.enter()
    await stageMessages(h, ["m0001", "m0002"])
    const result = await h.run("recall_compressed", { action: "search", query: "token" })
    assert.match(result, /tokens expire too early/)
    assert.match(result, /token\.ts/)
    assert.match(result, /2 match/)
    const staged = await h.render()
    assert.match(
        visibleText(staged.filter((message) => message.info.id === "msg-2")),
        /Found the issue in token\.ts/,
    )
    await h.leave()
    assert.doesNotMatch(visibleText(await h.render()), /Found the issue in token\.ts/)
    h.assertSessionReads()
})

test("recall search with no matches returns an empty result", async (t) => {
    const h = await createRecallHarness(t)
    await h.enter()
    await stageMessages(h, ["m0001"])
    const result = await h.run("recall_compressed", {
        action: "search",
        query: "nonexistent_xyz123",
    })
    assert.match(result, /no matches|not found|0 results/i)
    await h.leave()
    h.assertSessionReads()
})

test("recall search with missing query returns an actionable error", async (t) => {
    const h = await createRecallHarness(t)
    await assert.rejects(
        h.run("recall_compressed", { action: "search" }),
        /query.*required|provide.*query/i,
    )
    h.assertSessionReads()
})

test("recall search validates regex patterns without disturbing staged blocks", async (t) => {
    const h = await createRecallHarness(t)
    await h.enter()
    await stageMessages(h, ["m0001"])
    await assert.rejects(
        h.run("recall_compressed", { action: "search", query: "[" }),
        /invalid.*pattern|invalid.*regular expression/i,
    )
    const result = await h.run("recall_compressed", { action: "search", query: "auth|token" })
    assert.match(result, /Fix the auth bug/)
    await h.leave()
    assert.match(visibleText(await h.render()), /Condensed source m0001\./)
    h.assertSessionReads()
})

// ── edge cases ───────────────────────────────────────────────────────────────

test("recall get works after a public command decompresses a committed block", async (t) => {
    const h = await createRecallHarness(t)
    await h.enter()
    await stageMessages(h, ["m0001"])
    await h.leave()
    assert.doesNotMatch(visibleText(await h.render()), /Fix the auth bug/)
    await h.command("decompress 1")
    const context = visibleText(await h.render())
    assert.match(context, /Fix the auth bug/)
    assert.doesNotMatch(context, /Condensed source m0001\./)
    const result = await h.run("recall_compressed", { action: "get", messageId: "m0001" })
    assert.match(result, /Fix the auth bug/)
    assert.ok(h.client.session.prompt.mock.callCount() > 0)
    assert.deepEqual(h.client.session.prompt.mock.calls.at(-1)?.arguments[0].path, {
        id: h.sessionID,
    })
    h.assertSessionReads()
})

test("recall sees expanded draft coverage while ordinary context keeps committed coverage", async (t) => {
    const h = await createRecallHarness(t, "range")
    await h.enter()
    await stageBlock(h, "Auth request.", "m0001", "m0001")
    await h.leave()
    await h.enter()
    await h.run("expand_block", { blockId: 1, endId: "m0003" })
    const result = await h.run("recall_compressed", {
        action: "search",
        query: "expiry",
        blockId: 1,
    })
    assert.match(result, /changed expiry from 5m to 30m/)
    assert.match(result, /1 match/)
    const staged = await h.render()
    assert.match(
        visibleText(staged.filter((message) => message.info.id === "msg-3")),
        /Applied fix/,
    )
    await h.run("append_summary", { blockId: 1, text: " Expiry is 30 minutes." })
    await h.leave()
    const context = visibleText(await h.render())
    assert.match(context, /Expiry is 30 minutes\./)
    assert.doesNotMatch(context, /Applied fix: changed expiry/)
    const committedRecall = await h.run("recall_compressed", {
        action: "search",
        query: "expiry",
        blockId: 1,
    })
    assert.match(committedRecall, /changed expiry from 5m to 30m/)
    h.assertSessionReads()
})

for (const mode of ["range", "message"] as const) {
    test(`recall ranges and broad search exclude completed housekeeping interiors in ${mode} mode`, async (t) => {
        const h = await createRecallHarness(t, mode)
        await h.enter()
        h.addText("private-recall-note", "HOUSEKEEPING_RECALL_PRIVATE token investigation")
        await h.run("recall_compressed", { action: "get", messageId: "m0001" })
        assert.match(visibleText(await h.render()), /HOUSEKEEPING_RECALL_PRIVATE/)
        await h.leave({ force: true })
        assert.doesNotMatch(visibleText(await h.render()), /HOUSEKEEPING_RECALL_PRIVATE/)
        h.addText("msg-6", "Outside token follow-up.", "user")
        await h.render()
        await h.enter()
        if (mode === "range") {
            await stageBlock(h, "Cross-boundary ordinary findings.", "m0001", "m0006")
        } else {
            await stageMessages(h, ["m0001", "m0002", "m0003", "m0004", "m0005", "m0006"])
        }

        const range = await h.run("recall_compressed", {
            action: "get",
            messageIdStart: "m0001",
            messageIdEnd: "m0006",
        })
        assert.match(range, /6 message/)
        assert.match(range, /Fix the auth bug/)
        assert.match(range, /Outside token follow-up\./)
        assert.equal(range.match(/Fix the auth bug/g)?.length, 1)
        assert.doesNotMatch(
            range,
            /HOUSEKEEPING_RECALL_PRIVATE|\[tool:recall_compressed\]|\[tool:enter_housekeeping\]|\[tool:leave_housekeeping\]/,
        )

        const rangedSearch = await h.run("recall_compressed", {
            action: "search",
            query: ".",
            messageIdStart: "m0001",
            messageIdEnd: "m0006",
        })
        assert.match(rangedSearch, /6 match/)
        assert.match(rangedSearch, /Outside token follow-up/)
        assert.doesNotMatch(rangedSearch, /HOUSEKEEPING_RECALL_PRIVATE/)
        const draftSearch = await h.run("recall_compressed", { action: "search", query: "." })
        assert.match(draftSearch, /6 match/)
        assert.match(draftSearch, /Outside token follow-up/)
        assert.doesNotMatch(draftSearch, /HOUSEKEEPING_RECALL_PRIVATE/)

        await h.leave()
        const committedSearch = await h.run("recall_compressed", { action: "search", query: "." })
        assert.match(committedSearch, /6 match/)
        assert.match(committedSearch, /Fix the auth bug/)
        assert.doesNotMatch(committedSearch, /HOUSEKEEPING_RECALL_PRIVATE/)
        h.assertSessionReads()
    })
}
