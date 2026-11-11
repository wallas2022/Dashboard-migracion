// Pestaña "Corte": monitor del paso de Controller de KIO a Huawei.
// Solo lectura: SELECT sobre DMV, GET HTTP al balanceador y a los sitios. Cada fuente es independiente.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { classifySqlError, configFor, serializeSqlError, withPool } from './sql.js';

const MINUTE = 60000, DAY = 86400000;
export const CORTE_DATABASES = ['TerraController', 'TerraControllerDataSync'];
export const NA = reason => ({ unavailable: true, reason });
export const isNA = value => value == null || value.unavailable === true;

/* ------------------------------------------------------------------ configuración */
export const parseList = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);
export function parseSites(value) {
  return parseList(value).map(item => {
    const i = item.lastIndexOf(':');
    return { name: item.slice(0, i).trim(), port: Number(item.slice(i + 1)) };
  }).filter(site => site.name && Number.isInteger(site.port));
}
export function parsePoolMax(value) {
  const map = { default: 100 };
  for (const item of parseList(value)) {
    const i = item.lastIndexOf(':'), max = Number(item.slice(i + 1));
    if (i > 0 && max > 0) map[item.slice(0, i).trim()] = max;
  }
  return map;
}
// Los relojes de Guatemala se manejan como "UTC aparente": Date.now() + offset.
export const toLocalMs = (ms, tz) => ms + tz;
export const formatLocal = (localMs) => new Date(localMs).toISOString().slice(0, 23).replace('T', ' ');
export const parseLocal = text => {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2}(\.\d{3})?)?$/.exec(String(text || '').trim());
  return match ? Date.parse(`${match[1]}T${match[2]}${match[3] || ':00'}Z`) : null;
};
export function defaultWindowStart(localNow) {
  let day = Math.floor(localNow / DAY) * DAY;
  while (new Date(day).getUTCDay() !== 5) day -= DAY;
  let start = day + 20 * 3600000;
  if (start > localNow) start -= 7 * DAY;
  return start;
}
// "22:00=Detener KIO|Detener apps": hora=etiqueta|etiqueta corta del gráfico. Deben ir en orden cronológico.
export function parseEvents(value, windowStartLocal) {
  let cursor = windowStartLocal;
  const events = [];
  for (const item of parseList(value)) {
    const match = /^(\d{1,2}):(\d{2})\s*=\s*(.+)$/.exec(item);
    if (!match) continue;
    let at = Math.floor(cursor / DAY) * DAY + (Number(match[1]) * 60 + Number(match[2])) * MINUTE;
    while (at < cursor) at += DAY;
    cursor = at;
    const [label, short] = match[3].split('|').map(part => part.trim());
    events.push({ key: `e${events.length}`, label, short: short || label, atMs: at, at: formatLocal(at) });
  }
  return events;
}
const DEFAULT_EVENTS = '22:00=Detener KIO|Detener apps,23:00=Congelar y TRN puente|Puente,00:30=Tail-log,03:30=RECOVERY en Huawei|RECOVERY,07:00=Conectar WEB01/02|Conectar WEB,08:30=Pruebas,09:30=Go y operación|Go';
const DEFAULT_SITES = 'Controller-Portal-Admin:9090,Controller-Portal-Clientes:9091,Controller-Servicio-Soap:9092,Controller-Api:9093,API-V2:9095,RidersApi:9999,Controller-Internal-Services:3000';

export function corteSettings(env = process.env, nowMs = Date.now()) {
  const tzOffsetMs = Number(env.CORTE_TZ_OFFSET_HOURS ?? -6) * 3600000;
  const windowStartMs = parseLocal(env.CORTE_WINDOW_START) ?? defaultWindowStart(nowMs + tzOffsetMs);
  const nodeIps = parseList(env.CORTE_WEB_NODES || '10.22.0.35,10.22.0.34');
  return {
    tzOffsetMs, windowStartMs,
    events: parseEvents(env.CORTE_EVENTS || DEFAULT_EVENTS, windowStartMs),
    sites: parseSites(env.CORTE_SITES || DEFAULT_SITES),
    poolMax: parsePoolMax(env.CORTE_POOL_MAX || 'Controller-Site:500,default:100'),
    nodes: nodeIps.map((ip, i) => ({ name: `WEB0${i + 1}`, ip })),
    balancerHost: env.CORTE_BALANCER_HOST || '',
    nginxLogUrl: env.CORTE_NGINX_LOG_URL || '', nginxStatusUrl: env.CORTE_NGINX_STATUS_URL || '',
    tlsInsecure: env.CORTE_NGINX_TLS_INSECURE === 'true',
    cpuUrls: Object.fromEntries(parseList(env.CORTE_CPU_URLS).map(item => { const i = item.indexOf('='); return [item.slice(0, i).trim(), item.slice(i + 1).trim()]; }).filter(([name, url]) => name && url)),
    probesOn: env.CORTE_PROBES !== 'false',
    monitorApp: env.CORTE_MONITOR_APP || 'TerraDashboardMonitor',
    amberS: Number(env.CORTE_SLOW_AMBER_S || 10), redS: Number(env.CORTE_SLOW_RED_S || 30),
    zombieIdleS: Number(env.CORTE_ZOMBIE_IDLE_S || 60), poolAlertPct: Number(env.CORTE_POOL_ALERT_PCT || 80),
    historyHours: Number(env.CORTE_HISTORY_HOURS || 48)
  };
}

