import sql from 'mssql';

function bool(value, fallback = false) {
  if (value == null) return fallback;
  return String(value).toLowerCase() === 'true';
}

export function configFor(prefix) {
  const timeout = Number(process.env[`${prefix}_SQL_TIMEOUT_MS`] || 15000);
  return {
    __driver: 'tedious', __timeoutMs: timeout,
    server: process.env[`${prefix}_SQL_SERVER`],
    port: Number(process.env[`${prefix}_SQL_PORT`] || 1433),
    user: process.env[`${prefix}_SQL_USER`],
    password: process.env[`${prefix}_SQL_PASSWORD`],
    database: process.env[`${prefix}_SQL_DATABASE`] || 'master',
    options: {
      encrypt: bool(process.env[`${prefix}_SQL_ENCRYPT`]),
      trustServerCertificate: bool(process.env[`${prefix}_SQL_TRUST_CERT`], true),
      enableArithAbort: true
    },
    pool: { min: 0, max: 4, idleTimeoutMillis: 30000 },
    requestTimeout: 30000,
    connectionTimeout: 10000
  };
}

export async function executeQuery(pool, text) { return (await pool.request().query(text)).recordset || []; }
export function createQueryAdapter(pool) { return { query: text => executeQuery(pool, text) }; }
export async function withPool(config, action, driver) {
  driver ||= config.__driver === 'msnodesqlv8' ? (await import('mssql/msnodesqlv8.js')).default : sql;
  const { __driver, __timeoutMs = 15000, ...options } = config;
  const pool = new driver.ConnectionPool(options);
  // mssql shares its default Request class across drivers. Bind each pool to
  // its own driver so loading Windows authentication cannot affect KIO.
  if (driver.Request) pool.request = () => new driver.Request(pool);
  let timer;
  try {
    return await Promise.race([
      (async () => { await pool.connect(); return action(createQueryAdapter(pool)); })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Tiempo de consulta agotado'), { code: 'DASHBOARD_TIMEOUT' })), __timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
    let closeTimer;
    try { await Promise.race([Promise.resolve().then(() => pool.close()).catch(() => {}), new Promise(resolve => { closeTimer = setTimeout(resolve, 250); })]); }
    finally { clearTimeout(closeTimer); }
  }
}

export function classifySqlError(error) {
  if (error?.code === 'ELOGIN' || error?.number === 18456) return 'AUTENTICACION';
  if (/TIMEOUT/i.test(error?.code || '')) return 'TIMEOUT';
  return 'SQL';
}
export function serializeSqlError(error, depth = 0) {
  if (!error || depth > 3) return null;
  const raw = String(error.message || 'Error SQL');
  const result = { message: /password|pwd\s*=|user id\s*=|server\s*=|uid\s*=/i.test(raw) ? '[detalle sensible omitido]' : raw };
  for (const key of ['code', 'number', 'state']) if (error[key] != null) result[key] = error[key];
  if (error.originalError) result.originalError = serializeSqlError(error.originalError, depth + 1);
  if (error.precedingErrors) result.precedingErrors = error.precedingErrors.map(item => serializeSqlError(item, depth + 1));
  return result;
}

export const SYNC_DATABASE = 'TerraControllerDataSync';
const BASE_FILTER = db => `(base_datos = N'${db}' OR base_datos IS NULL)`;
function inventoryQueries(db) {
  return {
    environment: `
    SELECT @@SERVERNAME AS server_name, d.state_desc, d.is_read_only,
           d.is_in_standby, d.recovery_model_desc
    FROM sys.databases d WHERE d.name = N'${db}';`,
    tables: `
    USE ${db};
    SELECT s.name AS [schema], t.name AS [table],
      SUM(CASE WHEN ps.index_id IN (0,1) THEN ps.row_count ELSE 0 END) AS row_count,
      CAST(SUM(ps.reserved_page_count) * 8.0 / 1024 / 1024 AS decimal(18,2)) AS size_gb
    FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id=t.schema_id
    JOIN sys.dm_db_partition_stats ps ON ps.object_id=t.object_id
    GROUP BY s.name,t.name ORDER BY size_gb DESC;`,
    jobs: `
    USE msdb;
    SELECT DISTINCT j.name, j.enabled
    FROM dbo.sysjobs j JOIN dbo.sysjobsteps s ON s.job_id=j.job_id
    WHERE s.database_name=N'${db}' OR s.command LIKE N'%${db}%'
    ORDER BY j.name;`
  };
}
function restoreHistoryQuery(db, strict) {
  return `
    USE DBA_Migracion;
    SELECT TOP (100) restauracion_id, archivo,
      CONVERT(varchar(23), backup_start_date, 121) AS backup_start_date,
      CONVERT(varchar(23), backup_finish_date, 121) AS backup_finish_date,
      CONVERT(varchar(23), restore_date, 121) AS restore_date,
      CONVERT(varchar(30), first_lsn) AS first_lsn, CONVERT(varchar(30), last_lsn) AS last_lsn,
      tamano_mb, duracion_segundos, estado, mensaje
    FROM dbo.RestauracionLog WHERE ${strict ? `base_datos = N'${db}'` : BASE_FILTER(db)} ORDER BY restauracion_id DESC;`;
}

export const queries = {
  ...inventoryQueries('TerraController'),
  restoreHistory: restoreHistoryQuery('TerraController', false),
  latestBusinessPoint: `SELECT TOP (1) id_factura,
    CONVERT(varchar(23), fecha_facturacion, 121) AS fecha_facturacion,
    CONVERT(varchar(23), fecha_sync, 121) AS fecha_sync
    FROM TerraController.cw_core.facturas WHERE fecha_sync IS NOT NULL
    ORDER BY fecha_sync DESC, id_factura DESC;`
};

// TerraControllerDataSync: mismo esquema de monitoreo (full + logs) sobre otra base.
// El punto de referencia es el último evento de DataSync.Logs (índice IX_Logs_FechaEvento).
export const syncQueries = {
  ...inventoryQueries(SYNC_DATABASE),
  restoreHistory: restoreHistoryQuery(SYNC_DATABASE, true),
  latestBusinessPoint: `SELECT TOP (1) IdLog AS id_factura,
    CONVERT(varchar(23), FechaEvento, 121) AS fecha_facturacion,
    CONVERT(varchar(23), FechaEvento, 121) AS fecha_sync
    FROM ${SYNC_DATABASE}.DataSync.Logs WHERE FechaEvento IS NOT NULL
    ORDER BY FechaEvento DESC, IdLog DESC;`
};

export { sql };
