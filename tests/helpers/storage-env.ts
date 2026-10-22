import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after } from "node:test"

const root = mkdtempSync(join(tmpdir(), "hyperdcp-test-storage-"))
const previous = {
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
}
process.env.XDG_DATA_HOME = root
process.env.XDG_CONFIG_HOME = root
delete process.env.OPENCODE_CONFIG_DIR

after(() => {
    for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
    }
    rmSync(root, { recursive: true, force: true })
})
