import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { createServer as httpServer } from 'node:http'
import { parseAst } from 'rollup/parseAst'

// Real hook callbacks with scripted, in-memory query responses; no data client.
export async function storeFixture(secure, run, initialTransactions) {
  const vite = await createServer({
    configFile: false, envFile: false, cacheDir: '/private/tmp/skupy-store-safety-test',
    server: { middlewareMode: true, hmr: { server: httpServer() }, watch: null },
    plugins: [{ name: 'synthetic-data-only', enforce: 'pre',
      transform(code, id) {
        if (initialTransactions === undefined || !id.endsWith('/src/hooks/useStore.js')) return
        const hook = parseAst(code).body.find(n => n.type === 'ExportNamedDeclaration' && n.declaration?.id?.name === 'useStore').declaration
        const state = hook.body.body.flatMap(n => n.type === 'VariableDeclaration' ? n.declarations : [])
          .find(n => n.id.type === 'ArrayPattern' && n.id.elements[0]?.name === 'transactions')
        if (state?.init?.callee?.name !== 'useState' || state.init.arguments[0]?.type !== 'ArrayExpression') throw new Error('Unsupported transaction fixture initializer')
        const value = state.init.arguments[0]
        return { code: code.slice(0, value.start) + JSON.stringify(initialTransactions) + code.slice(value.end), map: null }
      },
      resolveId(id) { if (/(^|\/)lib\/supabase(?:\.js)?$/.test(id)) return '\0synthetic-supabase' },
      load(id) {
        if (id !== '\0synthetic-supabase') return
        return `
          export const secureAuthEnabled = ${secure};
          export const isSupabaseConfigured = false;
          export const calls = [];
          export const requests = [];
          export const script = [];
          export const outcome = { data: { id: 'customer', name: 'Uji' }, error: null, count: 0, tables: {} };
          export const uploadLogo = () => { throw new Error('Unexpected upload') };
          export const deleteLogo = uploadLogo;
          export const getDataClient = () => ({ from(table) {
            const steps = [];
            const query = { then(resolve, reject) {
              requests.push({ table, steps });
              let response = { data: outcome.data, error: outcome.error, count: outcome.count, ...outcome.tables[table] };
              if (script.length) response = script.shift();
              return (response instanceof Error ? Promise.reject(response) : Promise.resolve(response)).then(resolve, reject);
            } };
            for (const method of ['select','insert','update','delete','eq','is','in','order','limit','single','maybeSingle']) {
              query[method] = (...args) => { const step = { table, method, args }; calls.push(step); steps.push(step); return query };
            }
            return query;
          } });
        `
      },
    }],
  })
  try {
    const { useStore } = await vite.ssrLoadModule('/src/hooks/useStore.js')
    const data = await vite.ssrLoadModule('/src/lib/supabase')
    let store
    function Capture() { store = useStore({ user: { id: 'owner', role: 'owner' } }); return null }
    renderToStaticMarkup(React.createElement(Capture))
    await run(store, data)
  } finally { await vite.close() }
}
