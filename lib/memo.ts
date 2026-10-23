export type MemoSection = { topic: string; items: MemoContent[] }
export type MemoContent = string | MemoSection
export type Memo = MemoContent[]

export type MemoEdit =
    | { type: "append"; content: MemoContent; parent?: string; after?: string }
    | { type: "remove"; path: string }
    | { type: "clear"; path?: string }

const MAX_DEPTH = 6

function isSection(value: unknown): value is MemoSection {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateItems(items: unknown, depth: number): asserts items is Memo {
    if (!Array.isArray(items)) throw new Error("Memo items must be an array")

    const topics = new Set<string>()
    const strings = new Set<string>()
    let sawTopic = false
    for (const item of items) {
        if (typeof item === "string") {
            if (sawTopic) throw new Error("Memo strings must precede topics")
            if (strings.has(item)) throw new Error(`Duplicate memo string: ${JSON.stringify(item)}`)
            strings.add(item)
            continue
        }
        sawTopic = true
        if (!isSection(item) || typeof item.topic !== "string" || !Array.isArray(item.items)) {
            throw new Error("Memo section must have a topic string and items array")
        }
        if (!item.topic.trim() || item.topic.includes("/"))
            throw new Error(`Invalid memo topic: ${item.topic}`)
        if (topics.has(item.topic)) throw new Error(`Duplicate memo topic: ${item.topic}`)
        topics.add(item.topic)
        if (depth >= MAX_DEPTH) throw new Error("Memo topic depth exceeds six levels")
        validateItems(item.items, depth + 1)
    }
}

export function validateMemo(value: unknown): asserts value is Memo {
    validateItems(value, 0)
}

function cloneMemo(memo: Memo): Memo {
    return memo.map((item) =>
        typeof item === "string" ? item : { topic: item.topic, items: cloneMemo(item.items) },
    )
}

function splitTopicPath(path: string): string[] {
    const parts = path.split("/")
    if (parts.some((part) => !part.trim())) throw new Error(`Invalid memo topic path: ${path}`)
    return parts
}

function getItemsAtPath(memo: Memo, path?: string): Memo {
    if (path === undefined) return memo
    let items = memo
    for (const part of splitTopicPath(path)) {
        const section = items.find(
            (item): item is MemoSection => typeof item !== "string" && item.topic === part,
        )
        if (!section) throw new Error(`Memo topic not found: ${path}`)
        items = section.items
    }
    return items
}

function getSection(memo: Memo, path: string): MemoSection {
    const parts = splitTopicPath(path)
    const topic = parts.pop()!
    const items = getItemsAtPath(memo, parts.length ? parts.join("/") : undefined)
    const section = items.find(
        (item): item is MemoSection => typeof item !== "string" && item.topic === topic,
    )
    if (!section) throw new Error(`Memo topic not found: ${path}`)
    return section
}

function validateNewContent(content: MemoContent, parentDepth: number): void {
    validateItems([content], parentDepth)
}

function removeString(memo: Memo, path: string): Memo {
    const delimiter = path.indexOf("//")
    if (delimiter < 0) throw new Error(`Memo topic not found: ${path}`)
    const topicPath = path.slice(0, delimiter)
    const prefix = path.slice(delimiter + 2)
    const items = getItemsAtPath(memo, topicPath || undefined)
    const matches = items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => typeof item === "string" && item.startsWith(prefix))
    if (matches.length === 0) throw new Error(`Memo string not found: ${path}`)
    if (matches.length > 1) throw new Error(`Memo string prefix is ambiguous: ${path}`)
    items.splice(matches[0]!.index, 1)
    return memo
}

