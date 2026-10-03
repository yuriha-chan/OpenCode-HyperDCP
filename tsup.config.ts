import { defineConfig } from "tsup"
import { readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const solidTransformPath = join(
    realpathSync(join(process.cwd(), "node_modules", "@opentui", "solid")),
    "scripts",
    "solid-transform.js",
)

async function transformTuiSource(code: string, filename: string): Promise<string> {
    const { transformSolidSource } = (await import(pathToFileURL(solidTransformPath).href)) as {
        transformSolidSource: (input: string, options: { filename: string; moduleName?: string }) => Promise<string>
    }
    return transformSolidSource(code, { filename, moduleName: "@opentui/solid" })
}

const solidTransformPlugin = {
    name: "opentui-solid-transform",
    setup(build: {
        onLoad: (
            options: { filter: RegExp },
            callback: (args: { path: string }) => Promise<{ contents: string; loader: "js" } | undefined>,
        ) => void
    }) {
        build.onLoad({ filter: /[/\\]src[/\\].*\.tsx$/ }, async (args) => {
            const source = readFileSync(args.path, "utf8")
            const contents = await transformTuiSource(source, args.path)
            return { contents, loader: "js" as const }
        })
    },
}

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
        esbuildPlugins: [solidTransformPlugin as never],
        esbuildOptions(options) {
            options.jsx = "automatic"
            options.jsxImportSource = "@opentui/solid"
        },
    },
])