/* ------------------------------------------------------------------ consultas (solo SELECT sobre DMV) */
const PRE = 'SET LOCK_TIMEOUT 5000; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\n';
const lit = value => String(value).replace(/'/g, "''");
const DB_LIST = CORTE_DATABASES.map(name => `N'${name}'`).join(',');
export const BENIGN_WAITS = ['SLEEP[_]%', 'BROKER[_]%', 'XE[_]%', 'HADR[_]FILESTREAM%', 'HADR[_]WORK[_]QUEUE', 'HADR[_]CLUSAPI[_]CALL', 'HADR[_]TIMER[_]TASK', 'HADR[_]LOGCAPTURE[_]WAIT', 'DIRTY[_]PAGE[_]POLL', 'LAZYWRITER[_]SLEEP', 'CHECKPOINT[_]QUEUE', 'REQUEST[_]FOR[_]DEADLOCK[_]SEARCH', 'SQLTRACE%', 'WAITFOR', 'LOGMGR[_]QUEUE', 'CLR[_]%', 'FT[_]IFTS[_]SCHEDULER[_]IDLE[_]WAIT', 'ONDEMAND[_]TASK[_]QUEUE', 'DISPATCHER[_]QUEUE[_]SEMAPHORE', 'SP[_]SERVER[_]DIAGNOSTICS[_]SLEEP', 'QDS[_]%', 'PWAIT[_]ALL[_]COMPONENTS[_]INITIALIZED', 'WAIT[_]XTP[_]%', 'PARALLEL[_]REDO[_]%', 'REDO[_]THREAD[_]PENDING[_]WORK', 'UCS[_]%', 'PVS[_]PREALLOCATE', 'SOS[_]WORK[_]DISPATCHER', 'MEMORY[_]ALLOCATION[_]EXT', 'RESOURCE[_]QUEUE', 'TRACEWRITE'];

export function corteQueries(settings) {
  const app = lit(settings.monitorApp);
  const own = alias => `${alias}.session_id <> @@SPID AND ISNULL(${alias}.program_name, N'') <> N'${app}'`;
  return {
    dbs: `${PRE}SELECT name, state_desc, is_in_standby FROM sys.databases WHERE name IN (${DB_LIST});`,
    counters: `${PRE}SELECT RTRIM(object_name) AS object_name, RTRIM(counter_name) AS counter_name, RTRIM(instance_name) AS instance_name, cntr_value
      FROM sys.dm_os_performance_counters
      WHERE (object_name LIKE N'%:Databases%' AND RTRIM(counter_name) = N'Write Transactions/sec' AND RTRIM(instance_name) IN (${DB_LIST}))
         OR (object_name LIKE N'%:General Statistics%' AND RTRIM(counter_name) IN (N'User Connections', N'Logins/sec', N'Logouts/sec', N'Connection Reset/sec'));`,
    firstWrite: `${PRE}SELECT DB_NAME(database_id) AS db, CONVERT(varchar(23), MAX(last_user_update), 121) AS last_update
      FROM sys.dm_db_index_usage_stats WHERE database_id IN (DB_ID(N'${CORTE_DATABASES[0]}'), DB_ID(N'${CORTE_DATABASES[1]}'))
      GROUP BY database_id;`,
    sessions: `${PRE}SELECT s.session_id, s.program_name, s.host_name, c.client_net_address, s.login_name,
        CONVERT(varchar(23), s.login_time, 121) AS login_time, s.status AS session_status, s.open_transaction_count,
        DATEDIFF(SECOND, s.last_request_end_time, GETDATE()) AS idle_s,
        r.status AS request_status, r.wait_type, r.blocking_session_id,
        DATEDIFF_BIG(MILLISECOND, r.start_time, GETDATE()) AS duration_ms, r.cpu_time, r.logical_reads,
        LEFT(t.text, 200) AS sql_text
      FROM sys.dm_exec_sessions s
      LEFT JOIN sys.dm_exec_connections c ON c.session_id = s.session_id
      LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
      OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
      WHERE s.is_user_process = 1 AND ${own('s')};`,
    connections: `${PRE}SELECT c.client_net_address, ISNULL(s.program_name, N'') AS program_name, c.local_net_address, c.local_tcp_port,
        c.encrypt_option, COUNT(*) AS sessions, CONVERT(varchar(23), MIN(s.login_time), 121) AS first_login
      FROM sys.dm_exec_connections c JOIN sys.dm_exec_sessions s ON s.session_id = c.session_id
      WHERE s.is_user_process = 1 AND ${own('s')}
      GROUP BY c.client_net_address, s.program_name, c.local_net_address, c.local_tcp_port, c.encrypt_option;`,
    schedulers: `${PRE}SELECT scheduler_id, runnable_tasks_count FROM sys.dm_os_schedulers WHERE status = N'VISIBLE ONLINE';`,
    waits: `${PRE}SELECT wait_type, wait_time_ms FROM sys.dm_os_wait_stats
      WHERE wait_time_ms > 0 AND ${BENIGN_WAITS.map(p => `wait_type NOT LIKE N'${p}'`).join(' AND ')};`,
    cpu: `${PRE}SELECT t.rec.value('(./Record/SchedulerMonitorEvent/SystemHealth/ProcessUtilization)[1]', 'int') AS sql_cpu,
        t.rec.value('(./Record/SchedulerMonitorEvent/SystemHealth/SystemIdle)[1]', 'int') AS idle
      FROM (SELECT TOP (1) CONVERT(xml, record) AS rec FROM sys.dm_os_ring_buffers
            WHERE ring_buffer_type = N'RING_BUFFER_SCHEDULER_MONITOR' AND record LIKE N'%<SystemHealth>%'
            ORDER BY [timestamp] DESC) AS t;`,
    ha: `${PRE}SELECT DB_NAME(drs.database_id) AS db, ar.replica_server_name, drs.is_local, drs.synchronization_state_desc,
        drs.synchronization_health_desc, drs.log_send_queue_size, drs.redo_queue_size
      FROM sys.dm_hadr_database_replica_states drs JOIN sys.availability_replicas ar ON ar.replica_id = drs.replica_id;`,
    replicas: `${PRE}SELECT ar.replica_server_name, ars.is_local, ars.role_desc, ars.connected_state_desc, ars.synchronization_health_desc
      FROM sys.dm_hadr_availability_replica_states ars JOIN sys.availability_replicas ar ON ar.replica_id = ars.replica_id;`,
    endpoints: `${PRE}SELECT port, state_desc FROM sys.tcp_endpoints WHERE type_desc = N'DATABASE_MIRRORING';`,
    cluster: `${PRE}SELECT member_name, member_type_desc, member_state_desc FROM sys.dm_hadr_cluster_members;`
  };
}
export const SOURCE_QUERIES = {
  kio: ['dbs', 'counters'],
  huawei: ['dbs', 'counters', 'firstWrite', 'sessions', 'connections', 'schedulers', 'waits', 'cpu', 'ha', 'replicas', 'endpoints', 'cluster'],
  huawei2: ['cpu', 'ha', 'replicas', 'endpoints']
};
const SOURCE_PREFIX = { kio: 'KIO', huawei: 'HUAWEI', huawei2: 'HUAWEI2' };

async function runQueries(source, settings) {
  const config = configFor(SOURCE_PREFIX[source]);
  config.options.appName = settings.monitorApp; // permite excluir la sesión del propio dashboard
  config.options.enableArithAbort = true; // los logon triggers con EVENTDATA().value() exigen ARITHABORT ON
  const queries = corteQueries(settings);
  return withPool(config, async adapter => {
    const out = { queryWarnings: [] };
    for (const name of SOURCE_QUERIES[source]) {
      try { out[name] = await adapter.query(queries[name]); }
      catch (error) { out[name] = null; out.queryWarnings.push({ query: name, error }); }
    }
    return out;
  });
}

/* ------------------------------------------------------------------ HTTP (balanceador y sitios) */
export function httpRequest(url, { timeoutMs = 3000, insecure = false, body = false, maxBytes = 8e6 } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    let target;
    try { target = new URL(url); } catch { return resolve({ error: 'URL no válida' }); }
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, { method: 'GET', timeout: timeoutMs, rejectUnauthorized: !insecure, headers: { 'User-Agent': 'terra-corte-monitor' } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { if (body && size < maxBytes) { chunks.push(chunk); size += chunk.length; } });
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - started, protocol: res.socket?.getProtocol?.() || null, body: body ? Buffer.concat(chunks).toString('utf8') : undefined }));
      res.on('error', error => resolve({ error: error.code || 'ERROR' }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', error => resolve({ error: error.code || 'ERROR', ms: Date.now() - started }));
    req.end();
  });
}
async function fetchText(url, settings) {
  const result = await httpRequest(url, { timeoutMs: 10000, insecure: settings.tlsInsecure, body: true });
  if (result.error) throw Object.assign(new Error(`No fue posible leer ${new URL(url).host}: ${result.error}`), { code: result.error === 'TIMEOUT' ? 'DASHBOARD_TIMEOUT' : result.error });
  if (result.status >= 400) throw new Error(`HTTP ${result.status} al leer ${new URL(url).host}`);
  return result.body;
}
export async function collectProbes(settings) {
  const targets = [];
  if (settings.balancerHost) {
    targets.push({ key: '443', url: `https://${settings.balancerHost}/` }, { key: '80', url: `http://${settings.balancerHost}/` });
  }
  for (const node of settings.nodes) for (const site of settings.sites) targets.push({ key: `${site.port}@${node.name}`, url: `http://${node.ip}:${site.port}/`, node: node.name, port: site.port });
  return Promise.all(targets.map(async target => ({ ...target, ...(await httpRequest(target.url, { insecure: true })) , body: undefined })));
}