function normalizeContent(content: MemoContent, warnings: string[]): MemoContent {
    if (typeof content === "string") return content
    if (!isSection(content) || typeof content.topic !== "string" || !Array.isArray(content.items)) {
        throw new Error("Memo section must have a topic string and items array")
    }
    const normalized = content.items.map((item) => normalizeContent(item, warnings))
    let sawTopic = false
    let needsReorder = false
    for (const item of normalized) {
        if (typeof item === "string") {
            if (sawTopic) needsReorder = true
        } else {
            sawTopic = true
        }
    }
    if (needsReorder) warnings.push(`Normalized item order in topic ${content.topic}`)
    const sorted = [
        ...normalized.filter((item): item is string => typeof item === "string"),
        ...normalized.filter((item): item is MemoSection => typeof item !== "string"),
    ]
    return { topic: content.topic, items: sorted }
}

export function editMemo(memo: Memo, edit: MemoEdit): { memo: Memo; warnings: string[] } {
    validateMemo(memo)
    const result = cloneMemo(memo)
    const warnings: string[] = []

    if (edit.type === "append") {
        const parentPath = edit.parent
        const parentDepth = parentPath === undefined ? 0 : splitTopicPath(parentPath).length
        const items = getItemsAtPath(result, parentPath)
        const content = normalizeContent(edit.content, warnings)
        validateNewContent(content, parentDepth)
        if (edit.after === undefined) {
            if (typeof content === "string") {
                const insertion = items.findIndex((item) => typeof item !== "string")
                items.splice(insertion < 0 ? items.length : insertion, 0, content)
            } else {
                items.push(content)
            }
        } else {
            const afterParts = splitTopicPath(edit.after)
            const afterTopic = afterParts.pop()!
            const afterParent = afterParts.join("/")
            if ((parentPath ?? "") !== afterParent) {
                throw new Error("Memo after topic must be a direct child of the specified parent")
            }
            const afterIndex = items.findIndex(
                (item) => typeof item !== "string" && item.topic === afterTopic,
            )
            if (afterIndex < 0) throw new Error(`Memo after topic not found: ${edit.after}`)
            if (typeof content === "string") {
                const insertion = items.findIndex((item) => typeof item !== "string")
                items.splice(insertion < 0 ? items.length : insertion, 0, content)
                warnings.push(
                    `String anchored after ${afterTopic} was relocated to the string portion`,
                )
            } else {
                items.splice(afterIndex + 1, 0, content)
            }
        }
        validateItems(items, parentDepth)
        return { memo: result, warnings }
    }

    if (edit.type === "remove") {
        const delimiter = edit.path.indexOf("//")
        if (delimiter >= 0) {
            removeString(result, edit.path)
            return { memo: result, warnings }
        }
        const parts = splitTopicPath(edit.path)
        const topic = parts.pop()!
        const items = getItemsAtPath(result, parts.length ? parts.join("/") : undefined)
        const index = items.findIndex((item) => typeof item !== "string" && item.topic === topic)
        if (index < 0) throw new Error(`Memo topic not found: ${edit.path}`)
        items.splice(index, 1)
        return { memo: result, warnings }
    }

    if (edit.path === undefined) throw new Error("Memo clear requires a topic path")
    getSection(result, edit.path).items = []
    return { memo: result, warnings }
}

function addParsedString(items: Memo, value: string): void {
    const duplicates = items
        .map((item, index) => ({ item, index }))
        .filter(
            ({ item }) =>
                typeof item === "string" &&
                (item === value ||
                    (item.startsWith(`${value}\n`) &&
                        item.split("\n").every((line) => line === value))),
        )
    if (duplicates.length === 0) {
        items.push(value)
        return
    }
    const occurrences = duplicates.reduce(
        (total, { item }) => total + (item as string).split("\n").length,
        1,
    )
    for (const { index } of duplicates.reverse()) items.splice(index, 1)
    const merged = Array.from({ length: occurrences }, () => value).join("\n")
    items.push(merged)
}

