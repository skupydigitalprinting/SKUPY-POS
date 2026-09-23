import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

// Serve actual views with only a synthetic security flag, never a Supabase client.
const vite = await createServer({
  root: fileURLToPath(new URL('../..', import.meta.url)), configFile: false, envFile: false,
  cacheDir: '/private/tmp/skupy-customer-ui-cache',
  plugins: [react(), { name: 'synthetic-customer-only', enforce: 'pre',
    resolveId(id) { if (/(^|\/)lib\/supabase(?:\.js)?$/.test(id)) return '\0synthetic-supabase' },
    load(id) { if (id === '\0synthetic-supabase') return `
      export const secureAuthEnabled = true;
      export const isSupabaseConfigured = false;
      export const isDataSessionActive = () => false;
      export const onDataSessionReset = () => () => {};
      export const getDataClient = () => { throw new Error('No business client in synthetic UI'); };
    ` },
  }],
  server: { host: '127.0.0.1', port: 0 },
})
await vite.listen()
console.log(`Synthetic customer preview: http://127.0.0.1:${vite.httpServer.address().port}/tools/security-lab/customer-ui-review.html`)
let closing = false
async function close() { if (!closing) { closing = true; await vite.close() } }
process.on('SIGINT', close)
process.on('SIGTERM', close)
