import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySqlError, configFor, createQueryAdapter, executeQuery, queries, serializeSqlError, withPool } from '../src/sql.js';
import { calculateLag, dashboardResponse, decimalLsn, durationLabel, hasContinuousLsnChain, sqlLocalClockMilliseconds } from '../src/dashboard.js';

test('LOCAL uses Shared Memory, Driver 17, Encrypt=No and no SQL credentials', () => {
  const keys = ['LOCAL_SQL_AUTH', 'LOCAL_SQL_ODBC_DRIVER', 'LOCAL_SQL_SERVER', 'LOCAL_SQL_PORT', 'LOCAL_SQL_DATABASE', 'LOCAL_SQL_ENCRYPT', 'LOCAL_SQL_TRUST_CERT', 'LOCAL_SQL_USE_TCP'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    LOCAL_SQL_AUTH: 'windows', LOCAL_SQL_ODBC_DRIVER: 'ODBC Driver 17 for SQL Server',
    LOCAL_SQL_SERVER: 'localhost', LOCAL_SQL_PORT: '1434', LOCAL_SQL_DATABASE: 'master',
    LOCAL_SQL_ENCRYPT: 'false', LOCAL_SQL_TRUST_CERT: 'true', LOCAL_SQL_USE_TCP: 'false'
  });
  try {
    const config = configFor('LOCAL');
    assert.equal(config.__driver, 'msnodesqlv8');
    assert.equal(config.__timeoutMs, 15000);
    assert.equal(config.connectionString, 'Driver={ODBC Driver 17 for SQL Server};Server=localhost;Database=master;Trusted_Connection=Yes;Encrypt=No;TrustServerCertificate=Yes;');
    assert.doesNotMatch(config.connectionString, /tcp:|,1434|password|pwd=|uid=|user id=/i);
  } finally {
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  }
});

test('LOCAL optionally builds a TCP server address with port', () => {
  const oldUseTcp = process.env.LOCAL_SQL_USE_TCP;
  const oldServer = process.env.LOCAL_SQL_SERVER;
  const oldPort = process.env.LOCAL_SQL_PORT;
  Object.assign(process.env, { LOCAL_SQL_USE_TCP: 'true', LOCAL_SQL_SERVER: 'sql-local', LOCAL_SQL_PORT: '1434' });
  try { assert.match(configFor('LOCAL').connectionString, /;Server=tcp:sql-local,1434;/); }
  finally {
    oldUseTcp === undefined ? delete process.env.LOCAL_SQL_USE_TCP : process.env.LOCAL_SQL_USE_TCP = oldUseTcp;
    oldServer === undefined ? delete process.env.LOCAL_SQL_SERVER : process.env.LOCAL_SQL_SERVER = oldServer;
    oldPort === undefined ? delete process.env.LOCAL_SQL_PORT : process.env.LOCAL_SQL_PORT = oldPort;
  }
});

test('LOCAL selects Driver 17 and Encrypt=No from the environment', () => {
  const oldDriver = process.env.LOCAL_SQL_ODBC_DRIVER;
  const oldEncrypt = process.env.LOCAL_SQL_ENCRYPT;
  process.env.LOCAL_SQL_ODBC_DRIVER = 'ODBC Driver 17 for SQL Server';
  process.env.LOCAL_SQL_ENCRYPT = 'No';
  try {
    const config = configFor('LOCAL');
    assert.match(config.connectionString, /^Driver=\{ODBC Driver 17 for SQL Server\};/);
    assert.match(config.connectionString, /;Encrypt=No;/);
  } finally {
    oldDriver === undefined ? delete process.env.LOCAL_SQL_ODBC_DRIVER : process.env.LOCAL_SQL_ODBC_DRIVER = oldDriver;
    oldEncrypt === undefined ? delete process.env.LOCAL_SQL_ENCRYPT : process.env.LOCAL_SQL_ENCRYPT = oldEncrypt;
  }
});

