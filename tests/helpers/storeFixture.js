import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { createServer as httpServer } from 'node:http'
import { parseAst } from 'rollup/parseAst'

// Real hook callbacks with scripted, in-memory query responses; no data client.
export async function storeFixture(secure, run, initialTransactions, options = {}) {
  const vite = await createServer({
    configFile: false, envFile: false, cacheDir: '/private/tmp/skupy-store-safety-test',
    define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://synthetic.supabase.co') },
    server: { middlewareMode: true, hmr: { server: httpServer() }, watch: null },
    plugins: [{ name: 'synthetic-data-only', enforce: 'pre',
      transform(code, id) {
        if (!id.endsWith('/src/hooks/useStore.js')) return
        const hook = parseAst(code).body.find(n => n.type === 'ExportNamedDeclaration' && n.declaration?.id?.name === 'useStore').declaration
        const states = hook.body.body.flatMap(n => n.type === 'VariableDeclaration' ? n.declarations : [])
          .filter(n => n.id.type === 'ArrayPattern' && n.init?.callee?.name === 'useState')
        for (const state of states.reverse()) {
          let expression = code.slice(state.init.start, state.init.end)
          if (state.id.elements[0]?.name === 'transactions' && initialTransactions !== undefined) expression = `useState(${JSON.stringify(initialTransactions)})`
          if (state.id.elements[0]?.name === 'activeBookId' && options.initialBookId !== undefined) expression = `useState(${JSON.stringify(options.initialBookId)})`
          if (options.observe) expression = `observeState('${state.id.elements[0].name}',${expression})`
          code = code.slice(0, state.init.start) + expression + code.slice(state.init.end)
        }
        if (options.observe) code = "import { observeState } from '../lib/supabase';\n" + code
        return { code, map: null }
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
          export const stateWrites = [];
          export const observeState = (name, pair) => [pair[0], value => {
            const previous = stateWrites.filter(row => row.name === name).at(-1)?.value ?? pair[0];
            stateWrites.push({ name, value: typeof value === 'function' ? value(previous) : value });
            pair[1](value);
          }];
          export const rpcScript = [];
          export const outcome = { data: { id: 'customer', name: 'Uji' }, error: null, count: 0, tables: {} };
          export const uploadLogo = () => { throw new Error('Unexpected upload') };
          export const deleteLogo = uploadLogo;
          export const getDataClient = () => ({ rpc: async (name, args) => {
            requests.push({ rpc: name, args });
            return rpcScript.shift()(name, args);
          }, from(table) {
            const steps = [];
            const query = { then(resolve, reject) {
              requests.push({ table, steps });
              let response = { data: outcome.data, error: outcome.error, count: outcome.count, ...outcome.tables[table] };
              if (script.length) response = script.shift();
              return (response instanceof Error ? Promise.reject(response) : Promise.resolve(response)).then(resolve, reject);
            } };
            for (const method of ['select','insert','update','delete','eq','is','in','order','limit','range','single','maybeSingle']) {
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
    function Capture() { store = useStore(options.verifiedSession || { user: { id: 'owner', role: 'owner' } }); return null }
    renderToStaticMarkup(React.createElement(Capture))
    await run(store, data)
  } finally { await vite.close() }
}