// CPU de balanceador y WEB: cada nodo publica {"cpu": 38.5} (o solo el número) en una URL de solo lectura.
export function parseCpu(text) {
  const raw = String(text ?? '').trim();
  let value;
  try { const parsed = JSON.parse(raw); value = typeof parsed === 'object' && parsed ? (parsed.cpu ?? parsed.cpuPct) : parsed; } catch { value = NaN; }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? Math.round(number * 10) / 10 : null;
}
export async function collectCpu(settings) {
  const values = {}, queryWarnings = [];
  await Promise.all(Object.entries(settings.cpuUrls).map(async ([name, url]) => {
    const result = await httpRequest(url, { timeoutMs: 5000, body: true, maxBytes: 4096 });
    const cpu = result.error || result.status >= 400 ? null : parseCpu(result.body);
    values[name] = cpu;
    if (cpu == null) queryWarnings.push({ query: name, error: new Error(result.error ? `Sin respuesta (${result.error})` : result.status >= 400 ? `HTTP ${result.status}` : 'Respuesta no válida: se espera {"cpu": 0-100}') });
  }));
  return { values, queryWarnings };
}

/* ------------------------------------------------------------------ cálculos puros */
const num = value => value == null || value === '' ? null : Number(value);
export function counterRate(prev, curr, elapsedMs) {
  if (prev == null || curr == null || !(elapsedMs > 0)) return null;
  const delta = Number(curr) - Number(prev);
  return delta < 0 ? null : Math.round(delta / (elapsedMs / 1000) * 10) / 10;
}
export function parseCounters(rows) {
  const writes = {}, general = {};
  for (const row of rows || []) {
    const value = Number(row.cntr_value);
    if (/Databases/i.test(row.object_name)) writes[row.instance_name] = value;
    else general[row.counter_name] = value;
  }
  return { writes, general };
}
// Diferencia de "Write Transactions/sec" (acumulado) contra la lectura anterior.
export function writeRates(prev, rows, nowMs) {
  const { writes, general } = parseCounters(rows);
  const snapshot = { t: nowMs, writes, general };
  const byDb = {}, rates = [];
  const elapsed = prev ? nowMs - prev.t : null;
  for (const [db, value] of Object.entries(writes)) {
    byDb[db] = counterRate(prev?.writes?.[db], value, elapsed);
    if (byDb[db] != null) rates.push(byDb[db]);
  }
  const total = rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) * 10) / 10 : null;
  const perSec = {};
  for (const name of ['Logins/sec', 'Logouts/sec', 'Connection Reset/sec']) perSec[name] = counterRate(prev?.general?.[name], general[name], elapsed);
  return { snapshot, byDb, total, general, perSec };
}
export function waitDeltas(prev, rows, nowMs, top = 5) {
  const snapshot = { t: nowMs, waits: Object.fromEntries((rows || []).map(row => [row.wait_type, Number(row.wait_time_ms)])) };
  if (!prev) return { snapshot, top: null };
  const minutes = (nowMs - prev.t) / MINUTE;
  if (!(minutes > 0)) return { snapshot, top: null };
  const list = Object.entries(snapshot.waits)
    .map(([wait, ms]) => ({ wait, seconds: Math.round((ms - (prev.waits[wait] ?? ms)) / minutes / 100) / 10 }))
    .filter(item => item.seconds > 0).sort((a, b) => b.seconds - a.seconds).slice(0, top);
  return { snapshot, top: list };
}
export function cpuQueueAlert(history, threshold = 2, samples = 3) {
  return history.length >= samples && history.slice(-samples).every(max => max >= threshold);
}

