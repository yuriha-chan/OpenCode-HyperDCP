import assert from "node:assert/strict"
import test from "node:test"
import { editMemo, parseMemo, renderMemo, validateMemo, type Memo } from "../lib/memo"

type EditResult = { memo: Memo; warnings: string[] }

function assertEditResult(value: unknown): asserts value is EditResult {
    assert.ok(typeof value === "object" && value !== null && "memo" in value && "warnings" in value)
    assert.ok(Array.isArray(value.memo))
    assert.ok(
        Array.isArray(value.warnings) &&
            value.warnings.every((warning) => typeof warning === "string"),
    )
}

function assertNoWarnings(value: unknown): asserts value is EditResult {
    assertEditResult(value)
    assert.deepEqual(value.warnings, [])
}

test("renders canonical headers and unindented bullets, then parses the rendered document", () => {
    const memo: Memo = [
        {
            topic: "Environment",
            items: [
                { topic: "Constraints and User preferences", items: ["constraint"] },
                { topic: "Working Commands", items: ["npm run typecheck"] },
            ],
        },
    ]
    const markdown = [
        "# Environment",
        "## Constraints and User preferences",
        "- constraint",
        "## Working Commands",
        "- npm run typecheck",
    ].join("\n")

    assert.equal(renderMemo(memo), markdown)
    assert.deepEqual(parseMemo(markdown), memo)
    assert.deepEqual(parseMemo(renderMemo(memo)), memo)
})

test("round-trips canonical plain, multiline, blank, fenced, and syntax-like strings", () => {
    const memo: Memo = [
        "root note",
        "",
        "first line\nsecond line\n\nlast line",
        "```ts\nconst value = 1\n```",
        "# header-looking",
        "- list-looking",
        {
            topic: "Code and notes",
            items: [
                "nested plain",
                "nested first\nnested second",
                "~~~txt\ninside fence\n~~~",
                { topic: "Details", items: ["deep note", "## heading-looking"] },
            ],
        },
    ]

    assert.deepEqual(parseMemo(renderMemo(memo)), memo)
})

test("parses headings, unindented bullets, multiline paragraphs, and fenced code", () => {
    assert.deepEqual(
        parseMemo(
            [
                "Root paragraph",
                "continued root",
                "- root bullet",
                "## Plan",
                "A paragraph",
                "continued paragraph",
                "- a bullet",
                "```md",
                "# code heading",
                "- code bullet",
                "```",
            ].join("\n"),
        ),
        [
            "Root paragraph\ncontinued root",
            "root bullet",
            {
                topic: "Plan",
                items: [
                    "A paragraph\ncontinued paragraph",
                    "a bullet",
                    "```md\n# code heading\n- code bullet\n```",
                ],
            },
        ],
    )
})

test("repairs malformed imported headings while preserving all fixture content", () => {
    const memo = parseMemo(
        [
            "# A/B",
            "- keep slash name text",
            "# Same",
            "- duplicate",
            "# Same",
            "- duplicate",
            "####### Too deep",
            "preserve this",
        ].join("\n"),
    )

    assert.deepEqual(memo, [
        { topic: "A-B", items: ["keep slash name text"] },
        { topic: "Same", items: ["duplicate"] },
        { topic: "Same (2)", items: ["duplicate", "####### Too deep\npreserve this"] },
    ])
})

test("repairs parsed string collisions without losing occurrences", () => {
    const memo = parseMemo("- x\n\n- x\nx\n\n- x")

    assert.doesNotThrow(() => validateMemo(memo))
    const strings = memo.filter((item): item is string => typeof item === "string")
    assert.equal(strings.join("\n").split("x").length - 1, 4)
})

test("repairs empty, whitespace-only, slash-containing, and duplicate imported headings", () => {
    const memo = parseMemo("#\n\n#   \n\n# A/B\n\n# Same\n\n# Same")

    assert.doesNotThrow(() => validateMemo(memo))
    assert.equal(memo.filter((item) => typeof item !== "string").length, 5)
    const topics = memo.flatMap((item) => (typeof item === "string" ? [] : [item.topic]))
    assert.ok(topics.every((topic) => topic.trim().length > 0 && !topic.includes("/")))
})

test("parses empty and whitespace-only documents and normalizes CRLF", () => {
    assert.deepEqual(parseMemo("\n  \n"), [])
    assert.equal(renderMemo([]), "")
    assert.deepEqual(parseMemo("  \r\n\t\r\n"), [])
    assert.deepEqual(parseMemo("# A\r\n\r\n- note"), [{ topic: "A", items: ["note"] }])
})

