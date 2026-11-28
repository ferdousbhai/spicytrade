import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig } from 'vite'

// The packages resolve from the repository root's node_modules. `ops/shared/temporary-worker.sh`
// runs `vite build` here and deploys the output with `cf deploy --prebuilt`.
export default defineConfig({ plugins: [cloudflare()] })
