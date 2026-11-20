import assert from "node:assert/strict"
import test, { describe } from "node:test"
import { clampMessagePage, retainSummaryVersion } from "../src/tui-presentation"

const PAGE_SIZE = 20

describe("clampMessagePage", () => {
    test("retains a valid page while the message count grows", () => {
        const initial = clampMessagePage(1, 25, PAGE_SIZE)
        assert.equal(initial, 1)

        const afterGrowth = clampMessagePage(initial, 100, PAGE_SIZE)
        assert.equal(afterGrowth, 1)
    })

    test("clamps to the last remaining page after messages are removed", () => {
        const initial = clampMessagePage(2, 45, PAGE_SIZE)
        assert.equal(initial, 2)

        const afterRemoval = clampMessagePage(initial, 25, PAGE_SIZE)
        assert.equal(afterRemoval, 1)
    })

    test("clamps to page zero when no messages remain", () => {
        const afterEmptying = clampMessagePage(3, 0, PAGE_SIZE)
        assert.equal(afterEmptying, 0)
    })
})

describe("retainSummaryVersion", () => {
    test("retains an explicit selection through an active-version update and an added version", () => {
        const before = retainSummaryVersion(2, { versions: ["a", "b", "c"], activeVersionIndex: 1 })
        assert.equal(before, 2)

        const afterUpdate = retainSummaryVersion(before, {
            versions: ["a", "b", "c"],
            activeVersionIndex: 3,
        })
        assert.equal(afterUpdate, 2)

        const afterAddition = retainSummaryVersion(afterUpdate, {
            versions: ["a", "b", "c", "d"],
            activeVersionIndex: 3,
        })
        assert.equal(afterAddition, 2)
    })

    test("retains an explicit selection while the block is missing", () => {
        const retained = retainSummaryVersion(2, undefined)
        assert.equal(retained, 2)
    })

    test("keeps a null selection following the active version", () => {
        const withBlock = retainSummaryVersion(null, {
            versions: ["a", "b"],
            activeVersionIndex: 2,
        })
        assert.equal(withBlock, null)

        const withoutBlock = retainSummaryVersion(null, undefined)
        assert.equal(withoutBlock, null)
    })

    test("treats the disabled zero version as a valid explicit selection", () => {
        const retained = retainSummaryVersion(0, {
            versions: ["a", "b", "c"],
            activeVersionIndex: 2,
        })
        assert.equal(retained, 0)
    })

    test("clamps an explicit selection when versions are removed", () => {
        const clamped = retainSummaryVersion(4, { versions: ["a", "b"], activeVersionIndex: 1 })
        assert.equal(clamped, 2)
    })
})