test('LOCAL selects Driver 18 and emits Encrypt=Optional exactly', () => {
  const oldDriver = process.env.LOCAL_SQL_ODBC_DRIVER;
  const oldEncrypt = process.env.LOCAL_SQL_ENCRYPT;
  process.env.LOCAL_SQL_ODBC_DRIVER = 'ODBC Driver 18 for SQL Server';
  process.env.LOCAL_SQL_ENCRYPT = 'Optional';
  try {
    const config = configFor('LOCAL');
    assert.match(config.connectionString, /^Driver=\{ODBC Driver 18 for SQL Server\};/);
    assert.match(config.connectionString, /;Encrypt=Optional;/);
    assert.doesNotMatch(config.connectionString, /(?:UID|PWD|User ID|Password)=/i);
  } finally {
    oldDriver === undefined ? delete process.env.LOCAL_SQL_ODBC_DRIVER : process.env.LOCAL_SQL_ODBC_DRIVER = oldDriver;
    oldEncrypt === undefined ? delete process.env.LOCAL_SQL_ENCRYPT : process.env.LOCAL_SQL_ENCRYPT = oldEncrypt;
  }
});

test('LOCAL rejects SQL authentication', () => {
  const oldValue = process.env.LOCAL_SQL_AUTH;
  process.env.LOCAL_SQL_AUTH = 'sql';
  try { assert.throws(() => configFor('LOCAL'), /debe ser "windows"/); }
  finally { oldValue === undefined ? delete process.env.LOCAL_SQL_AUTH : process.env.LOCAL_SQL_AUTH = oldValue; }
});

test('executeQuery uses the public request().query() API and returns recordset', async () => {
  const calls = [];
  const connection = {
    request() {
      calls.push('request');
      return { async query(text) { calls.push(['query', text]); return { recordset: [{ ok: 1 }] }; } };
    }
  };
  assert.deepEqual(await executeQuery(connection, 'SELECT 1'), [{ ok: 1 }]);
  assert.deepEqual(calls, ['request', ['query', 'SELECT 1']]);
});

test('executeQuery returns an empty array when recordset is absent', async () => {
  const connection = { request: () => ({ query: async () => ({ rowsAffected: [0] }) }) };
  assert.deepEqual(await executeQuery(connection, 'SELECT 1 WHERE 1 = 0'), []);
});

test('pools keep driver-specific requests when multiple SQL drivers coexist', async () => {
  const makeDriver = name => ({
    ConnectionPool: class {
      async connect() {}
      async close() {}
      request() { throw new Error('Shared driver request must not be used'); }
    },
    Request: class {
      async query() { return { recordset: [{ driver: name }] }; }
    }
  });
  const results = await Promise.all(['windows', 'remote'].map(name => withPool({}, adapter => adapter.query('SELECT 1'), makeDriver(name))));
  assert.deepEqual(results, [[{ driver: 'windows' }], [{ driver: 'remote' }]]);
});

test('executeQuery propagates query errors', async () => {
  const expected = Object.assign(new Error('invalid object'), { code: 'EREQUEST' });
  const connection = { request: () => ({ query: async () => { throw expected; } }) };
  await assert.rejects(executeQuery(connection, 'SELECT invalid'), error => error === expected);
});

test('restore history converts every LSN to text in SQL Server', () => {
  assert.match(queries.restoreHistory, /CONVERT\(varchar\(30\), first_lsn\) AS first_lsn/i);
  assert.match(queries.restoreHistory, /CONVERT\(varchar\(30\), last_lsn\) AS last_lsn/i);
});

test('LSNs above Number.MAX_SAFE_INTEGER preserve the last digit as strings', () => {
  const first = '103826000014809200001';
  const last = '103826000014809200009';
  assert.equal(decimalLsn(first), first);
  assert.equal(decimalLsn(last).at(-1), '9');
  assert.throws(() => decimalLsn(Number(first)), /texto decimal/);
});

test('LSN continuity compares exact decimal values without Number conversion', () => {
  const boundary = '103826000014809200001';
  assert.equal(hasContinuousLsnChain([
    { firstLsn: '103826000014809100001', lastLsn: boundary },
    { firstLsn: boundary, lastLsn: '103826000014809300001' }
  ]), true);
  assert.equal(hasContinuousLsnChain([
    { firstLsn: '103826000014809100001', lastLsn: boundary },
    { firstLsn: '103826000014809200000', lastLsn: '103826000014809300001' }
  ]), false);
});

