export interface ToolExecutionContext {
    sessionID: string
    messageID: string
    callID?: string
}

export function operationIdentity(messageID: string, callID: string): string {
    return `${messageID}\0${callID}`
}