test("appends strings at the end of the string portion before topics", () => {
    const original: Memo = [
        "root first",
        { topic: "A", items: ["child note", { topic: "Nested", items: [] }] },
        { topic: "B", items: [] },
    ]
    const snapshot = structuredClone(original)
    const result: unknown = editMemo(original, { type: "append", content: "root last string" })

    assertNoWarnings(result)
    assert.deepEqual(result.memo, [
        "root first",
        "root last string",
        { topic: "A", items: ["child note", { topic: "Nested", items: [] }] },
        { topic: "B", items: [] },
    ])
    assert.deepEqual(original, snapshot)
})

test("appends topics at the total end by default and after the specified sibling", () => {
    const memo: Memo = ["root note", { topic: "A", items: [] }, { topic: "B", items: [] }]
    const atEnd: unknown = editMemo(memo, { type: "append", content: { topic: "C", items: [] } })

    assertNoWarnings(atEnd)
    assert.deepEqual(atEnd.memo, [
        "root note",
        { topic: "A", items: [] },
        { topic: "B", items: [] },
        { topic: "C", items: [] },
    ])

    const after: unknown = editMemo(memo, {
        type: "append",
        content: { topic: "C", items: [] },
        after: "A",
    })
    assertNoWarnings(after)
    assert.deepEqual(after.memo, [
        "root note",
        { topic: "A", items: [] },
        { topic: "C", items: [] },
        { topic: "B", items: [] },
    ])
})

test("relocates an explicitly after-anchored string to the parent's string portion with a warning", () => {
    const memo: Memo = ["existing", { topic: "Environment", items: [] }]
    const result: unknown = editMemo(memo, {
        type: "append",
        content: "added string",
        after: "Environment",
    })

    assertEditResult(result)
    assert.deepEqual(result.memo, ["existing", "added string", { topic: "Environment", items: [] }])
    assert.ok(result.warnings.length > 0)
    assert.ok(result.warnings.some((warning) => /Environment|after|order|relocat/i.test(warning)))
})

test("supports parent and after together when after is a direct child of that parent", () => {
    const memo: Memo = [
        { topic: "Environment", items: [{ topic: "Constraints and User preferences", items: [] }] },
    ]
    const result: unknown = editMemo(memo, {
        type: "append",
        content: "constraint",
        parent: "Environment",
        after: "Environment/Constraints and User preferences",
    })

    assertEditResult(result)
    assert.deepEqual(result.memo, [
        {
            topic: "Environment",
            items: ["constraint", { topic: "Constraints and User preferences", items: [] }],
        },
    ])
    assert.ok(result.warnings.length > 0)
    assert.ok(
        result.warnings.some((warning) =>
            /Constraints and User preferences|after|order|relocat/i.test(warning),
        ),
    )
})

test("inserts a topic after the named child within its specified parent without warnings", () => {
    const memo: Memo = [
        {
            topic: "Environment",
            items: [{ topic: "Constraints and User preferences", items: [] }],
        },
    ]
    const result: unknown = editMemo(memo, {
        type: "append",
        content: { topic: "Working Commands", items: ["npm run typecheck"] },
        parent: "Environment",
        after: "Environment/Constraints and User preferences",
    })

    assertNoWarnings(result)
    assert.deepEqual(result.memo, [
        {
            topic: "Environment",
            items: [
                { topic: "Constraints and User preferences", items: [] },
                { topic: "Working Commands", items: ["npm run typecheck"] },
            ],
        },
    ])
})

test("uses an omitted append parent as root and rejects nested after paths", () => {
    const memo: Memo = [{ topic: "A", items: [{ topic: "B", items: [] }] }]
    const snapshot = structuredClone(memo)

    assert.throws(
        () => editMemo(memo, { type: "append", content: "root insertion", after: "A/B" }),
        /after|parent|topic|not found/i,
    )
    assert.deepEqual(memo, snapshot)
})

test("rejects missing parent, missing after, duplicate, and invalid append operations atomically", () => {
    const original: Memo = [{ topic: "A", items: ["one"] }]
    const snapshot = structuredClone(original)
    const edits = [
        { type: "append", content: "two", parent: "Missing" },
        { type: "append", content: "two", after: "Missing" },
        { type: "append", content: "one", parent: "A" },
        { type: "append", content: { topic: "A", items: [] } },
        { type: "append", content: { topic: "Bad/Name", items: [] } },
    ] as const

    for (const edit of edits) {
        assert.throws(() => editMemo(original, edit as never))
        assert.deepEqual(original, snapshot)
    }
    for (const topic of ["", "  \t  ", "A/B"]) {
        assert.throws(
            () => editMemo([], { type: "append", content: { topic, items: [] } }),
            /invalid memo topic/i,
        )
    }
})