test('SQL local datetime format is parsed without a timezone suffix', () => {
  const value = '2026-09-01 13:59:35.000';
  assert.doesNotMatch(value, /Z$/);
  assert.equal(sqlLocalClockMilliseconds(value), Date.UTC(2026, 8, 1, 13, 59, 35));
  assert.equal(sqlLocalClockMilliseconds('2026-09-01T13:59:35.000Z'), null);
});

test('lag calculates zero, minutes and several days from KIO minus LOCAL', () => {
  assert.deepEqual(calculateLag('2026-09-01 13:59:35.000', '2026-09-01 13:59:35.000'),
    { lagMinutes: 0, lagStatus: 'current', lagLabel: 'Al día' });
  assert.deepEqual(calculateLag('2026-09-01 14:44:35.000', '2026-09-01 13:59:35.000'),
    { lagMinutes: 45, lagStatus: 'behind', lagLabel: '45 minutos' });
  assert.deepEqual(calculateLag('2026-09-04 15:00:35.000', '2026-09-01 13:59:35.000'),
    { lagMinutes: 4381, lagStatus: 'behind', lagLabel: '3 días, 1 hora y 1 minuto' });
  assert.equal(durationLabel(60), '1 hora');
});

test('lag reports anomaly when KIO is earlier and pending for null dates', () => {
  assert.deepEqual(calculateLag('2026-09-01 13:00:00.000', '2026-09-01 14:00:00.000'),
    { lagMinutes: 0, lagStatus: 'anomaly', lagLabel: 'Revisar fechas' });
  assert.deepEqual(calculateLag(null, '2026-09-01 14:00:00.000'),
    { lagMinutes: null, lagStatus: 'pending', lagLabel: 'Pendiente' });
});

test('dashboard date and KIO point queries are read-only and serialize local SQL clocks', () => {
  assert.match(queries.latestBusinessPoint, /TOP \(1\)[\s\S]*WHERE fecha_sync IS NOT NULL[\s\S]*ORDER BY[\s\S]*fecha_sync DESC,[\s\S]*id_factura DESC/i);
  assert.match(queries.latestBusinessPoint, /CONVERT\(varchar\(23\), fecha_sync, 121\)/i);
  assert.match(queries.validation, /CONVERT\(varchar\(23\), ultima_fecha_sync, 121\)/i);
  assert.match(queries.restoreHistory, /CONVERT\(varchar\(23\), restore_date, 121\)/i);
  for (const query of [queries.latestBusinessPoint, queries.validation, queries.restoreHistory]) {
    assert.doesNotMatch(query, /\b(?:INSERT|UPDATE|DELETE|MERGE|BACKUP|RESTORE)\b/i);
  }
});

test('LOCAL and KIO pools use the same executeQuery adapter and close', async () => {
  const instances = [];
  class FakePool {
    constructor(config) { this.config = config; this.closed = false; instances.push(this); }
    async connect() {}
    request() { return { query: async text => ({ recordset: [{ text }] }) }; }
    async close() { this.closed = true; }
  }
  const driver = { ConnectionPool: FakePool };
  for (const kind of ['msnodesqlv8', 'tedious']) {
    const rows = await withPool({ __driver: kind }, adapter => adapter.query('SELECT adapter'), driver);
    assert.deepEqual(rows, [{ text: 'SELECT adapter' }]);
  }
  assert.equal(instances.length, 2);
  assert.ok(instances.every(instance => instance.closed));
});

test('KIO adapter only requires ConnectionPool.request().query()', async () => {
  const calls = [];
  const pool = {
    request() {
      calls.push('request');
      return {
        async query(text) {
          calls.push(['query', text]);
          return { recordset: [{ value: 'KIO' }] };
        }
      };
    }
  };
  const guardedPool = new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'queryRaw') throw new Error('queryRaw must never be accessed');
      return Reflect.get(target, property, receiver);
    }
  });
  assert.deepEqual(await createQueryAdapter(guardedPool).query('SELECT KIO'), [{ value: 'KIO' }]);
  assert.deepEqual(calls, ['request', ['query', 'SELECT KIO']]);
});

