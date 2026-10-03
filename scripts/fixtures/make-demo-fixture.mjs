// Generates demo-pizza-bot.json, a synthetic DCP session state fixture.
//
// It is intentionally fictional and English-only (an adorable pizza-delivery
// robot firmware project) so the TUI harness can seed a neutral, shareable
// session instead of depending on a real personal one.
//
// The shape matches PersistedSessionState in lib/state/persistence.ts.
// Regenerate with:  node scripts/fixtures/make-demo-fixture.mjs

import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

function rawId(n) {
    return `msg_demo${String(n).padStart(4, "0")}`
}

// Each topic owns a contiguous ref range. refs are session-scoped and only
// need to be internally consistent for the TUI to render.
const topics = [
    {
        topic: "Bootloader handshake for the dough sensor",
        start: 3,
        end: 28,
        compressedTokens: 24610,
        durationMs: 9120,
        summary: `## Dough sensor bootloader
The dough sensor board ships with a tiny bootloader that must complete a
handshake before the arm firmware will talk to it.

- Handshake is a 4-byte magic \`0xD0 0x6C 0x44 0x21\` followed by a CRC-8.
- The sensor answers with a status byte; 0x00 means "flour level unknown yet".
- We retry the handshake up to 5 times with a 120 ms backoff before giving up
  and entering "no dough" safe mode (arm parks, LED pulses amber).`,
    },
    {
        topic: "Knead routine timing and torque limits",
        start: 29,
        end: 61,
        compressedTokens: 31220,
        durationMs: 14380,
        // v0 (activeVersionIndex 0) keeps the range pruned but shows no summary,
        // demonstrating that culling removes the content from the model's view.
        activeVersionIndex: 0,
        summary: `## Knead routine
Goal: a repeatable 90-second knead that never stalls the motor.

- Torque is capped at 0.42 N·m; above that the arm backs off 15% for 400 ms.
- Two-phase motion: slow fold (40 s) then rhythmic press (50 s, 1.1 Hz).
- We log a "dough elasticity" score from the last 10 torque peaks.
- Edge case: if elasticity plateaus for 8 presses, stop early and raise the
  "probably done" flag.`,
    },
    {
        topic: "Topping placement vision pipeline",
        start: 62,
        end: 108,
        compressedTokens: 41970,
        durationMs: 20410,
        summary: `## Topping vision pipeline
A 64x64 camera stream feeds a pepperoni/pepper/green-onion classifier.

- Frames are downscaled and cropped to the crust polygon before inference.
- Pepperoni targets sit on an 8-point ring; placement jitter must stay under
  6 mm so the cheese blanket covers them evenly.
- Green onion is sprinkled last with a 0.7 g target per pie.
- False positives on the crust edge are dropped by an inset mask.`,
        versions: [
            `## Topping vision pipeline (v2)
Pepperoni ring switched from 8 points to 10 for large pies, and the inset mask
was widened by 3 px after the "onion on the crust" bug.`,
        ],
        activeVersionIndex: 2,
    },
    {
        topic: "Oven handoff and temperature safety",
        start: 109,
        end: 147,
        compressedTokens: 28640,
        durationMs: 11760,
        summary: `## Oven handoff
After toppings, the robot waits for the oven slot to open before extending.

- Slot-open detection uses an IR beam; debounce is 50 ms.
- The arm withdraws fully within 1.4 s or the oven gate stays shut.
- Surface temp at the peel tip is sampled; above 180 C it aborts and cools.
- A "please don't burn the pepperoni" watchdog trims dwell time by 10% if the
  last 3 pies came out darker than target.`,
    },
    {
        topic: "Delivery route trolley docking",
        start: 148,
        end: 196,
        compressedTokens: 33480,
        durationMs: 15230,
        summary: `## Trolley docking
The robot docks onto the delivery trolley to hand off finished pies.

- Docking uses two reflective markers and a short reverse alignment wiggle.
- Tolerance is +/- 4 mm lateral, +/- 2 deg yaw.
- On the third failed attempt it honks twice (a friendly "beep beep") and asks
  a human to nudge the trolley.
- Successful dock closes the box, seals warm air in, and plays the little
  "order up!" chime.`,
    },
    {
        topic: "Deposit queue and order handoff UX",
        start: 197,
        end: 233,
        compressedTokens: 22760,
        durationMs: 8440,
        summary: `## Order handoff
The robot carries pies to the deposit shelf and announces each order.

- Shelf has 4 numbered slots; the robot always fills the lowest free slot.
- Announcement is a short tone pattern plus a spoken order label (friendly,
  not shouty). Volume is tuned so it is audible but never startles.
- If a slot stays full past its pickup window, the robot asks the kitchen to
  clear it rather than double-stacking.`,
    },
]

const FLOUR = 0 // placeholder to keep lint quiet if edited later

