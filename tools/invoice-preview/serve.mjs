import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const server = await createServer({ root, configFile: false, envFile: false,
  cacheDir: `/private/tmp/skupy-invoice-preview-${process.pid}`,
  server: { host: '127.0.0.1', port: 5196, strictPort: true },
  optimizeDeps: { entries: ['tools/invoice-preview/index.html'] },
  plugins: [{ name: 'synthetic-invoice-only', enforce: 'pre',
    resolveId(id) {
      if (/(^|\/)lib\/supabase(?:\.js)?$/.test(id)) return '\0invoice-preview-flags'
      if (/(supabase|useStore|posAuth)/i.test(id)) return '\0invoice-data-blocked'
    },
    load(id) {
      if (id === '\0invoice-preview-flags') return `export const secureAuthEnabled = true;
        export const isSupabaseConfigured = false;
        export const isDataSessionActive = () => false;
        export const onDataSessionReset = () => () => {};
        export const getDataClient = () => { throw new Error('No data client in synthetic preview') };
        export const uploadInvoiceImage = () => { throw new Error('No production upload in synthetic preview') };`
      // Tailwind resolves watched files without importing them. Block execution,
      // while allowing its CSS dependency tracking to resolve safely.
      if (id === '\0invoice-data-blocked') return "throw new Error('Production data client forbidden in invoice preview')"
    },
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:5196; font-src 'self'; frame-src 'none'")
        next()
      })
    },
  }],
})
await server.listen()
console.log('http://127.0.0.1:5196/tools/invoice-preview/index.html')
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0) })