test("rejects an after topic under a different existing parent without mutation", () => {
    const original: Memo = [
        { topic: "A", items: [{ topic: "Child", items: [] }] },
        { topic: "B", items: [{ topic: "Other", items: [] }] },
    ]
    const snapshot = structuredClone(original)

    assert.throws(
        () =>
            editMemo(original, {
                type: "append",
                content: "inserted",
                parent: "A",
                after: "B/Other",
            }),
        /after|parent|child|sibling|incompatible/i,
    )
    assert.deepEqual(original, snapshot)
})

test("normalizes supplied section order recursively with a warning and preserves item order", () => {
    const original: Memo = [{ topic: "Existing", items: [] }]
    const supplied: Memo = [
        {
            topic: "First topic",
            items: [{ topic: "Nested topic", items: ["nested note"] }, "nested last"],
        },
        "first string",
        { topic: "Second topic", items: [] },
        "second string",
    ]
    const suppliedSnapshot = structuredClone(supplied)
    const result: unknown = editMemo(original, {
        type: "append",
        content: { topic: "Added", items: supplied },
    })

    assertEditResult(result)
    assert.deepEqual(result.memo, [
        { topic: "Existing", items: [] },
        {
            topic: "Added",
            items: [
                "first string",
                "second string",
                {
                    topic: "First topic",
                    items: ["nested last", { topic: "Nested topic", items: ["nested note"] }],
                },
                { topic: "Second topic", items: [] },
            ],
        },
    ])
    assert.ok(result.warnings.length > 0)
    assert.ok(result.warnings.some((warning) => /Added|order|normaliz|reorder/i.test(warning)))
    assert.deepEqual(supplied, suppliedSnapshot)
})

test("rejects duplicate entries in existing and supplied trees instead of repairing strict edits", () => {
    const duplicateContents: Memo[] = [
        [{ topic: "Added", items: ["same", "same"] }],
        [
            {
                topic: "Added",
                items: [
                    { topic: "Child", items: [] },
                    { topic: "Child", items: [] },
                ],
            },
        ],
    ]
    const original: Memo = [{ topic: "A", items: [] }]
    const originalSnapshot = structuredClone(original)

    for (const content of duplicateContents) {
        const contentSnapshot = structuredClone(content)
        assert.throws(() => editMemo(original, { type: "append", content: content[0]! }))
        assert.deepEqual(original, originalSnapshot)
        assert.deepEqual(content, contentSnapshot)
    }
    assert.throws(() => editMemo(["same", "same"], { type: "append", content: "new" }))

    const noncanonicalMemo: Memo = [{ topic: "A", items: [] }, "late root string"]
    const noncanonicalSnapshot = structuredClone(noncanonicalMemo)
    assert.throws(() => editMemo(noncanonicalMemo, { type: "append", content: "new" }))
    assert.deepEqual(noncanonicalMemo, noncanonicalSnapshot)
})

test("does not alias supplied content into a successful result", () => {
    const original: Memo = [{ topic: "A", items: [] }]
    const content: Memo = ["first string", { topic: "Child", items: ["nested"] }]
    const originalSnapshot = structuredClone(original)
    const contentSnapshot = structuredClone(content)
    const result: unknown = editMemo(original, {
        type: "append",
        parent: "A",
        content: { topic: "Added", items: content },
    })

    assertNoWarnings(result)
    assert.deepEqual(original, originalSnapshot)
    const parent = result.memo[0]
    assert.ok(typeof parent !== "string")
    const added = parent.items[0]
    assert.ok(typeof added !== "string")
    const nestedChild = added.items[1]
    assert.ok(typeof nestedChild !== "string")
    nestedChild.items.push("later edit")
    assert.deepEqual(content, contentSnapshot)
    assert.deepEqual(original, originalSnapshot)
})

test("accepts exactly six topic levels and rejects a seventh below an existing six-level parent", () => {
    let fiveLevels: Memo = []
    for (let depth = 5; depth > 0; depth -= 1) {
        fiveLevels = [{ topic: `Level ${depth}`, items: fiveLevels }]
    }
    const sixLevelsResult: unknown = editMemo(fiveLevels, {
        type: "append",
        parent: "Level 1/Level 2/Level 3/Level 4/Level 5",
        content: { topic: "Level 6", items: [] },
    })

    assertNoWarnings(sixLevelsResult)
    let expectedSixLevels: Memo = [{ topic: "Level 6", items: [] }]
    for (let depth = 5; depth > 0; depth -= 1) {
        expectedSixLevels = [{ topic: `Level ${depth}`, items: expectedSixLevels }]
    }
    assert.deepEqual(sixLevelsResult.memo, expectedSixLevels)
    assert.doesNotThrow(() => validateMemo(sixLevelsResult.memo))
    assert.throws(
        () =>
            editMemo(sixLevelsResult.memo, {
                type: "append",
                parent: "Level 1/Level 2/Level 3/Level 4/Level 5/Level 6",
                content: { topic: "Level 7", items: [] },
            }),
        /six levels/i,
    )
})

