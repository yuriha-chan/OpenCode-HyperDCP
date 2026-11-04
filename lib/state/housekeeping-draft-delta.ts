export interface DeltaChange {
    path: string[]
    value?: unknown
    remove?: true
}

export interface DeltaEnvelope {
    baseSnapshotId: string
    changes: DeltaChange[]
}

const hasOwn = (value: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key)

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && "value" in descriptor ? descriptor.value : undefined
}

function cloneJson(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value))
}

function sameOrder(left: string[], right: string[]): boolean {
    if (left.length !== right.length) return false
    for (let index = 0; index < left.length; index++) {
        if (left[index] !== right[index]) return false
    }
    return true
}

function equalJson(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right)
}

function invalidChange(index: number, detail: string): never {
    throw new Error(`Invalid housekeeping draft delta change at index ${index}: ${detail}.`)
}

function diffValue(
    path: string[],
    base: unknown,
    target: unknown,
    changes: DeltaChange[],
    isRoot: boolean,
): void {
    if (isPlainRecord(base) && isPlainRecord(target)) {
        const baseKeys = Object.keys(base)
        const targetKeys = Object.keys(target)
        const baseSet = new Set(baseKeys)
        const targetSet = new Set(targetKeys)

        if (!isRoot) {
            const predicted = baseKeys.filter((key) => targetSet.has(key))
            for (const key of targetKeys) {
                if (!baseSet.has(key)) predicted.push(key)
            }
            if (!sameOrder(predicted, targetKeys)) {
                changes.push({ path: [...path], value: target })
                return
            }
        }

        for (const key of baseKeys) {
            if (!targetSet.has(key)) changes.push({ path: [...path, key], remove: true })
        }
        for (const key of targetKeys) {
            const childPath = [...path, key]
            if (!baseSet.has(key)) {
                changes.push({ path: childPath, value: ownValue(target, key) })
                continue
            }
            diffValue(childPath, ownValue(base, key), ownValue(target, key), changes, false)
        }
        return
    }

    if (!equalJson(base, target)) changes.push({ path: [...path], value: target })
}

export function diffJsonValues(base: unknown, target: unknown): DeltaChange[] {
    const changes: DeltaChange[] = []
    diffValue([], cloneJson(base), cloneJson(target), changes, true)
    return changes
}

interface ParsedChange {
    path: string[]
    remove: boolean
    value?: unknown
}

function parseChange(raw: unknown, index: number): ParsedChange {
    if (!isPlainRecord(raw)) invalidChange(index, "change is not an object")
    if (!Array.isArray(raw.path) || raw.path.length === 0)
        invalidChange(index, "path is not a non-empty array")
    if (!raw.path.every((segment) => typeof segment === "string"))
        invalidChange(index, "path contains a non-string segment")

    const hasValue = hasOwn(raw, "value")
    const hasRemove = hasOwn(raw, "remove")
    if (hasValue && hasRemove) invalidChange(index, "change has both value and remove")
    if (hasValue) return { path: [...(raw.path as string[])], remove: false, value: raw.value }
    if (!hasRemove) invalidChange(index, "change has neither value nor remove")
    if (raw.remove !== true) invalidChange(index, "remove is not true")
    return { path: [...(raw.path as string[])], remove: true }
}

function parentFor(root: unknown, path: string[], index: number): Record<string, unknown> {
    let current: unknown = root
    for (let position = 0; position < path.length - 1; position++) {
        const segment = path[position]!
        if (!isPlainRecord(current))
            invalidChange(index, "parent path does not reference an object")
        if (!hasOwn(current, segment))
            invalidChange(index, "parent path does not reference an own property")
        const descriptor = Object.getOwnPropertyDescriptor(current, segment)
        if (!descriptor || !("value" in descriptor) || !isPlainRecord(descriptor.value as unknown))
            invalidChange(index, "parent path does not reference a safe object")
        current = descriptor.value
    }
    if (!isPlainRecord(current)) invalidChange(index, "parent path does not reference an object")
    return current
}

function applyChange(root: unknown, raw: unknown, index: number): void {
    const change = parseChange(raw, index)
    const parent = parentFor(root, change.path, index)
    const key = change.path[change.path.length - 1]!

    if (change.remove) {
        if (!hasOwn(parent, key))
            invalidChange(index, "cannot remove property that is not an own property")
        delete parent[key]
        return
    }

    Object.defineProperty(parent, key, {
        value: cloneJson(change.value),
        enumerable: true,
        configurable: true,
        writable: true,
    })
}

export function applyDeltaChanges(base: unknown, changes: unknown): unknown {
    if (!Array.isArray(changes))
        throw new Error("Invalid housekeeping draft delta: changes is not an array.")
    const draft = cloneJson(base)
    changes.forEach((change, index) => applyChange(draft, change, index))
    return draft
}
