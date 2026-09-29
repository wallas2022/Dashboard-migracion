import dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoData } from './demo-data.js';
import { configFor, queries, withPool, classifySqlError, serializeSqlError } from './sql.js';
import { dashboardResponse } from './dashboard.js';
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../.env') });
const app = express();
app.disable('x-powered-by');
const mode = process.env.DASHBOARD_MODE || 'demo';
const localEnabled = process.env.LOCAL_ENABLED === 'true';
if (!['demo', 'live'].includes(mode)) throw new Error('DASHBOARD_MODE debe ser demo o live');
async function collect(prefix) {
  return withPool(configFor(prefix), async adapter => {
    const environment = (await adapter.query(queries.environment))[0];
    if (!environment) throw new Error('Base TerraController no encontrada o no visible');
    const result = { environment, queryWarnings: [] };
    const names = ['tables', 'jobs', ...(prefix === 'LOCAL' ? ['restoreHistory', 'validation'] : prefix === 'HUAWEI' ? ['restoreHistory', 'latestBusinessPoint'] : ['latestBusinessPoint'])];
    for (const name of names) {
      const field = name === 'restoreHistory' ? 'history' : name;
      try { const rows = await adapter.query(queries[name]); result[field] = ['validation', 'latestBusinessPoint'].includes(name) ? rows[0] || null : rows; }
      catch (error) { result[field] = null; result.queryWarnings.push({ query: name, error }); }
    }
    return result;
  });
}
app.get('/api/health', (_req, res) => res.json({ status: 'ok', mode }));
let pending;
app.get('/api/dashboard', async (_req, res) => {
  if (mode === 'demo') return res.json({ ...demoData, generatedAt: new Date().toISOString() });
  try {
    pending ||= Promise.allSettled([localEnabled ? collect('LOCAL') : Promise.resolve(), collect('KIO'), ...(process.env.HUAWEI_ENABLED === 'true' ? [collect('HUAWEI')] : [])]).then(([local, kio, huawei]) => dashboardResponse(localEnabled ? local : undefined, kio, (source, error) => ({ source, category: classifySqlError(error), ...serializeSqlError(error) }), huawei)).finally(() => { pending = null; });
    const result = await pending;
    res.status(result.httpStatus).json(result.body);
  } catch { res.status(500).json({ error: 'No fue posible procesar las métricas SQL.' }); }
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta API no encontrada' }));
const webDist = path.resolve(here, '../../web/dist');
app.use(express.static(webDist));
app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
const server = app.listen(Number(process.env.PORT || 3100), '127.0.0.1', () => console.log('Terra dashboard: http://localhost:' + (process.env.PORT || 3100) + ' (' + mode + ')'));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());

