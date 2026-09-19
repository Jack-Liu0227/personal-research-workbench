import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        // `exclude` means "bundle this, do not leave it as a require()".
        //
        // `@earendil-works/pi-ai` is the subtle one. The embedded SDK declares
        // it as a dependency, so `externalizeDepsPlugin` would externalize it
        // by default and emit `require('@earendil-works/pi-ai')` — but the
        // package is ESM-only with no `require` condition, so that call throws
        // and takes `@prw/ai-runtime` down with it. It is bundled here instead,
        // exactly as it was before the SDK was added to `apps/desktop`.
        // `@earendil-works/pi-coding-agent` is deliberately NOT in this list:
        // it must stay external, and the single `import()` that loads it lives
        // in packages/agent-runtime/src/pi/loader.ts.
        exclude: [
          '@prw/agent-runtime',
          '@prw/ai-runtime',
          '@prw/contracts',
          '@prw/domain',
          '@prw/database',
          '@prw/connectors',
          '@prw/workspace-core',
          '@prw/workspace-mcp',
          '@prw/workspace-service',
          '@earendil-works/pi-ai'
        ]
      })
    ],
    build: {
      rollupOptions: {
        // Pi's SDK must stay external. It is ESM-only, loads wasm
        // (@silvia-odwyer/photon-node), resolves assets relative to
        // import.meta.url, and pulls TypeScript configs through jiti at
        // runtime — all of which break inside a bundled CJS worker. The
        // single supported dynamic import lives in
        // packages/agent-runtime/src/pi/loader.ts; Rollup keeps it as a real
        // dynamic import() in the CJS output.
        external: [
          'better-sqlite3',
          '@earendil-works/pi-coding-agent',
          /^@modelcontextprotocol\//u,
          /^@silvia-odwyer\//u,
          'typebox',
          'jiti',
          'proper-lockfile'
        ],
        input: {
          index: resolve('src/main/index.ts'),
          'core-worker': resolve('src/core/worker.ts')
        },
        output: {
          entryFileNames: '[name].cjs',
          format: 'cjs',
          dynamicImportInCjs: true
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@prw/contracts', 'zod'] })],
    build: {
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        output: {
          entryFileNames: 'index.cjs',
          format: 'cjs'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
