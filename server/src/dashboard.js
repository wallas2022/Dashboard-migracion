export function decimalLsn(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('LSN debe ser texto decimal');
  return value;
}
export function hasContinuousLsnChain(entries) {
  if (entries.length < 2) return null;
  const ordered = [...entries].sort((a, b) => BigInt(decimalLsn(a.firstLsn)) < BigInt(decimalLsn(b.firstLsn)) ? -1 : 1);
  return ordered.slice(1).every((entry, i) => BigInt(decimalLsn(entry.firstLsn)) === BigInt(decimalLsn(ordered[i].lastLsn)));
}
export function sqlLocalClockMilliseconds(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{3})?$/.test(value)) return null;
  const parsed = Date.parse(value.replace(' ', 'T') + 'Z');
  return Number.isFinite(parsed) ? parsed : null;
}
export function durationLabel(minutes) {
  const units = [[Math.floor(minutes / 1440), 'día'], [Math.floor(minutes % 1440 / 60), 'hora'], [Math.floor(minutes % 60), 'minuto']];
  const parts = units.filter(([n]) => n).map(([n, unit]) => `${n} ${unit}${n === 1 ? '' : 's'}`);
  return parts.length > 1 ? parts.slice(0, -1).join(', ') + ' y ' + parts.at(-1) : parts[0] || 'Al día';
}
export function calculateLag(source, destination) {
  const a = sqlLocalClockMilliseconds(source), b = sqlLocalClockMilliseconds(destination);
  if (a == null || b == null) return { lagMinutes: null, lagStatus: 'pending', lagLabel: 'Pendiente' };
  if (a < b) return { lagMinutes: 0, lagStatus: 'anomaly', lagLabel: 'Revisar fechas' };
  const minutes = Math.floor((a - b) / 60000);
  return { lagMinutes: minutes, lagStatus: minutes ? 'behind' : 'current', lagLabel: durationLabel(minutes) };
}
const ENV_NAMES = { kio: 'KIO', huawei: 'Huawei' };
function entriesFrom(history) {
  return (history || []).map(row => ({ file: String(row.archivo).split(/[\\/]/).pop(), firstLsn: row.first_lsn == null ? null : decimalLsn(row.first_lsn), lastLsn: row.last_lsn == null ? null : decimalLsn(row.last_lsn), sizeMb: Number(row.tamano_mb || 0), status: String(row.estado || ''), restoreDate: row.restore_date }));
}
export function dataSyncSection(syncResults = {}, failureFor, name = 'TerraControllerDataSync') {
  const data = {}, warnings = [];
  for (const key of ['kio', 'huawei']) {
    const result = syncResults[key];
    data[key] = result?.status === 'fulfilled' ? result.value : null;
    if (result?.status === 'rejected') warnings.push(failureFor(`${key.toUpperCase()}_DATASYNC`, result.reason));
    for (const warning of data[key]?.queryWarnings || []) warnings.push(failureFor(`${key.toUpperCase()}_DATASYNC_${warning.query}`, warning.error));
  }
  const business = {};
  for (const key of ['kio', 'huawei']) {
    const point = data[key]?.latestBusinessPoint;
    business[key] = { latestId: point?.id_factura ?? null, latestEvent: point?.fecha_facturacion ?? null, latestSync: point?.fecha_sync ?? null };
  }
  const environments = ['kio', 'huawei'].map(key => {
    const base = { key, name: ENV_NAMES[key], role: key === 'kio' ? 'Producción / origen' : 'Réplica' };
    if (!syncResults[key]) return { ...base, role: 'Conexión desactivada', status: 'disabled', databaseState: 'DESACTIVADA', readOnly: null };
    if (data[key]?.notCreated) return { ...base, status: 'notcreated', databaseState: 'NO CREADA', readOnly: null };
    const env = data[key]?.environment;
    if (data[key]?.queryWarnings?.some(w => [945, 926, 942, 916, 4060].includes(w.error?.number))) return { ...base, status: 'offline', databaseState: 'INACCESIBLE', readOnly: env?.is_read_only ?? null };
    return { ...base, status: !env ? 'offline' : env.is_in_standby ? 'standby' : env.state_desc === 'ONLINE' ? 'online' : 'offline', databaseState: env?.is_in_standby ? 'STANDBY' : env?.state_desc || 'SIN DATOS', readOnly: env?.is_read_only ?? null };
  });
  const tableMap = new Map();
  for (const key of ['kio', 'huawei']) for (const table of data[key]?.tables || []) {
    const id = `${table.schema}.${table.table}`;
    const row = tableMap.get(id) || { schema: table.schema, table: table.table, kioRows: null, huaweiRows: null, sizeGb: null, huaweiSizeGb: null };
    row[`${key}Rows`] = Number(table.row_count);
    if (key === 'kio') row.sizeGb = Number(table.size_gb); else row.huaweiSizeGb = Number(table.size_gb);
    tableMap.set(id, row);
  }
  const tables = [...tableMap.values()].map(row => ({ ...row, huaweiDifference: row.kioRows == null || row.huaweiRows == null ? null : row.kioRows - row.huaweiRows }));
  const jobMap = new Map();
  for (const key of ['kio', 'huawei']) for (const job of data[key]?.jobs || []) {
    const row = jobMap.get(job.name) || { name: job.name, kio: 'Sin datos', huawei: 'Sin datos' };
    row[key] = job.enabled ? 'Habilitado' : 'Deshabilitado'; jobMap.set(job.name, row);
  }
  const history = data.huawei?.history;
  const entries = entriesFrom(history);
  const chain = { status: !syncResults.huawei ? 'disabled' : data.huawei?.notCreated ? 'notcreated' : !history ? 'unavailable' : entries.length ? 'available' : 'empty', entries, continuous: entries.every(row => row.firstLsn && row.lastLsn) ? hasContinuousLsnChain(entries) : null, totalMb: entries.reduce((sum, row) => sum + row.sizeMb, 0), error: warnings.find(w => w.source === 'HUAWEI_DATASYNC_restoreHistory' || w.source === 'HUAWEI_DATASYNC') || null };
  return { database: name, environments, business, tables, jobs: [...jobMap.values()], chain, huaweiLag: calculateLag(business.kio.latestSync, business.huawei.latestSync), warnings };
}
export function dashboardResponse(kioResult, failureFor, huaweiResult, syncResults) {
  const results = { kio: kioResult, huawei: huaweiResult };
  const data = {}, warnings = [];
  for (const [key, result] of Object.entries(results)) {
    data[key] = result?.status === 'fulfilled' ? result.value : null;
    if (result?.status === 'rejected') warnings.push(failureFor(key.toUpperCase(), result.reason));
    for (const warning of data[key]?.queryWarnings || []) warnings.push(failureFor(`${key.toUpperCase()}_${warning.query}`, warning.error));
  }
  const business = {};
  for (const key of ['kio', 'huawei']) {
    const point = data[key]?.latestBusinessPoint;
    business[key] = { latestInvoice: point?.id_factura ?? null, latestInvoiceDate: point?.fecha_facturacion ?? null, latestSync: point?.fecha_sync ?? null };
  }
  const tableMap = new Map();
  for (const key of ['kio', 'huawei']) for (const table of data[key]?.tables || []) {
    const id = `${table.schema}.${table.table}`;
    const row = tableMap.get(id) || { schema: table.schema, table: table.table, kioRows: null, huaweiRows: null, sizeGb: null, huaweiSizeGb: null };
    row[`${key}Rows`] = Number(table.row_count);
    if (key === 'kio') row.sizeGb = Number(table.size_gb);
    if (key === 'huawei') row.huaweiSizeGb = Number(table.size_gb);
    tableMap.set(id, row);
  }
  const tables = [...tableMap.values()].map(row => ({ ...row, huaweiDifference: row.kioRows == null || row.huaweiRows == null ? null : row.kioRows - row.huaweiRows }));
  const jobMap = new Map();
  for (const key of ['kio', 'huawei']) for (const job of data[key]?.jobs || []) {
    const row = jobMap.get(job.name) || { name: job.name, kio: 'Sin datos', huawei: 'Sin datos' };
    row[key] = job.enabled ? 'Habilitado' : 'Deshabilitado'; jobMap.set(job.name, row);
  }
  const history = data.huawei?.history;
  const entries = entriesFrom(history);
  const chains = { huawei: { status: !results.huawei ? 'disabled' : !history ? 'unavailable' : entries.length ? 'available' : 'empty', entries, continuous: entries.every(row => row.firstLsn && row.lastLsn) ? hasContinuousLsnChain(entries) : null, totalMb: entries.reduce((sum, row) => sum + row.sizeMb, 0), error: warnings.find(w => w.source === 'HUAWEI_restoreHistory' || w.source === 'HUAWEI') || null } };
  const environments = ['kio', 'huawei'].map(key => {
    const env = data[key]?.environment;
    const base = { key, name: ENV_NAMES[key], role: key === 'kio' ? 'Producción / origen' : 'Réplica' };
    if (!results[key]) return { ...base, role: 'Conexión desactivada', status: 'disabled', databaseState: 'DESACTIVADA', readOnly: null };
    const unavailable = data[key]?.queryWarnings?.some(warning => [945, 926, 942].includes(warning.error?.number));
    if (unavailable) return { ...base, status: 'offline', databaseState: 'INACCESIBLE', readOnly: env?.is_read_only ?? null };
    return { ...base, status: !env ? 'offline' : env.is_in_standby ? 'standby' : env.state_desc === 'ONLINE' ? 'online' : 'offline', databaseState: env?.is_in_standby ? 'STANDBY' : env?.state_desc || 'SIN DATOS', readOnly: env?.is_read_only ?? null };
  });
  const dataSync = dataSyncSection(syncResults, failureFor);
  warnings.push(...dataSync.warnings);
  const available = Object.values(data).some(Boolean);
  return { httpStatus: available ? 200 : 503, body: { generatedAt: new Date().toISOString(), mode: 'live', status: !available ? 'error' : warnings.length ? 'partial' : 'ok', data, warnings, dataSync, environments, business, tables, jobs: [...jobMap.values()], chains, chain: chains.huawei.entries, summary: { huaweiLag: calculateLag(business.kio.latestSync, business.huawei.latestSync), logsPending: null, transferredMb: chains.huawei.totalMb } } };
}
