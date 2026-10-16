import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: {
    'import.meta.env.VITE_SPICE_DEPLOYMENT_ID': JSON.stringify('test'),
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Every test starts with real globals and unspied functions, so no file restores them itself.
    restoreMocks: true,
    unstubGlobals: true,
  },
})