export function sessionState(row, zombieIdleS = 60) {
  const request = String(row.request_status || '').toLowerCase();
  if (request) return ['running', 'runnable', 'suspended'].includes(request) ? request : 'running';
  const open = Number(row.open_transaction_count || 0) > 0;
  return String(row.session_status || '').toLowerCase() === 'sleeping' && open && Number(row.idle_s) > zombieIdleS ? 'zombie' : 'sleeping';
}
export const isBlocked = row => Number(row.blocking_session_id || 0) > 0;
export function summarizeStates(rows, zombieIdleS = 60) {
  const states = { running: 0, runnable: 0, suspended: 0, sleeping: 0, zombie: 0, blocked: 0 };
  for (const row of rows) { states[sessionState(row, zombieIdleS)]++; if (isBlocked(row)) states.blocked++; }
  return states;
}
export function blockChains(rows) {
  const blockedBy = new Map(rows.filter(isBlocked).map(row => [Number(row.session_id), Number(row.blocking_session_id)]));
  const byId = new Map(rows.map(row => [Number(row.session_id), row]));
  const roots = new Map();
  for (const [victim, blocker] of blockedBy) {
    let root = blocker, guard = 0;
    while (blockedBy.has(root) && guard++ < 50) root = blockedBy.get(root);
    if (!roots.has(root)) roots.set(root, []);
    roots.get(root).push(victim);
  }
  return [...roots].map(([root, victims]) => ({
    root: { spid: root, app: byId.get(root)?.program_name || null, origin: byId.get(root)?.client_net_address || null, state: byId.get(root) ? sessionState(byId.get(root)) : null },
    victims: victims.sort((a, b) => a - b), length: victims.length + 1
  })).sort((a, b) => b.length - a.length);
}
export function poolUsage(rows, poolMax, alertPct = 80, zombieIdleS = 60) {
  const pools = new Map();
  for (const row of rows) {
    const app = String(row.program_name || '').trim() || '(sin nombre)';
    const entry = pools.get(app) || { app, running: 0, suspended: 0, sleeping: 0, zombie: 0 };
    const state = sessionState(row, zombieIdleS);
    entry[state === 'runnable' ? 'running' : state]++;
    pools.set(app, entry);
  }
  return [...pools.values()].map(pool => {
    const total = pool.running + pool.suspended + pool.sleeping + pool.zombie;
    const max = poolMax[pool.app] ?? poolMax.default ?? 100;
    const pct = Math.round(total / max * 1000) / 10;
    return { ...pool, total, max, pct, alert: pct > alertPct };
  }).sort((a, b) => b.total - a.total);
}
export function processList(rows, { amberS = 10, redS = 30 } = {}, zombieIdleS = 60) {
  return rows.filter(row => row.request_status).map(row => {
    const durationMs = Number(row.duration_ms || 0), state = sessionState(row, zombieIdleS);
    return {
      spid: Number(row.session_id), app: row.program_name || null, host: row.host_name || null, origin: row.client_net_address || null,
      status: isBlocked(row) ? 'bloqueada' : state, wait: row.wait_type || null, durationMs,
      level: durationMs >= redS * 1000 ? 'red' : durationMs >= amberS * 1000 ? 'amber' : 'ok',
      cpuMs: Number(row.cpu_time || 0), reads: Number(row.logical_reads || 0),
      blockedBy: isBlocked(row) ? Number(row.blocking_session_id) : null, sql: row.sql_text ? String(row.sql_text).replace(/\s+/g, ' ').trim() : null
    };
  }).sort((a, b) => b.durationMs - a.durationMs).slice(0, 50);
}
export function zombieList(rows, zombieIdleS = 60) {
  return rows.filter(row => sessionState(row, zombieIdleS) === 'zombie').map(row => ({
    spid: Number(row.session_id), app: row.program_name || null, origin: row.client_net_address || null,
    openTransactions: Number(row.open_transaction_count), idleS: Number(row.idle_s), login: row.login_name || null, loginTime: row.login_time || null
  })).sort((a, b) => b.idleS - a.idleS);
}
export function haSummary(rows) {
  if (!rows?.length) return null;
  const remote = rows.filter(row => !row.is_local);
  const used = remote.length ? remote : rows;
  const rank = { NOT_HEALTHY: 2, PARTIALLY_HEALTHY: 1, HEALTHY: 0 };
  const health = used.map(row => row.synchronization_health_desc).filter(Boolean).sort((a, b) => (rank[b] ?? 0) - (rank[a] ?? 0))[0] || null;
  const states = used.map(row => row.synchronization_state_desc).filter(Boolean);
  const state = states.find(item => item !== 'SYNCHRONIZED') || states[0] || null;
  const sum = key => used.reduce((total, row) => total + Number(row[key] || 0), 0);
  return { state, health, logSendQueueKb: sum('log_send_queue_size'), redoQueueKb: sum('redo_queue_size'), databases: used.length };
}

