import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateNginx, blockChains, corteQueries, corteResponse, corteSettings, counterRate, cpuQueueAlert, flowFrom, heatmapFrom,
  noResponseAlerts, parseEvents, parseLocal, poolUsage, sessionState, summarizeStates, waitDeltas, writeRates, zombieList
} from '../src/corte.js';
import { demoCorte } from '../src/demo-data.js';
import { classifySqlError, serializeSqlError } from '../src/sql.js';

const failureFor = (source, error) => ({ source, category: classifySqlError(error), ...serializeSqlError(error) });
const NOW = Date.parse('2026-11-14T15:42:30Z'); // 09:42:30 en Guatemala (UTC-6)

test('tx/s se calcula por diferencia de contadores acumulados', () => {
  assert.equal(counterRate(1000, 1600, 60000), 10);
  assert.equal(counterRate(null, 1600, 60000), null, 'la primera lectura no tiene base');
  assert.equal(counterRate(2000, 100, 60000), null, 'un contador que baja (reinicio) no produce tasa');
  const first = writeRates(null, [{ object_name: 'MSSQL:Databases', counter_name: 'Write Transactions/sec', instance_name: 'TerraController', cntr_value: '1000' }], 0);
  assert.equal(first.total, null);
  const second = writeRates(first.snapshot, [
    { object_name: 'MSSQL:Databases', counter_name: 'Write Transactions/sec', instance_name: 'TerraController', cntr_value: '1600' },
    { object_name: 'MSSQL:Databases', counter_name: 'Write Transactions/sec', instance_name: 'TerraControllerDataSync', cntr_value: '50' }
  ], 60000);
  assert.equal(second.byDb.TerraController, 10);
  assert.equal(second.total, 10, 'una base sin lectura previa no se suma');
});

test('esperas por minuto: diferencia, orden y top 5', () => {
  const prev = { t: 0, waits: { LCK_M_U: 1000, WRITELOG: 500, OLD: 100 } };
  const { top } = waitDeltas(prev, [{ wait_type: 'LCK_M_U', wait_time_ms: 19400 }, { wait_type: 'WRITELOG', wait_time_ms: 5700 }, { wait_type: 'OLD', wait_time_ms: 100 }], 60000);
  assert.deepEqual(top, [{ wait: 'LCK_M_U', seconds: 18.4 }, { wait: 'WRITELOG', seconds: 5.2 }]);
  assert.equal(waitDeltas(null, [], 0).top, null);
});

test('las consultas son solo SELECT sobre DMV, con timeout y sin la sesión del monitor', () => {
  const queries = corteQueries(corteSettings({ CORTE_MONITOR_APP: "Mi'Monitor" }, NOW));
  for (const [name, sql] of Object.entries(queries)) {
    assert.ok(sql.startsWith('SET LOCK_TIMEOUT 5000; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;'), name);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|KILL|BACKUP|RESTORE|DROP|ALTER|EXEC)\b/i, name);
  }
  assert.match(queries.sessions, /@@SPID/);
  assert.match(queries.sessions, /Mi''Monitor/);
  assert.match(queries.counters, /Write Transactions\/sec/);
});

const logLine = (iso, ip, port, status, secs, host = 'app') => `${iso} ${ip}:${port} ${status} ${secs} "${host}" "/x"`;
const sites = [{ name: 'Controller-Api', port: 9093 }, { name: 'API-V2', port: 9095 }];
const nodes = [{ name: 'WEB01', ip: '10.22.0.35' }, { name: 'WEB02', ip: '10.22.0.34' }];

