import assert from "node:assert/strict"
import test from "node:test"
import { buildMemoFile, parseMemoFile, MEMO_MARKER } from "../lib/memo-file"

test("buildMemoFile places the memo verbatim after the marker line", () => {
    const memo = "Hello world"
    const file = buildMemoFile(memo)

    assert.ok(file.includes(MEMO_MARKER))
    assert.equal(parseMemoFile(file), memo)
})

test("parseMemoFile returns everything after the marker line", () => {
    const content = ["# instructions", "# more instructions", MEMO_MARKER, "line1", "line2"].join("\n")

    assert.equal(parseMemoFile(content), "line1\nline2")
})

test("parseMemoFile returns the whole content when the marker is absent", () => {
    assert.equal(parseMemoFile("just text"), "just text")
})

test("round trips an empty memo", () => {
    assert.equal(parseMemoFile(buildMemoFile("")), "")
})

test("markdown headings and hashes in the memo are preserved", () => {
    const memo = "## Section\n- item\n```\ncode # not a comment\n```"
    assert.equal(parseMemoFile(buildMemoFile(memo)), memo)
})