test("removes topic subtrees and uniquely prefixed strings through the structured result", () => {
    const memo: Memo = [
        "root prefix one",
        "root prefix two",
        { topic: "A", items: ["child note", { topic: "B", items: ["nested"] }] },
    ]
    const subtree: unknown = editMemo(memo, { type: "remove", path: "A" })
    assertNoWarnings(subtree)
    assert.deepEqual(subtree.memo, ["root prefix one", "root prefix two"])

    const child: unknown = editMemo(memo, { type: "remove", path: "A//child" })
    assertNoWarnings(child)
    assert.deepEqual(child.memo, [
        "root prefix one",
        "root prefix two",
        { topic: "A", items: [{ topic: "B", items: ["nested"] }] },
    ])
})

test("rejects missing and ambiguous string removals without mutation and removes a root prefix", () => {
    const memo: Memo = ["root prefix one", "root prefix two", { topic: "A", items: [] }]
    const snapshot = structuredClone(memo)

    assert.throws(() => editMemo(memo, { type: "remove", path: "//root prefix" }), /ambiguous/i)
    assert.deepEqual(memo, snapshot)
    assert.throws(() => editMemo(memo, { type: "remove", path: "//missing" }), /not found/i)
    assert.deepEqual(memo, snapshot)

    const removed: unknown = editMemo(memo, { type: "remove", path: "//root prefix one" })
    assertNoWarnings(removed)
    assert.deepEqual(removed.memo, ["root prefix two", { topic: "A", items: [] }])
})

test("uses the first selector delimiter and permits slash characters in string prefixes", () => {
    const memo: Memo = [
        { topic: "A", items: ["curl https://example.test/path", "curl https://other.test"] },
    ]
    const result: unknown = editMemo(memo, {
        type: "remove",
        path: "A//curl https://example.test/path",
    })

    assertNoWarnings(result)
    assert.deepEqual(result.memo, [{ topic: "A", items: ["curl https://other.test"] }])
})

test("clear empties only the selected topic and requires a topic path", () => {
    const memo: Memo = ["root", { topic: "A", items: ["one", { topic: "B", items: ["two"] }] }]
    const cleared: unknown = editMemo(memo, { type: "clear", path: "A" })

    assertNoWarnings(cleared)
    assert.deepEqual(cleared.memo, ["root", { topic: "A", items: [] }])
    assert.throws(() => editMemo(memo, { type: "clear" } as never), /path|topic/i)
})

test("validates canonical persisted trees and rejects strings after topics", () => {
    const valid: unknown = [
        "root note",
        { topic: "A", items: ["child note", { topic: "B", items: [] }] },
    ]
    assert.doesNotThrow(() => validateMemo(valid))
    assert.throws(() => validateMemo([{ topic: "A", items: [] }, "late root string"]))
    assert.throws(() =>
        validateMemo([{ topic: "A", items: ["first", { topic: "B", items: [] }, "late"] }]),
    )

    let sixLevels: unknown = []
    for (let depth = 6; depth > 0; depth -= 1) {
        sixLevels = [{ topic: `Level ${depth}`, items: sixLevels as Memo }]
    }
    assert.doesNotThrow(() => validateMemo(sixLevels))
    assert.throws(
        () => validateMemo([{ topic: "Too deep", items: sixLevels as Memo }]),
        /six levels/i,
    )

    assert.throws(() => validateMemo({ topic: "A", items: [] }), /array/i)
    assert.throws(() => validateMemo([{ topic: "", items: [] }]), /invalid memo topic/i)
    assert.throws(() => validateMemo([{ topic: "A/B", items: [] }]), /invalid memo topic/i)
    assert.throws(() => validateMemo(["same", "same"]), /duplicate memo string/i)
    assert.throws(
        () =>
            validateMemo([
                { topic: "A", items: [] },
                { topic: "A", items: [] },
            ]),
        /duplicate memo topic/i,
    )
    assert.throws(() => validateMemo([{ topic: "A", items: ["x", "x"] }]), /duplicate memo string/i)
    assert.doesNotThrow(() =>
        validateMemo([
            { topic: "A", items: ["same"] },
            { topic: "B", items: ["same"] },
        ]),
    )
})