test('el log de NGINX se agrega por minuto, puerto y nodo', () => {
  const lines = [
    logLine('2026-11-14T09:41:05-06:00', '10.22.0.35', 9093, 200, '0.100'),
    logLine('2026-11-14T09:41:10-06:00', '10.22.0.35', 9093, 200, '0.300'),
    logLine('2026-11-14T09:41:20-06:00', '10.22.0.34', 9093, 502, '0.200'),
    logLine('2026-11-14T09:41:30-06:00', '10.22.0.35', 9095, 200, '0.050'),
    logLine('2026-11-14T09:41:31-06:00', '10.22.0.35, 10.22.0.34', 9095, 200, '0.080, 0.090'), // reintento: cuenta el último upstream
    logLine('2026-11-14T09:42:10-06:00', '10.22.0.35', 9093, 200, '0.100'), // minuto en curso: se ignora
    logLine('2026-11-14T09:41:40-06:00', '10.22.0.35', 8080, 200, '0.100'), // puerto desconocido
    'línea corrupta'
  ].join('\n');
  const agg = aggregateNginx(lines, { now: NOW, sites, nodes });
  assert.equal(agg.minutes.length, 15);
  const last = agg.apps[0].cells.at(-1);
  assert.equal(last.req, 3);
  assert.equal(last.err5xx, 1);
  assert.equal(last.nodes.WEB01.req, 2);
  assert.equal(last.nodes.WEB02.req, 1);
  assert.equal(last.p95, 300);
  assert.equal(agg.total.at(-1).req, 5);
  const flow = flowFrom(agg);
  assert.equal(flow.total, 5);
  assert.equal(flow.links.find(l => l.app === 'API-V2' && l.node === 'WEB02').req, 1);
});

test('un nodo sin tráfico para una aplicación con tráfico queda "sin respuesta" y alerta desde cuándo', () => {
  const lines = [];
  for (const minute of ['38', '39', '40', '41']) {
    lines.push(logLine(`2026-11-14T09:${minute}:05-06:00`, '10.22.0.35', 9095, 200, '0.1'));
    lines.push(logLine(`2026-11-14T09:${minute}:06-06:00`, '10.22.0.34', 9093, 200, '0.1'));
    lines.push(logLine(`2026-11-14T09:${minute}:07-06:00`, '10.22.0.35', 9093, 200, '0.1'));
  }
  const agg = aggregateNginx(lines.join('\n'), { now: NOW, sites, nodes });
  const flow = flowFrom(agg);
  assert.equal(flow.links.find(l => l.app === 'API-V2' && l.node === 'WEB02').noResponse, true);
  assert.equal(flow.links.find(l => l.app === 'Controller-Api' && l.node === 'WEB02').noResponse, false);
  const labelOf = ms => new Date(ms - 6 * 3600000).toISOString().slice(11, 16);
  assert.deepEqual(noResponseAlerts(agg, labelOf).map(a => [a.app, a.node, a.since, a.minutes]), [['API-V2', 'WEB02', '09:38', 4]]);
  const heat = heatmapFrom(agg, labelOf);
  assert.deepEqual(heat.rows[1].cells.at(-1).noNodes, ['WEB02']);
  assert.equal(heat.minutes.at(-1), '09:41');
});

test('zombies: sleeping con transacción abierta e inactiva más de 60 s', () => {
  const sleeping = { session_status: 'sleeping', open_transaction_count: 1, idle_s: 120 };
  assert.equal(sessionState(sleeping), 'zombie');
  assert.equal(sessionState({ ...sleeping, idle_s: 30 }), 'sleeping');
  assert.equal(sessionState({ ...sleeping, open_transaction_count: 0 }), 'sleeping');
  assert.equal(sessionState({ session_status: 'running', request_status: 'suspended' }), 'suspended');
  assert.equal(sessionState({ session_status: 'running', request_status: 'runnable' }), 'runnable');
  assert.equal(sessionState({ ...sleeping, request_status: 'running' }), 'running', 'con request activo no es zombie');
});