/* ------------------------------------------------------------------ log de NGINX */
// log_format corte '$time_iso8601 $upstream_addr $status $upstream_response_time "$host" "$request_uri"';
const LOG_LINE = /^(\S+) (\S+(?:, \S+)*) (\d{3}) (\S+(?:, \S+)*) "([^"]*)" "([^"]*)"/; // con reintentos NGINX separa con ", "
export function parseNginxLine(line) {
  const match = LOG_LINE.exec(line);
  if (!match) return null;
  const at = Date.parse(match[1]);
  const upstream = match[2].split(',').pop().trim(); // si hubo reintentos, cuenta el último upstream
  const hit = /^(.+):(\d+)$/.exec(upstream);
  if (!Number.isFinite(at) || !hit) return null;
  const seconds = Number(match[4].split(',').pop().trim());
  return { at, ip: hit[1], port: Number(hit[2]), status: Number(match[3]), ms: Number.isFinite(seconds) ? seconds * 1000 : null };
}
export function percentile(values, p = 0.95) {
  const sorted = values.filter(v => v != null).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
}
export function aggregateNginx(text, { now, sites, nodes, minutes = 15 }) {
  const last = Math.floor(now / MINUTE) * MINUTE - MINUTE; // último minuto completo
  const minuteList = Array.from({ length: minutes }, (_, i) => last - (minutes - 1 - i) * MINUTE);
  const portApp = new Map(sites.map(site => [site.port, site.name]));
  const ipNode = new Map(nodes.map(node => [node.ip, node.name]));
  const buckets = new Map();
  let parsed = 0;
  for (const line of String(text || '').split('\n')) {
    const entry = parseNginxLine(line);
    if (!entry || !portApp.has(entry.port)) continue;
    const minute = Math.floor(entry.at / MINUTE) * MINUTE;
    if (minute < minuteList[0] || minute > last) continue;
    const node = ipNode.get(entry.ip) || entry.ip;
    parsed++;
    for (const key of [`${minute}|${entry.port}|${node}`, `${minute}|${entry.port}|*`, `${minute}|*|*`]) {
      const bucket = buckets.get(key) || { req: 0, err5xx: 0, times: [] };
      bucket.req++; if (entry.status >= 500) bucket.err5xx++; if (entry.ms != null) bucket.times.push(entry.ms);
      buckets.set(key, bucket);
    }
  }
  const cell = key => { const b = buckets.get(key); return { req: b?.req || 0, err5xx: b?.err5xx || 0, p95: b ? percentile(b.times) : null }; };
  const apps = sites.map(site => ({
    name: site.name, port: site.port,
    cells: minuteList.map(minute => ({ ...cell(`${minute}|${site.port}|*`), nodes: Object.fromEntries(nodes.map(node => [node.name, cell(`${minute}|${site.port}|${node.name}`)])) }))
  }));
  const total = minuteList.map(minute => cell(`${minute}|*|*`));
  return { minutes: minuteList, apps, nodes: nodes.map(node => node.name), total, parsed };
}
export function flowFrom(agg) {
  const i = agg.minutes.length - 1;
  const links = [], appsOut = [];
  for (const app of agg.apps) {
    const cell = app.cells[i];
    appsOut.push({ name: app.name, port: app.port, req: cell.req, err5xx: cell.err5xx });
    for (const node of agg.nodes) {
      const part = cell.nodes[node];
      const noResponse = cell.req > 0 && part.req === 0;
      if (part.req > 0 || noResponse) links.push({ app: app.name, port: app.port, node, req: part.req, err5xx: part.err5xx, p95Ms: part.p95, noResponse });
    }
  }
  return { minute: agg.minutes[i], total: agg.total[i].req, apps: appsOut, nodes: agg.nodes.map(name => ({ name, req: appsOut.length ? agg.apps.reduce((s, app) => s + app.cells[i].nodes[name].req, 0) : 0 })), links };
}
export function heatmapFrom(agg, labelOf) {
  let max = 0;
  const rows = agg.apps.map(app => ({
    name: app.name, port: app.port,
    cells: app.cells.map(cell => {
      max = Math.max(max, cell.req);
      return { req: cell.req, err5xx: cell.err5xx, noNodes: cell.req > 0 ? agg.nodes.filter(node => cell.nodes[node].req === 0) : [] };
    })
  }));
  return { minutes: agg.minutes.map(labelOf), rows, max };
}
export function noResponseAlerts(agg, labelOf) {
  const alerts = [];
  for (const app of agg.apps) for (const node of agg.nodes) {
    let run = 0;
    for (let i = agg.minutes.length - 1; i >= 0; i--) {
      const cell = app.cells[i];
      if (cell.req > 0 && cell.nodes[node].req === 0) run++; else break;
    }
    if (run) alerts.push({ kind: 'noResponse', app: app.name, port: app.port, node, since: labelOf(agg.minutes[agg.minutes.length - run]), minutes: run });
  }
  return alerts;
}
export const parseStubStatus = text => { const match = /Active connections:\s*(\d+)/i.exec(String(text || '')); return match ? Number(match[1]) : null; };

/* ------------------------------------------------------------------ persistencia (.runtime) */
export function createStore(dir) {
  const historyFile = path.join(dir, 'corte-history.jsonl'), stateFile = path.join(dir, 'corte-state.json');
  const ensure = () => fs.mkdirSync(dir, { recursive: true });
  const readAll = () => {
    try { return fs.readFileSync(historyFile, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); }
    catch { return []; }
  };
  return {
    appendHistory(point, retainFromLocal) {
      try {
        ensure();
        const rows = readAll(), last = rows.at(-1);
        if (last && last.t.slice(0, 16) === point.t.slice(0, 16)) return; // una muestra por minuto
        const kept = rows.filter(row => row.t >= retainFromLocal);
        if (kept.length !== rows.length) fs.writeFileSync(historyFile, kept.concat(point).map(row => JSON.stringify(row)).join('\n') + '\n');
        else fs.appendFileSync(historyFile, JSON.stringify(point) + '\n');
      } catch { /* el historial es auxiliar: no debe romper la respuesta */ }
    },
    readHistory: sinceLocal => readAll().filter(row => row.t >= sinceLocal),
    loadState() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } },
    saveState(state) { try { ensure(); fs.writeFileSync(stateFile, JSON.stringify(state)); } catch { /* auxiliar */ } }
  };
}
const nullStore = { appendHistory() {}, readHistory: () => [], loadState: () => ({}), saveState() {} };

