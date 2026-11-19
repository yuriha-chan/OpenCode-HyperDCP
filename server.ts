import server from "./index"
import { getConfig } from "./lib/config"
import { Logger } from "./lib/logger"
import { prepareModelContext, type ModelContextRequest } from "./lib/model-context"
import { loadSessionState, restoreHousekeepingTransaction } from "./lib/state/persistence"

type SessionContextRequest = ModelContextRequest & { sessionID: string }

interface HostContext {
    location: { directory: string }
    session: {
        hook(name: "context", callback: (request: SessionContextRequest) => Promise<void>): Promise<unknown>
    }
}

const definition = {
    id: "@architectural-composition/opencode-hyperdcp",
    server,
    setup: async ({ location, session }: HostContext) => {
        const config = getConfig(location)
        if (!config.enabled) return
        const logger = new Logger(config.debug)
        await session.hook("context", async (request) => {
            const state = request.sessionID ? await loadSessionState(request.sessionID, logger) : null
            const history = (state?.housekeepingHistory ?? []).flatMap((value) => {
                const transaction = restoreHousekeepingTransaction(value)
                return transaction !== null && transaction.sessionId === request.sessionID ? [transaction] : []
            })
            prepareModelContext(request, history)
        })
    },
}

export default definition
