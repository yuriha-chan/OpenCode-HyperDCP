import type { Plugin } from "@opencode/plugin/tui"

export type NotificationToastVariant = "info" | "success" | "warning" | "error"

export type NotificationLocation = NonNullable<Plugin.Context["location"]>

export type NotificationToast = {
    sessionID: string
    title: string
    message: string
    variant: NotificationToastVariant
    duration: number
}

type NotificationToastPayload = NotificationToast & {
    workspaceID?: NotificationLocation["workspaceID"]
}

export type NotificationRpcClient = Pick<Plugin.Context["client"], "rpc">

export const notificationRpc = {
    id: "hyperdcp-notifications",
    methods: {},
    events: {
        toast: {
            schema: {
                type: "object",
                required: ["sessionID", "title", "message", "variant", "duration"],
                properties: {
                    sessionID: { type: "string" },
                    workspaceID: { type: "string" },
                    title: { type: "string" },
                    message: { type: "string" },
                    variant: {
                        type: "string",
                        enum: ["info", "success", "warning", "error"],
                    },
                    duration: { type: "number" },
                },
                additionalProperties: false,
            },
        },
    },
} as const

export function subscribeNotificationToasts(
    client: NotificationRpcClient,
    location: NotificationLocation,
    showToast: (toast: NotificationToast) => void,
): () => void {
    const registration = client.rpc(notificationRpc)
    return registration.events.on("toast", (event) => {
        if (event.location.directory !== location.directory) return
        // The host validates this JSON Schema payload but exposes it as a record.
        const { workspaceID, ...toast } = event.data as NotificationToastPayload
        if (workspaceID !== location.workspaceID) return
        showToast(toast)
    })
}