/* ------------------------------------------------------------------ respuesta */
function portsPanel({ settings, probes, huawei, agg }) {
  const rows = [], probe = key => probes?.find(item => item.key === key);
  const up = item => item && !item.error && item.status < 500;
  const naRow = (port, label) => ({ port, label, state: 'na', badge: 'Sin datos' });
  const p443 = probe('443'), p80 = probe('80');
  rows.push(!p443 ? naRow('443', 'Usuarios → balanceador') : { port: '443', label: `Usuarios → balanceador ${settings.balancerHost}${p443.protocol ? ' · ' + p443.protocol : ''}`, state: up(p443) ? 'ok' : 'bad', badge: up(p443) ? 'abierto' : 'sin respuesta', ms: p443.ms ?? null, code: p443.status ?? null });
  const redirect = p80 && [301, 302, 307, 308].includes(p80.status);
  rows.push(!p80 ? naRow('80', 'Redirección 301 a HTTPS') : { port: '80', label: 'Redirección 301 a HTTPS', state: p80.error ? 'bad' : redirect ? 'ok' : 'warn', badge: p80.error ? 'sin respuesta' : redirect ? 'correcto' : `HTTP ${p80.status}`, ms: p80.ms ?? null, code: p80.status ?? null });
  const groups = [[settings.sites.filter(site => site.port <= 9095), 'IIS en ' + settings.nodes.map(n => n.name).join('/')], [settings.sites.filter(site => site.port > 9095), settings.sites.filter(site => site.port > 9095).map(site => site.name.replace(/^Controller-/, '')).join(' · ')]];
  for (const [sites, label] of groups) {
    if (!sites.length) continue;
    const range = sites.length > 1 ? `${Math.min(...sites.map(s => s.port))}–${Math.max(...sites.map(s => s.port))}` : String(sites[0].port);
    const title = sites === groups[0][0] ? `${settings.balancerHost || 'balanceador'} → sitios ${label}` : label;
    if (!probes?.length) { rows.push(naRow(range, title)); continue; }
    const answered = sites.filter(site => settings.nodes.some(node => up(probe(`${site.port}@${node.name}`))));
    rows.push({ port: range, label: title, state: answered.length === sites.length ? 'ok' : answered.length ? 'warn' : 'bad', badge: sites === groups[0][0] ? `${answered.length} de ${sites.length}` : answered.length === sites.length ? 'abierto' : `${answered.length} de ${sites.length}`, sites: sites.map(site => ({ name: site.name, port: site.port, nodes: Object.fromEntries(settings.nodes.map(node => { const r = probe(`${site.port}@${node.name}`); return [node.name, r ? { ok: up(r), code: r.status ?? null, ms: r.ms ?? null, error: r.error ?? null } : null]; })) })) });
  }
  const conn = huawei?.connections;
  if (!conn) {
    rows.push(naRow('1433', 'Nodos web → Listener'), naRow('1433', 'ControllerDataSync → Listener DS'));
  } else {
    const webIps = new Set(settings.nodes.map(node => node.ip));
    const webSessions = conn.filter(row => webIps.has(row.client_net_address)).reduce((s, row) => s + Number(row.sessions), 0);
    rows.push({ port: '1433', label: 'Nodos web → Listener', state: webSessions ? 'ok' : 'warn', badge: `${webSessions} sesiones` });
    const sync = conn.filter(row => /datasync/i.test(row.program_name));
    const clear = sync.some(row => String(row.encrypt_option).toUpperCase() !== 'TRUE');
    rows.push(sync.length ? { port: '1433', label: 'ControllerDataSync → Listener DS', state: clear ? 'warn' : 'ok', badge: clear ? 'sin cifrar' : 'cifrado' } : naRow('1433', 'ControllerDataSync → Listener DS'));
  }
  const replicas = huawei?.replicas, endpoint = huawei?.endpoints?.[0];
  if (!replicas?.length) rows.push(naRow('5022', 'SQL001 ↔ SQL002 · réplica'));
  else { const ok = replicas.every(row => String(row.connected_state_desc).toUpperCase() === 'CONNECTED'); rows.push({ port: String(endpoint?.port || 5022), label: 'SQL001 ↔ SQL002 · réplica', state: ok ? 'ok' : 'bad', badge: ok ? 'conectado' : 'desconectado' }); }
  const cluster = huawei?.cluster;
  const clusterNodes = cluster?.filter(row => /NODE/i.test(row.member_type_desc)) || [];
  rows.push(!cluster?.length ? naRow('3343', 'Clúster WSFC') : { port: '3343', label: 'Clúster WSFC', state: clusterNodes.every(row => /UP/i.test(row.member_state_desc)) ? 'ok' : 'bad', badge: `${clusterNodes.length} nodos` });
  const witness = cluster?.filter(row => /WITNESS/i.test(row.member_type_desc)) || [];
  rows.push(!cluster?.length ? naRow('445', 'Clúster → testigo') : { port: '445', label: 'Clúster → testigo', state: witness.length ? (witness.every(row => /UP/i.test(row.member_state_desc)) ? 'ok' : 'bad') : 'warn', badge: witness.length ? 'testigo' : 'sin testigo' });
  return rows;
}