const blocks = {}
const byRawId = {}
let raw = 1

// Synthetic non-block context messages before the first block.
function fillByRawId(count) {
    for (let i = 0; i < count; i += 1) {
        byRawId[rawId(raw)] = `m${String(raw).padStart(4, "0")}`
        raw += 1
    }
}

fillByRawId(2) // m0001-m0002 preamble

const blockList = []
topics.forEach((entry, index) => {
    const blockId = index + 1
    const refStart = `m${String(entry.start).padStart(4, "0")}`
    const refEnd = `m${String(entry.end).padStart(4, "0")}`
    const effectiveMessageIds = []
    for (let r = entry.start; r <= entry.end; r += 1) {
        const id = rawId(raw)
        byRawId[id] = `m${String(r).padStart(4, "0")}`
        effectiveMessageIds.push(id)
        raw += 1
    }
    const summaryVersions = entry.versions ?? []
    const versions = Array.isArray(summaryVersions) ? summaryVersions : []
    const activeVersionIndex = entry.activeVersionIndex ?? 1
    blocks[String(blockId)] = {
        blockId,
        runId: blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: entry.compressedTokens,
        summaryTokens: 1200 + blockId * 137,
        durationMs: entry.durationMs,
        mode: "range",
        topic: entry.topic,
        batchTopic: entry.topic,
        startId: refStart,
        endId: refEnd,
        anchorMessageId: effectiveMessageIds[0],
        compressMessageId: effectiveMessageIds[effectiveMessageIds.length - 1],
        compressCallId: `call_demo_${blockId}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: effectiveMessageIds,
        directToolIds: [],
        effectiveMessageIds,
        effectiveToolIds: [],
        createdAt: `2026-05-0${blockId}T09:${String(10 + blockId).padStart(2, "0")}:00.000Z`,
        summary: entry.summary,
        summaryVersions: versions,
        activeVersionIndex,
    }
    blockList.push({
        blockId,
        versionText: versions,
    })
})

// Pointer to the newest tracked message.
byRawId[rawId(raw)] = `m${String(raw).padStart(4, "0")}`
raw += 1
const lastSeenRaw = Object.keys(byRawId).filter((id) => byRawId[id] === `m${String(raw - 1).padStart(4, "0")}`)
const lastSeenUserMessageId = lastSeenRaw[lastSeenRaw.length - 1]

const activeIds = Object.keys(byRawId)

const memo = `# Project
Adorable pizza-delivery robot firmware ("Doughbot"). English only, no real data.

# Working commands
- make flash-dough   -> flash the dough sensor board
- make test-knead    -> run the knead routine in simulation
- make sim-pie       -> dry-run one full order end to end

# Constraints
- Never exceed 0.42 N·m on the knead motor.
- Oven handoff must fully retract the peel before the gate closes.
- All announcements stay friendly and never shouty.

# Takeaways
- Keep the dough sensor in safe mode when its handshake fails; never guess flour.
- Topping jitter above 6 mm breaks the cheese blanket coverage.`

const totalPruneTokens = topics.reduce((sum, entry) => sum + entry.compressedTokens, 0)

const state = {
    sessionName: "Doughbot firmware — demo session",
    prune: {
        tools: {},
        messages: {
            byMessageId: Object.fromEntries(
                Object.values(byRawId).map((ref, i) => [
                    Object.keys(byRawId)[i],
                    {
                        tokenCount: 180 + (i % 9) * 37,
                        activeBlockIds: [],
                    },
                ]),
            ),
            blocksById: blocks,
            activeBlockIds: Object.keys(blocks).map(Number),
            activeByAnchorMessageId: Object.fromEntries(
                Object.values(blocks).map((b) => [b.anchorMessageId, b.blockId]),
            ),
            nextBlockId: Object.keys(blocks).length + 1,
            nextRunId: Object.keys(blocks).length + 1,
            lastSeenUserMessageId,
            activeMessageIds: activeIds,
        },
    },
    nudges: {
        contextLimitAnchors: [],
        turnNudgeAnchors: [],
        iterationNudgeAnchors: [],
    },
    protectedRefs: [],
    memo,
    messageIds: {
        byRawId,
        nextRef: raw,
    },
    stats: {
        totalPruneTokens,
        totalMessagesPruned: topics.reduce((sum, e) => sum + (e.end - e.start + 1), 0),
        totalToolsPruned: 0,
        compressionRatio: 0.68,
    },
    autotoggle: false,
    lastUpdated: "2026-05-06T09:20:00.000Z",
}

const out = join(here, "demo-pizza-bot.json")
writeFileSync(out, JSON.stringify(state, null, 2) + "\n", "utf-8")
console.log(`wrote ${out}`)
console.log(`blocks=${blockList.length} trackedMessages=${activeIds.length} savedTokens=${totalPruneTokens}`)
void FLOUR
