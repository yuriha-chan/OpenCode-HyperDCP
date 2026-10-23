import assert from "node:assert/strict"
import test from "node:test"
import { renderStoredMemo } from "../src/memo"

test("returns persisted legacy memo strings verbatim, including empty strings", () => {
    for (const value of ["", "plain memo", "  keep spacing  \n## Markdown\n"]) {
        assert.equal(renderStoredMemo(value), value)
    }
})

test("returns null for absent and unsupported non-array memo values", () => {
    for (const value of [null, undefined, 0, 1, true, false, {}, { topic: "A", items: [] }]) {
        assert.equal(renderStoredMemo(value), null)
    }
})

test("renders a structured memo with nested headers and unindented bullets", () => {
    assert.equal(
        renderStoredMemo([
            "root note",
            {
                topic: "Environment",
                items: [
                    "constraint",
                    {
                        topic: "Working Commands",
                        items: ["npm run typecheck"],
                    },
                ],
            },
        ]),
        [
            "- root note",
            "# Environment",
            "- constraint",
            "## Working Commands",
            "- npm run typecheck",
        ].join("\n"),
    )
})

test("preserves multiline strings and emits empty sections", () => {
    assert.equal(
        renderStoredMemo([
            "first line\nsecond line\n\nlast line",
            { topic: "Empty", items: [] },
            { topic: "Nested empty", items: [{ topic: "Child", items: [] }] },
        ]),
        [
            "- first line",
            "  second line",
            "  ",
            "  last line",
            "# Empty",
            "# Nested empty",
            "## Child",
        ].join("\n"),
    )
})

test("returns null for an empty structured memo", () => {
    assert.equal(renderStoredMemo([]), null)
})

test("throws validation errors for malformed memo arrays", () => {
    const invalidValues: unknown[] = [
        [1],
        [{ topic: "A" }],
        [{ topic: "A", items: "not an array" }],
        [{ topic: "", items: [] }],
        [{ topic: "A/B", items: [] }],
        ["same", "same"],
        [
            { topic: "A", items: [] },
            { topic: "A", items: [] },
        ],
        [{ topic: "A", items: ["same", "same"] }],
        [{ topic: "A", items: [] }, "late string"],
    ]

    for (const value of invalidValues) {
        assert.throws(() => renderStoredMemo(value), Error)
    }
})

test("accepts six nested topic levels and throws for a seventh", () => {
    let validMemo: unknown[] = []
    let excessiveDepthMemo: unknown[] = []
    for (let depth = 6; depth > 0; depth -= 1) {
        validMemo = [{ topic: `Level ${depth}`, items: validMemo }]
        excessiveDepthMemo = [{ topic: `Level ${depth}`, items: excessiveDepthMemo }]
    }
    excessiveDepthMemo = [{ topic: "Level 0", items: excessiveDepthMemo }]

    assert.equal(
        renderStoredMemo(validMemo),
        [
            "# Level 1",
            "## Level 2",
            "### Level 3",
            "#### Level 4",
            "##### Level 5",
            "###### Level 6",
        ].join("\n"),
    )
    assert.throws(() => renderStoredMemo(excessiveDepthMemo), /six levels/i)
})
