export type NotificationToastVariant = "info" | "success" | "warning" | "error"

export type NotificationLocation = {
    directory: string
    workspaceID?: string
}

export type NotificationToast = {
    sessionID: string
    title: string
    message: string
    variant: NotificationToastVariant
    duration: number
}

export type NotificationToastEvent = {
    location: NotificationLocation
    data: NotificationToast
}

export type NotificationRpcClient = {
    rpc(definition: typeof notificationRpc): {
        events: {
            on(name: "toast", handler: (event: NotificationToastEvent) => void): () => void
        }
    }
}

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
        if (event.location.workspaceID !== location.workspaceID) return
        showToast(event.data)
    })
}