test('nested native errors serialize without object coercion or secrets', () => {
  const native = Object.assign(new Error('Login failed for user'), {
    code: 'ELOGIN', number: 18456, state: 1,
    originalError: { message: 'Password=secret;Server=private-host' },
    precedingErrors: [{ message: 'first native error', code: 'ODBC_X' }]
  });
  const result = serializeSqlError(native);
  assert.equal(result.message, 'Login failed for user');
  assert.equal(result.originalError.message, '[detalle sensible omitido]');
  assert.equal(result.precedingErrors[0].code, 'ODBC_X');
  assert.equal(classifySqlError(native), 'AUTENTICACION');
  assert.doesNotMatch(JSON.stringify(result), /secret|private-host/);
});

test('withPool always closes the pool after success and failure', async () => {
  const instances = [];
  class FakePool {
    constructor() { this.closed = false; instances.push(this); }
    async connect() { this.connected = true; }
    async close() { this.closed = true; }
  }
  const fakeDriver = { ConnectionPool: FakePool };
  assert.equal(await withPool({ __driver: 'tedious' }, async () => 42, fakeDriver), 42);
  assert.equal(instances[0].closed, true);
  await assert.rejects(withPool({ __driver: 'tedious' }, async () => { throw new Error('query failed'); }, fakeDriver), /query failed/);
  assert.equal(instances[1].closed, true);

  class FailingConnectPool extends FakePool {
    async connect() { throw new Error('connect failed'); }
  }
  await assert.rejects(withPool({ __driver: 'tedious' }, async () => 0, { ConnectionPool: FailingConnectPool }), /connect failed/);
  assert.equal(instances[2].closed, true);
});

test('withPool times out and closes a pending pool', async () => {
  let closed = false;
  class PendingPool {
    connect() { return new Promise(() => {}); }
    async close() { closed = true; }
  }
  await assert.rejects(withPool({ __driver: 'tedious', __timeoutMs: 10 }, async () => 0, { ConnectionPool: PendingPool }), error => error.code === 'DASHBOARD_TIMEOUT');
  assert.equal(closed, true);
});

test('withPool response is bounded even if pool.close never settles', async () => {
  let closeCalled = false;
  class WedgedPool {
    connect() { return new Promise(() => {}); }
    close() { closeCalled = true; return new Promise(() => {}); }
  }
  const started = Date.now();
  await assert.rejects(withPool({ __driver: 'tedious', __timeoutMs: 10 }, async () => 0, { ConnectionPool: WedgedPool }), error => error.code === 'DASHBOARD_TIMEOUT');
  assert.equal(closeCalled, true);
  assert.ok(Date.now() - started < 1500);
});

const sample = { environment: { state_desc: 'ONLINE' }, tables: [], jobs: [], history: [], validation: null };
const failureFor = source => ({ source, category: 'TIMEOUT', message: `No fue posible conectar con ${source}.` });

test('dashboard returns partial data when only LOCAL succeeds', () => {
  const result = dashboardResponse({ status: 'fulfilled', value: sample }, { status: 'rejected', reason: new Error('down') }, failureFor);
  assert.equal(result.httpStatus, 200); assert.equal(result.body.status, 'partial');
  assert.equal(result.body.data.local, sample); assert.equal(result.body.data.kio, null);
});

test('dashboard returns partial data when only KIO succeeds', () => {
  const result = dashboardResponse({ status: 'rejected', reason: new Error('down') }, { status: 'fulfilled', value: sample }, failureFor);
  assert.equal(result.httpStatus, 200); assert.equal(result.body.status, 'partial');
  assert.equal(result.body.data.local, null); assert.equal(result.body.data.kio, sample);
});

test('dashboard returns 503 only when all enabled sources fail', () => {
  const rejected = { status: 'rejected', reason: new Error('down') };
  const result = dashboardResponse(rejected, rejected, failureFor);
  assert.equal(result.httpStatus, 503); assert.equal(result.body.status, 'error');
  assert.equal(result.body.warnings.length, 2);
});


test('Huawei remains available when both other sources fail', () => {
  const down = { status: 'rejected', reason: new Error('down') };
  const huawei = { ...sample, tables: [{ schema: 'dbo', table: 'only_huawei', row_count: 12, size_gb: 1 }], jobs: [{ name: 'HuaweiJob', enabled: false }], latestBusinessPoint: { id_factura: 123, fecha_sync: '2026-09-21 10:00:00.000' } };
  const {body,httpStatus} = dashboardResponse(down,down,failureFor,{status:'fulfilled',value:huawei});
  assert.equal(httpStatus,200);
  assert.equal(body.status,'partial');
  assert.equal(body.tables[0].huaweiRows,12);
  assert.equal(body.tables[0].kioRows,null);
  assert.equal(body.tables[0].huaweiDifference,null);
  assert.equal(body.jobs[0].huawei,'Deshabilitado');
  assert.equal(body.business.huawei.latestInvoice,123);
  assert.equal(body.environments[2].status,'online');
});