export function corteResponse(inputs, ctx) {
  const { settings, failureFor, now = Date.now(), runtime = { counters: {}, waits: null, cpuQueue: [] }, store = nullStore } = ctx;
  const tz = settings.tzOffsetMs, localNow = now + tz, stamp = formatLocal(localNow);
  const labelOf = ms => formatLocal(ms + tz).slice(11, 16);
  const warnings = [], data = {};
  const state = store.loadState();
  let stateDirty = false;
  for (const [key, result] of Object.entries(inputs)) {
    if (!result) continue;
    data[key] = result.status === 'fulfilled' ? result.value : null;
    if (result.status === 'rejected') warnings.push(failureFor(key.replace(/[A-Z]/g, c => '_' + c).toUpperCase(), result.reason));
    for (const warning of data[key]?.queryWarnings || []) warnings.push(failureFor(`${key.toUpperCase()}_${warning.query}`, warning.error));
  }
  const enabled = key => inputs[key] != null, has = key => data[key] != null;
  const sqlNA = key => NA(enabled(key) ? 'Sin datos' : 'No configurado');
  const kio = data.kio, huawei = data.huawei, huawei2 = data.huawei2;

  // Bases por servidor (encabezado)
  const dbsOf = source => source?.dbs ? source.dbs.map(row => ({ name: row.name, state: row.state_desc, standby: !!row.is_in_standby })) : null;
  const dbs = { kio: dbsOf(kio) ?? NA('Sin datos'), huawei: dbsOf(huawei) ?? NA('Sin datos') };

  // Escrituras por segundo (diferencia de contadores acumulados)
  const rates = {};
  for (const [key, source] of [['kio', kio], ['huawei', huawei]]) {
    if (!source?.counters) continue;
    rates[key] = writeRates(runtime.counters[key], source.counters, now);
    runtime.counters[key] = rates[key].snapshot;
  }
  if (rates.kio?.total > 0) { state.kioLastWrite = stamp; stateDirty = true; }
  const recovery = settings.events.find(event => /recovery/i.test(event.label));
  if (state.firstWrite && recovery && state.firstWrite.at < recovery.at) { delete state.firstWrite; stateDirty = true; } // ventana anterior
  if (!state.firstWrite && huawei?.firstWrite?.length && recovery) {
    const seen = huawei.firstWrite.filter(row => row.last_update && row.last_update >= recovery.at).sort((a, b) => a.last_update < b.last_update ? -1 : 1)[0];
    if (seen) { state.firstWrite = { at: seen.last_update, db: seen.db }; stateDirty = true; }
  }
  const writes = !rates.kio && !rates.huawei ? NA('Sin datos') : {
    kio: rates.kio?.total ?? null, huawei: rates.huawei?.total ?? null,
    huaweiByDb: rates.huawei?.byDb ?? null, kioByDb: rates.kio?.byDb ?? null,
    kioSilentSince: rates.kio?.total === 0 ? state.kioLastWrite ?? null : null,
    firstWriteHuawei: state.firstWrite ?? null
  };
  const sinceLocal = formatLocal(Math.max(settings.windowStartMs, localNow - settings.historyHours * 3600000));
  if (writes !== null && !isNA(writes) && (writes.kio != null || writes.huawei != null)) store.appendHistory({ t: stamp, kio: writes.kio, huawei: writes.huawei }, formatLocal(localNow - settings.historyHours * 3600000));
  const history = store.readHistory(sinceLocal);
  if (stateDirty) store.saveState(state);

  // NGINX
  const agg = data.nginxLog != null ? aggregateNginx(data.nginxLog, { now, sites: settings.sites, nodes: settings.nodes }) : null;
  const lastIdx = agg ? agg.minutes.length - 1 : -1;
  const flow = agg ? flowFrom(agg) : NA(enabled('nginxLog') ? 'Sin datos' : 'No configurado');
  const heatmap = agg ? heatmapFrom(agg, labelOf) : NA(enabled('nginxLog') ? 'Sin datos' : 'No configurado');
  const alerts = agg ? noResponseAlerts(agg, labelOf) : [];
  const totalLast = agg?.total[lastIdx];
  const topApp = agg ? [...agg.apps].sort((a, b) => b.cells[lastIdx].err5xx - a.cells[lastIdx].err5xx)[0] : null;
  const requests = agg ? { perMin: totalLast.req, p95Ms: totalLast.p95 == null ? null : Math.round(totalLast.p95) } : NA(enabled('nginxLog') ? 'Sin datos' : 'No configurado');
  const errors = agg ? { pct: totalLast.req ? Math.round(totalLast.err5xx / totalLast.req * 10000) / 100 : 0, count: totalLast.err5xx, topApp: topApp && topApp.cells[lastIdx].err5xx ? { name: topApp.name, port: topApp.port, count: topApp.cells[lastIdx].err5xx } : null } : NA(enabled('nginxLog') ? 'Sin datos' : 'No configurado');

  // Sesiones de aplicación
  const sessionRows = huawei?.sessions ?? null;
  let sessions = sqlNA('huawei');
  if (sessionRows) {
    const ipNode = new Map(settings.nodes.map(node => [node.ip, node.name])), groups = new Map();
    for (const row of sessionRows) {
      const label = ipNode.get(row.client_net_address) || (/datasync/i.test(row.program_name) ? 'DataSync' : row.host_name || row.client_net_address || 'Otros');
      groups.set(label, (groups.get(label) || 0) + 1);
    }
    sessions = { total: sessionRows.length, groups: [...groups].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n) };
  }

  const ha = (haSummary(huawei?.ha) ?? haSummary(huawei2?.ha)) || NA(enabled('huawei') ? 'Sin grupo de disponibilidad' : 'No configurado');

  // Nodos
  const stub = data.nginxStatus != null ? parseStubStatus(data.nginxStatus) : null;
  const nodeReq = name => flow.nodes?.find(node => node.name === name)?.req ?? null;
  const cpuOf = source => source?.cpu?.[0]?.sql_cpu != null ? Number(source.cpu[0].sql_cpu) : null;
  const localRole = source => source?.replicas?.find(row => row.is_local)?.role_desc ?? null;
  const healthyBackends = agg ? settings.nodes.filter(node => nodeReq(node.name) > 0).length : null;
  const nodes = [
    { key: 'lb', name: 'Balanceador', ip: settings.balancerHost || null, kind: 'NGINX', status: agg ? 'ok' : 'na', cpuPct: data.cpu?.values?.Balanceador ?? null, reqPerMin: agg ? totalLast.req : null, connections: stub, backends: agg ? { healthy: healthyBackends, total: settings.nodes.length } : null },
    ...settings.nodes.map(node => ({ key: node.name.toLowerCase(), name: node.name, ip: node.ip, kind: 'IIS', status: !agg ? 'na' : nodeReq(node.name) === 0 ? 'down' : alerts.some(a => a.node === node.name) ? 'warn' : 'ok', cpuPct: data.cpu?.values?.[node.name] ?? null, reqPerMin: agg ? nodeReq(node.name) : null })),
    { key: 'sql001', name: 'SQL001', ip: process.env.HUAWEI_SQL_SERVER || null, port: 1433, role: localRole(huawei), status: huawei ? 'ok' : enabled('huawei') ? 'down' : 'na', cpuPct: cpuOf(huawei), txPerSec: rates.huawei?.total ?? null },
    { key: 'sql002', name: 'SQL002', ip: process.env.HUAWEI2_SQL_SERVER || null, port: 5022, role: localRole(huawei2), status: huawei2 ? 'ok' : enabled('huawei2') ? 'down' : 'na', cpuPct: cpuOf(huawei2), sync: (haSummary(huawei2?.ha) ?? haSummary(huawei?.ha))?.state ?? null, redoKb: (haSummary(huawei2?.ha) ?? haSummary(huawei?.ha))?.redoQueueKb ?? null }
  ];

  // Actividad de SQL Server (SQL001)
  let activity = sqlNA('huawei');
  if (huawei) {
    const rows = sessionRows || [];
    const schedulers = huawei.schedulers?.map(row => ({ id: Number(row.scheduler_id), runnable: Number(row.runnable_tasks_count) })) ?? null;
    if (schedulers) { runtime.cpuQueue = [...runtime.cpuQueue, Math.max(0, ...schedulers.map(s => s.runnable))].slice(-10); }
    const waitInfo = huawei.waits ? waitDeltas(runtime.waits, huawei.waits, now) : { snapshot: runtime.waits, top: null };
    runtime.waits = waitInfo.snapshot;
    const currentWaits = new Map();
    for (const row of rows) if (row.wait_type) currentWaits.set(row.wait_type, (currentWaits.get(row.wait_type) || 0) + 1);
    activity = {
      server: 'SQL001',
      states: sessionRows ? summarizeStates(rows, settings.zombieIdleS) : NA('Sin datos'),
      pools: sessionRows ? poolUsage(rows, settings.poolMax, settings.poolAlertPct, settings.zombieIdleS) : NA('Sin datos'),
      cpuQueue: schedulers ? { schedulers, sustained: cpuQueueAlert(runtime.cpuQueue), samples: runtime.cpuQueue.length } : NA('Sin datos'),
      waits: huawei.waits ? { perMinute: waitInfo.top, current: [...currentWaits].map(([wait, sessions]) => ({ wait, sessions })).sort((a, b) => b.sessions - a.sessions) } : NA('Sin datos'),
      processes: sessionRows ? processList(rows, settings, settings.zombieIdleS) : NA('Sin datos'),
      thresholds: { amberS: settings.amberS, redS: settings.redS },
      blockChains: sessionRows ? blockChains(rows) : NA('Sin datos'),
      zombies: sessionRows ? zombieList(rows, settings.zombieIdleS) : NA('Sin datos'),
      counters: huawei.counters ? { userConnections: rates.huawei.general['User Connections'] ?? null, loginsSec: rates.huawei.perSec['Logins/sec'], logoutsSec: rates.huawei.perSec['Logouts/sec'], resetSec: rates.huawei.perSec['Connection Reset/sec'] } : NA('Sin datos')
    };
  }
  const connections = huawei?.connections ? huawei.connections.map(row => ({ source: row.client_net_address, app: row.program_name || null, dest: `${row.local_net_address}:${row.local_tcp_port}`, sessions: Number(row.sessions), encrypt: String(row.encrypt_option).toUpperCase() === 'TRUE', firstLogin: row.first_login })).sort((a, b) => b.sessions - a.sessions) : sqlNA('huawei');

  const currentPhase = settings.events.reduce((idx, event, i) => event.atMs <= localNow ? i : idx, -1);
  const enabledKeys = Object.keys(inputs).filter(key => inputs[key]);
  const available = enabledKeys.some(key => data[key] != null);
  return {
    httpStatus: available ? 200 : 503,
    body: {
      generatedAt: new Date(now).toISOString(), mode: 'live',
      status: !available ? 'error' : warnings.length ? 'partial' : 'ok', warnings,
      window: { start: formatLocal(settings.windowStartMs), now: stamp, current: currentPhase, events: settings.events.map(({ atMs, ...event }) => event) },
      dbs,
      kpis: { writes, sessions, requests, errors, ha },
      history, nodes, alerts, flow, heatmap,
      ports: portsPanel({ settings, probes: data.probes, huawei, agg }),
      connections, activity
    }
  };
}

