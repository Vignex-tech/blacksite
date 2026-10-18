import { defineConfig, searchForWorkspaceRoot } from 'vite'
import { fileURLToPath } from 'node:url'

// The client imports the client/server contract from ../shared, which is
// outside client/. Let the dev server read it (the build bundles it anyway).
export default defineConfig({
  server: {
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), fileURLToPath(new URL('../shared', import.meta.url))],
    },
  },
})
