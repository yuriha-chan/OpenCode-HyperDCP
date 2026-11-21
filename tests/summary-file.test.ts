import assert from "node:assert/strict"
import test from "node:test"
import { buildSummaryFile, parseSummaryFile, SUMMARY_MARKER } from "../lib/summary-file"
import { wrapCompressedSummary } from "../lib/compress/state"

test("buildSummaryFile places the summary verbatim after the marker line", () => {
    const summary = "Hello world"
    const file = buildSummaryFile(summary)

    assert.ok(file.includes(SUMMARY_MARKER))
    assert.equal(parseSummaryFile(file), summary)
})

test("parseSummaryFile returns everything after the marker line", () => {
    const content = [
        "# instructions",
        "# more instructions",
        SUMMARY_MARKER,
        "line1",
        "line2",
    ].join("\n")

    assert.equal(parseSummaryFile(content), "line1\nline2")
})

test("parseSummaryFile returns the whole content when the marker is absent", () => {
    assert.equal(parseSummaryFile("just text"), "just text")
})

test("round trips an empty summary", () => {
    assert.equal(parseSummaryFile(buildSummaryFile("")), "")
})

test("markdown headings and hashes in the summary are preserved", () => {
    const summary = "## Section\n- item\n```\ncode # not a comment\n```"
    assert.equal(parseSummaryFile(buildSummaryFile(summary)), summary)
})

test("manual summary files expose only the document from legacy wrapped summaries", () => {
    const body = "## Findings\n\nKeep **Markdown** and literal b12 references."
    const wrapped = wrapCompressedSummary(12, body, "m0001-m0004")
    const file = buildSummaryFile(wrapped)
    assert.equal(parseSummaryFile(file), body)
    assert.doesNotMatch(file, /Compressed conversation section|dcp-message-id/)
    assert.equal(parseSummaryFile(wrapped), body)
    assert.equal(parseSummaryFile(buildSummaryFile(body)), body)
})