/* ------------------------------------------------------------------ servicio (consulta + caché breve + muestreo) */
export function createCorteService({ env = process.env, runtimeDir, now = () => Date.now() } = {}) {
  const store = runtimeDir ? createStore(runtimeDir) : nullStore;
  const runtime = { counters: {}, waits: null, cpuQueue: [] };
  const failureFor = (source, error) => ({ source, category: classifySqlError(error), ...serializeSqlError(error) });
  let pending = null, cached = null;
  async function collect() {
    const settings = corteSettings(env, now());
    const huaweiOn = env.HUAWEI_ENABLED === 'true', huawei2On = env.HUAWEI2_ENABLED === 'true';
    const tasks = {
      kio: runQueries('kio', settings),
      huawei: huaweiOn ? runQueries('huawei', settings) : null,
      huawei2: huawei2On ? runQueries('huawei2', settings) : null,
      nginxLog: settings.nginxLogUrl ? fetchText(settings.nginxLogUrl, settings) : null,
      nginxStatus: settings.nginxStatusUrl ? fetchText(settings.nginxStatusUrl, settings) : null,
      cpu: Object.keys(settings.cpuUrls).length ? collectCpu(settings) : null,
      probes: settings.probesOn && (settings.balancerHost || settings.nodes.length) ? collectProbes(settings) : null
    };
    const keys = Object.keys(tasks).filter(key => tasks[key]);
    const settled = await Promise.allSettled(keys.map(key => tasks[key]));
    const inputs = Object.fromEntries(keys.map((key, i) => [key, settled[i]]));
    return corteResponse(inputs, { settings, failureFor, now: now(), runtime, store });
  }
  return {
    async get() {
      if (cached && now() - cached.at < 15000) return cached.result;
      pending ||= collect().then(result => { cached = { at: now(), result }; return result; }).finally(() => { pending = null; });
      return pending;
    },
    startSampler(intervalMs = 60000) {
      const tick = () => this.get().catch(() => {});
      tick();
      return setInterval(tick, intervalMs).unref();
    }
  };
}
