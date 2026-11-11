import dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoData, demoCorte } from './demo-data.js';
import { configFor, queries, syncQueries, SYNC_DATABASE, withPool, classifySqlError, serializeSqlError } from './sql.js';
import { dashboardResponse } from './dashboard.js';
import { createCorteService } from './corte.js';
const here = path.dirname(fileURLToPath(import.meta.url));
// DASHBOARD_ENV_FILE permite alternar entornos (p. ej. .env.qa / .env.prod) sin reescribir variables; por defecto, .env de la raíz.
dotenv.config({ path: path.resolve(here, '../..', process.env.DASHBOARD_ENV_FILE || '.env') });
const app = express();
app.disable('x-powered-by');
const mode = process.env.DASHBOARD_MODE || 'demo';
if (!['demo', 'live'].includes(mode)) throw new Error('DASHBOARD_MODE debe ser demo o live');
async function collect(prefix, set = queries, database = 'TerraController') {
  return withPool(configFor(prefix), async adapter => {
    const environment = (await adapter.query(set.environment))[0];
    if (!environment) {
      // DataSync puede no existir aún en Huawei: no es un error, solo "no creada".
      if (set === syncQueries) return { environment: null, notCreated: true, queryWarnings: [] };
      throw new Error(`Base ${database} no encontrada o no visible`);
    }
    const result = { environment, queryWarnings: [] };
    const names = ['tables', 'jobs', ...(prefix === 'HUAWEI' ? ['restoreHistory', 'latestBusinessPoint'] : ['latestBusinessPoint'])];
    for (const name of names) {
      const field = name === 'restoreHistory' ? 'history' : name;
      try { const rows = await adapter.query(set[name]); result[field] = name === 'latestBusinessPoint' ? rows[0] || null : rows; }
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
    const huaweiOn = process.env.HUAWEI_ENABLED === 'true';
    pending ||= Promise.allSettled([collect('KIO'), huaweiOn ? collect('HUAWEI') : Promise.resolve(), collect('KIO', syncQueries, SYNC_DATABASE), huaweiOn ? collect('HUAWEI', syncQueries, SYNC_DATABASE) : Promise.resolve()]).then(([kio, huawei, syncKio, syncHuawei]) => dashboardResponse(kio, (source, error) => ({ source, category: classifySqlError(error), ...serializeSqlError(error) }), huaweiOn ? huawei : undefined, { kio: syncKio, huawei: huaweiOn ? syncHuawei : undefined })).finally(() => { pending = null; });
    const result = await pending;
    res.status(result.httpStatus).json(result.body);
  } catch { res.status(500).json({ error: 'No fue posible procesar las métricas SQL.' }); }
});
const corte = mode === 'live' && process.env.CORTE_ENABLED !== 'false' ? createCorteService({ runtimeDir: path.resolve(here, '../../.runtime') }) : null;
app.get('/api/corte', async (_req, res) => {
  if (mode === 'demo') return res.json(demoCorte());
  if (!corte) return res.status(503).json({ error: 'La pestaña Corte está desactivada (CORTE_ENABLED=false).' });
  try { const result = await corte.get(); res.status(result.httpStatus).json(result.body); }
  catch { res.status(500).json({ error: 'No fue posible procesar el monitor del corte.' }); }
});
corte?.startSampler(); // una muestra por minuto aunque la pestaña esté cerrada (historial de escrituras)
app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta API no encontrada' }));
const webDist = path.resolve(here, '../../web/dist');
app.use(express.static(webDist));
app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
const server = app.listen(Number(process.env.PORT || 3100), '127.0.0.1', () => console.log('Terra dashboard: http://localhost:' + (process.env.PORT || 3100) + ' (' + mode + ')'));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());

