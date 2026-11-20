import assert from "node:assert/strict"
import test from "node:test"
import { notificationRpc, subscribeNotificationToasts } from "../lib/notification-rpc"

function createRpcSurface() {
    const definitions: any[] = []
    const handlers = new Map<string, (event: any) => void>()
    let unsubscribeCount = 0
    const client = {
        rpc(definition: any) {
            definitions.push(definition)
            return {
                events: {
                    on(name: string, handler: (event: any) => void) {
                        handlers.set(name, handler)
                        return () => {
                            unsubscribeCount += 1
                            handlers.delete(name)
                        }
                    },
                },
            }
        },
    }
    return {
        client,
        definitions,
        emit(name: string, event: any) {
            handlers.get(name)?.(event)
        },
        unsubscribeCount() {
            return unsubscribeCount
        },
        handlerCount() {
            return handlers.size
        },
    }
}

const toastPayload = {
    sessionID: "ses_notification_target",
    title: "DCP: Compress Notification",
    message: "▣ DCP | -1.2K removed, +80 summary",
    variant: "info" as const,
    duration: 5000,
}

test("native notification subscription shows matching-location toasts and unsubscribes", () => {
    const surface = createRpcSurface()
    const shown: any[] = []

    const unsubscribe = subscribeNotificationToasts(
        surface.client as any,
        { directory: "/workspace/a", workspaceID: "ws_a" },
        (toast) => shown.push(toast),
    )

    assert.equal(surface.definitions.length, 1)
    assert.equal(surface.definitions[0], notificationRpc)
    assert.equal(notificationRpc.id, "hyperdcp-notifications")
    assert.deepEqual(notificationRpc.methods, {})
    assert.equal(notificationRpc.events.toast.schema.type, "object")
    assert.deepEqual([...notificationRpc.events.toast.schema.required].sort(), [
        "duration",
        "message",
        "sessionID",
        "title",
        "variant",
    ])
    assert.equal(surface.handlerCount(), 1)

    surface.emit("toast", {
        location: { directory: "/workspace/a" },
        data: { ...toastPayload, workspaceID: "ws_a" },
    })
    assert.deepEqual(shown, [toastPayload])
    assert.equal(surface.unsubscribeCount(), 0)

    unsubscribe()
    assert.equal(surface.unsubscribeCount(), 1)
    assert.equal(surface.handlerCount(), 0)

    surface.emit("toast", {
        location: { directory: "/workspace/a" },
        data: { ...toastPayload, workspaceID: "ws_a" },
    })
    assert.deepEqual(shown, [toastPayload])
})

test("native notification subscription ignores toasts from another location", () => {
    const surface = createRpcSurface()
    const shown: any[] = []

    subscribeNotificationToasts(
        surface.client as any,
        { directory: "/workspace/a", workspaceID: "ws_a" },
        (toast) => shown.push(toast),
    )

    surface.emit("toast", {
        location: { directory: "/workspace/b" },
        data: { ...toastPayload, workspaceID: "ws_a" },
    })
    surface.emit("toast", {
        location: { directory: "/workspace/a" },
        data: { ...toastPayload, workspaceID: "ws_b" },
    })
    surface.emit("toast", {
        location: { directory: "/workspace/a" },
        data: toastPayload,
    })
    assert.deepEqual(shown, [])

    surface.emit("toast", {
        location: { directory: "/workspace/a" },
        data: { ...toastPayload, workspaceID: "ws_a" },
    })
    assert.deepEqual(shown, [toastPayload])
})