export function parseMemo(markdown: string): Memo {
    const root: Memo = []
    const stack: Array<{ depth: number; section: MemoSection }> = []
    let currentText: string[] = []
    let textType: "paragraph" | "bullet" | null = null
    let bulletIndent = 0
    let pendingBulletBlanks = 0
    let fenced: string[] | null = null
    let fenceToken = ""

    const currentItems = (): Memo => stack.at(-1)?.section.items ?? root
    const flushText = () => {
        if (currentText.length) addParsedString(currentItems(), currentText.join("\n"))
        currentText = []
        textType = null
        pendingBulletBlanks = 0
    }
    const addTopic = (depth: number, rawName: string) => {
        flushText()
        while (stack.length && stack.at(-1)!.depth >= depth) stack.pop()
        let parentItems = currentItems()
        const parentDepth = stack.length
        if (depth > MAX_DEPTH || parentDepth >= MAX_DEPTH) {
            currentText = [`${"#".repeat(depth)} ${rawName}`]
            textType = "paragraph"
            return
        }
        let topic = rawName.trim().replaceAll("/", "-").trim()
        if (!topic) topic = "Topic"
        const base = topic
        let suffix = 2
        while (parentItems.some((item) => typeof item !== "string" && item.topic === topic)) {
            topic = `${base} (${suffix})`
            suffix += 1
        }
        const section: MemoSection = { topic, items: [] }
        parentItems.push(section)
        stack.push({ depth, section })
    }

    const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
    for (const line of lines) {
        if (fenced) {
            fenced.push(line)
            if (new RegExp(`^\\s*${fenceToken}`).test(line)) {
                addParsedString(currentItems(), fenced.join("\n"))
                fenced = null
            }
            continue
        }

        if (textType === "bullet") {
            if (!line.trim()) {
                pendingBulletBlanks += 1
                continue
            }
            const indentation = line.match(/^\s*/)?.[0].length ?? 0
            if (indentation >= bulletIndent + 2) {
                for (let index = 0; index < pendingBulletBlanks; index += 1) currentText.push("")
                pendingBulletBlanks = 0
                currentText.push(line.slice(bulletIndent + 2))
                continue
            }
            flushText()
        }

        const fence = line.match(/^\s*(`{3,}|~{3,})/)
        if (fence) {
            flushText()
            fenced = [line]
            fenceToken = fence[1]![0]!.repeat(fence[1]!.length)
            continue
        }

        const heading = line.match(/^(#{1,})(?:\s+|$)(.*)$/)
        if (heading) {
            const depth = heading[1]!.length
            if (depth <= MAX_DEPTH) addTopic(depth, heading[2]!)
            else {
                flushText()
                currentText = [line]
                textType = "paragraph"
            }
            continue
        }

        if (!line.trim()) {
            flushText()
            continue
        }

        const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/)
        if (bullet) {
            flushText()
            currentText = [bullet[2]!]
            textType = "bullet"
            bulletIndent = bullet[1]!.length
            continue
        }

        if (textType === "paragraph") {
            currentText.push(line)
        } else {
            flushText()
            currentText = [line]
            textType = "paragraph"
        }
    }
    if (textType === "bullet") {
        for (let index = 0; index < pendingBulletBlanks; index += 1) currentText.push("")
    }
    if (fenced) addParsedString(currentItems(), fenced.join("\n"))
    flushText()

    return root
}

export function renderMemo(memo: Memo): string {
    validateMemo(memo)
    const lines: string[] = []
    const renderItems = (items: Memo, depth: number) => {
        for (const item of items) {
            if (typeof item === "string") {
                const contentLines = item.split("\n")
                lines.push(`- ${contentLines[0]}`)
                for (const continuation of contentLines.slice(1)) {
                    lines.push(`  ${continuation}`)
                }
            } else {
                lines.push(`${"#".repeat(depth + 1)} ${item.topic}`)
                renderItems(item.items, depth + 1)
            }
        }
    }
    renderItems(memo, 0)
    return lines.join("\n")
}
