export function ignoredSender(
    client: {
        session: {
            prompt(input: {
                path?: { id: string }
                body: { parts: Array<{ type: "text"; text: string; ignored: true }> }
            }): Promise<unknown>
        }
    },
    sessionID: string,
) {
    return async (text: string): Promise<void> => {
        await client.session.prompt({
            path: { id: sessionID },
            body: { parts: [{ type: "text", text, ignored: true }] },
        })
    }
}
