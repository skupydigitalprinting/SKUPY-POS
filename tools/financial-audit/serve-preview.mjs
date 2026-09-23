import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const vite = await createServer({ root, configFile: false, envFile: false,
  cacheDir: `/private/tmp/skupy-financial-ui-${process.pid}`,
  server: { host: '127.0.0.1', port: 5192, strictPort: true },
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { entries: ['tools/financial-audit/preview.html'] },
  plugins: [{ name: 'no-real-financial-client', enforce: 'pre',
    resolveId(id) {
      if (/(^|\/)lib\/supabase(?:\.js)?$/.test(id)) return '\0financial-no-client'
      if (id === '@supabase/supabase-js') throw new Error('Real data SDK forbidden in synthetic preview')
    },
    load(id) {
      if (id !== '\0financial-no-client') return
      return `export const secureAuthEnabled = false;
        export const isSupabaseConfigured = false;
        export const isDataSessionActive = () => false;
        export const onDataSessionReset = () => () => {};
        export const uploadInvoiceFile = () => { throw new Error('Upload forbidden') };
        export const getDataClient = () => window.financialPreviewClient;`
    },
  }],
})
await vite.listen()
console.log('Synthetic financial preview: http://127.0.0.1:5192/tools/financial-audit/preview.html')
process.on('SIGINT', async () => { await vite.close(); process.exit(0) })
process.on('SIGTERM', async () => { await vite.close(); process.exit(0) })
