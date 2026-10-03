import assert from "node:assert/strict"
import test from "node:test"
import { buildSummaryFile, parseSummaryFile, SUMMARY_MARKER } from "../lib/summary-file"

test("buildSummaryFile places the summary verbatim after the marker line", () => {
    const summary = "Hello world"
    const file = buildSummaryFile(summary)

    assert.ok(file.includes(SUMMARY_MARKER))
    assert.equal(parseSummaryFile(file), summary)
})

test("parseSummaryFile returns everything after the marker line", () => {
    const content = ["# instructions", "# more instructions", SUMMARY_MARKER, "line1", "line2"].join("\n")

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