const rows = [
  { session_id: 112, program_name: 'Controller-Site', client_net_address: '10.22.0.35', login_name: 'app_controller', session_status: 'sleeping', open_transaction_count: 1, idle_s: 372 },
  { session_id: 87, program_name: 'Controller-Api', client_net_address: '10.22.0.34', session_status: 'running', request_status: 'suspended', wait_type: 'LCK_M_U', blocking_session_id: 112, duration_ms: '48000', cpu_time: 400, logical_reads: '1204', sql_text: 'UPDATE  x\n SET y=1' },
  { session_id: 90, program_name: 'Controller-Api', session_status: 'running', request_status: 'suspended', blocking_session_id: 87, duration_ms: 12000 },
  { session_id: 120, program_name: 'RidersApi', session_status: 'running', request_status: 'running', blocking_session_id: 0, duration_ms: 500 },
  { session_id: 130, program_name: 'RidersApi', session_status: 'sleeping', open_transaction_count: 0, idle_s: 5 }
];

test('estados, bloqueos (cadena y raíz) y zombies', () => {
  assert.deepEqual(summarizeStates(rows), { running: 1, runnable: 0, suspended: 2, sleeping: 1, zombie: 1, blocked: 2 });
  const chains = blockChains(rows);
  assert.equal(chains.length, 1);
  assert.equal(chains[0].root.spid, 112);
  assert.deepEqual(chains[0].victims, [87, 90]);
  assert.equal(chains[0].length, 3);
  assert.deepEqual(zombieList(rows).map(z => [z.spid, z.openTransactions, z.idleS, z.login]), [[112, 1, 372, 'app_controller']]);
});

test('pool por aplicación contra Max Pool Size, alerta sobre 80 %', () => {
  const many = Array.from({ length: 85 }, (_, i) => ({ session_id: i, program_name: 'RidersApi', session_status: 'sleeping', idle_s: 1 }));
  const pools = poolUsage([...many, ...rows.slice(0, 2)], { default: 100, 'Controller-Site': 500 });
  assert.equal(pools[0].app, 'RidersApi');
  assert.equal(pools[0].pct, 85);
  assert.equal(pools[0].alert, true);
  assert.equal(pools.find(p => p.app === 'Controller-Site').max, 500);
  assert.equal(pools.find(p => p.app === 'Controller-Site').alert, false);
});

test('cola de CPU: alerta con 2 o más sostenido durante 3 muestras', () => {
  assert.equal(cpuQueueAlert([2, 3, 2]), true);
  assert.equal(cpuQueueAlert([2, 1, 2]), false);
  assert.equal(cpuQueueAlert([3, 3]), false);
});

test('eventos de la ventana se ordenan cruzando la medianoche', () => {
  const start = parseLocal('2026-11-13 20:00');
  const events = parseEvents('22:00=Detener KIO|Detener,00:30=Tail-log,09:30=Go', start);
  assert.deepEqual(events.map(e => e.at), ['2026-11-13 22:00:00.000', '2026-11-14 00:30:00.000', '2026-11-14 09:30:00.000']);
  assert.equal(events[0].short, 'Detener');
});

const kioOk = { status: 'fulfilled', value: { queryWarnings: [], dbs: [{ name: 'TerraController', state_desc: 'RESTORING', is_in_standby: 0 }], counters: [{ object_name: 'MSSQL:Databases', counter_name: 'Write Transactions/sec', instance_name: 'TerraController', cntr_value: '10' }] } };
const ctx = () => ({ settings: corteSettings({ CORTE_WINDOW_START: '2026-11-13 20:00' }, NOW), failureFor, now: NOW, runtime: { counters: {}, waits: null, cpuQueue: [] } });

test('respuesta partial cuando falla una fuente y el resto conserva sus datos', () => {
  const result = corteResponse({ kio: kioOk, huawei: { status: 'rejected', reason: Object.assign(new Error('Tiempo de consulta agotado'), { code: 'DASHBOARD_TIMEOUT' }) } }, ctx());
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.status, 'partial');
  assert.equal(result.body.warnings[0].source, 'HUAWEI');
  assert.equal(result.body.warnings[0].category, 'TIMEOUT');
  assert.equal(result.body.dbs.kio[0].state, 'RESTORING');
  assert.equal(result.body.activity.unavailable, true);
  assert.equal(result.body.activity.reason, 'Sin datos');
  assert.equal(result.body.nodes.find(n => n.key === 'sql001').status, 'down');
});

