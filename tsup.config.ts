import { defineConfig } from "tsup"

export default defineConfig([
    {
        entry: ["index.ts"],
        format: ["esm"],
        dts: false,
        clean: true,
        sourcemap: true,
        noExternal: ["jsonc-parser"],
    },
    {
        entry: ["src/tui.tsx"],
        format: ["esm"],
        dts: false,
        clean: false,
        sourcemap: true,
        external: [
            "@opencode-ai/plugin/tui",
            "@opentui/solid",
            "@opentui/core",
            "solid-js",
            "node:fs",
            "node:os",
            "node:path",
            "node:child_process",
        ],
        esbuildOptions(options) {
            options.jsx = "automatic"
            options.jsxImportSource = "@opentui/solid"
        },
    },
])