test('Huawei connection failure produces a warning without hiding KIO and Local', () => {
  const up={status:'fulfilled',value:sample};
  const {body}=dashboardResponse(up,up,failureFor,{status:'rejected',reason:new Error('down')});
  assert.equal(body.status,'partial');
  assert.equal(body.warnings[0].source,'HUAWEI');
  assert.equal(body.environments[2].status,'offline');
  assert.equal(body.business.huawei.latestInvoice,null);
});

test('Huawei query permissions failure preserves its environment and marks missing data', () => {
  const up={status:'fulfilled',value:sample};
  const huawei={...sample,tables:null,jobs:null,queryWarnings:[{query:'tables',error:new Error('denied')}]};
  const kio={...sample,tables:[{schema:'dbo',table:'t',row_count:10,size_gb:2}]};
  const {body}=dashboardResponse(up,{status:'fulfilled',value:kio},failureFor,{status:'fulfilled',value:huawei});
  assert.equal(body.status,'partial');
  assert.equal(body.tables[0].huaweiRows,null);
  assert.equal(body.warnings[0].source,'HUAWEI_tables');
  assert.equal(body.environments[2].status,'online');
});

test('Huawei rows and business lag compare against KIO', () => {
  const data=rows=>({...sample,tables:[{schema:'dbo',table:'t',row_count:rows,size_gb:1}],latestBusinessPoint:{fecha_sync:rows===20?'2026-09-21 10:30:00.000':'2026-09-21 10:00:00.000'}});
  const up=value=>({status:'fulfilled',value});
  const {body}=dashboardResponse(up(sample),up(data(20)),failureFor,up(data(12)));
  assert.equal(body.tables[0].huaweiDifference,8);
  assert.equal(body.summary.huaweiLag.lagMinutes,30);
});


test('log chains stay isolated by server and retain exact LSNs', () => {
  const entry=(file,first,last)=>({archivo:file,first_lsn:first,last_lsn:last,tamano_mb:2,estado:'restored',restore_date:'2026-09-21 10:00:00.000'});
  const up=value=>({status:'fulfilled',value});
  const local={...sample,history:[entry('local.trn','103826000014809200001','103826000014809300001')]};
  const huawei={...sample,history:[entry('huawei-new.trn','103826000014809200001','103826000014809300001'),entry('huawei-old.trn','103826000014809100001','103826000014809200001')]};
  const {body}=dashboardResponse(up(local),up(sample),failureFor,up(huawei));
  assert.equal(body.chains.local.entries.length,1);
  assert.equal(body.chains.local.entries[0].file,'local.trn');
  assert.equal(body.chains.local.continuous,null);
  assert.equal(body.chains.huawei.entries.length,2);
  assert.equal(body.chains.huawei.entries[0].firstLsn,'103826000014809200001');
  assert.equal(body.chains.huawei.continuous,true);
  assert.equal(body.chains.huawei.totalMb,4);
  assert.deepEqual(body.chain,body.chains.local.entries);
});

test('chain distinguishes empty history, query failure and disabled server', () => {
  const up=value=>({status:'fulfilled',value});
  let result=dashboardResponse(up(sample),up(sample),failureFor);
  assert.equal(result.body.chains.local.status,'empty');
  assert.equal(result.body.chains.huawei.status,'disabled');
  const failed={...sample,history:null,queryWarnings:[{query:'restoreHistory',error:new Error('denied')}]};
  result=dashboardResponse(up(failed),up(sample),failureFor,up(sample));
  assert.equal(result.body.chains.local.status,'unavailable');
  assert.equal(result.body.chains.local.continuous,null);
  assert.equal(result.body.chains.local.error.source,'LOCAL_restoreHistory');
  assert.equal(result.body.chains.huawei.status,'empty');
  assert.equal(result.body.status,'partial');
});