test('una consulta que falla dentro de una fuente deja esa sección sin datos y la respuesta partial', () => {
  const huawei = { status: 'fulfilled', value: { queryWarnings: [{ query: 'ha', error: Object.assign(new Error('permiso denegado'), { number: 300 }) }], dbs: [], counters: [], sessions: rows, schedulers: [], waits: [], cpu: [], ha: null, replicas: [], endpoints: [], cluster: [], connections: [], firstWrite: [] } };
  const result = corteResponse({ kio: kioOk, huawei }, ctx());
  assert.equal(result.body.status, 'partial');
  assert.equal(result.body.kpis.ha.unavailable, true);
  assert.equal(result.body.activity.states.zombie, 1);
  assert.equal(result.body.warnings.some(w => w.source === 'HUAWEI_ha'), true);
});

test('error 503 solo cuando todas las fuentes habilitadas fallan; lo no configurado no es falla', () => {
  const fail = { status: 'rejected', reason: new Error('x') };
  assert.equal(corteResponse({ kio: fail, huawei: fail }, ctx()).httpStatus, 503);
  const ok = corteResponse({ kio: kioOk }, ctx());
  assert.equal(ok.body.status, 'ok');
  assert.equal(ok.body.flow.reason, 'No configurado');
});

test('la primera escritura en Huawei se conserva tras RECOVERY y la historia guarda una muestra', () => {
  let saved = {}; const history = [];
  const store = { loadState: () => saved, saveState: s => { saved = s; }, appendHistory: p => history.push(p), readHistory: () => history };
  const huawei = { status: 'fulfilled', value: { queryWarnings: [], dbs: [], counters: [], firstWrite: [{ db: 'TerraController', last_update: '2026-11-14 09:31:07.000' }, { db: 'TerraControllerDataSync', last_update: '2026-11-14 02:00:00.000' }] } };
  const first = corteResponse({ kio: kioOk, huawei }, { ...ctx(), store });
  assert.equal(first.body.kpis.writes.firstWriteHuawei.at, '2026-11-14 09:31:07.000', 'ignora lo anterior al RECOVERY (03:30)');
  const later = { ...huawei, value: { ...huawei.value, firstWrite: [{ db: 'TerraController', last_update: '2026-11-14 09:40:00.000' }] } };
  assert.equal(corteResponse({ kio: kioOk, huawei: later }, { ...ctx(), store }).body.kpis.writes.firstWriteHuawei.at, '2026-11-14 09:31:07.000');
});

test('el demo expone el mismo contrato que la API', () => {
  const demo = demoCorte();
  const live = corteResponse({ kio: kioOk }, ctx()).body;
  for (const key of Object.keys(live)) assert.ok(key in demo, `falta ${key} en demo`);
  assert.equal(demo.window.events.length, 7);
  assert.equal(demo.flow.links.some(l => l.noResponse), true);
});

import { parseCpu } from '../src/corte.js';
test('CPU de balanceador y WEB: acepta JSON o número y descarta lo no válido', () => {
  assert.equal(parseCpu('{"cpu": 38.46}'), 38.5);
  assert.equal(parseCpu('22'), 22);
  assert.equal(parseCpu('{"cpu":"x"}'), null);
  assert.equal(parseCpu('150'), null);
  assert.equal(parseCpu('<html>'), null);
  const cpu = { status: 'fulfilled', value: { values: { Balanceador: 22, WEB01: 38.5, WEB02: null }, queryWarnings: [{ query: 'WEB02', error: new Error('Sin respuesta (ECONNREFUSED)') }] } };
  const result = corteResponse({ kio: kioOk, cpu }, ctx()).body;
  assert.equal(result.nodes.find(n => n.name === 'WEB01').cpuPct, 38.5);
  assert.equal(result.nodes.find(n => n.name === 'Balanceador').cpuPct, 22);
  assert.equal(result.nodes.find(n => n.name === 'WEB02').cpuPct, null);
  assert.equal(result.status, 'partial');
  assert.equal(result.warnings[0].source, 'CPU_WEB02');
});
