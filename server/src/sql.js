import sql from 'mssql';

function bool(value, fallback = false) {
  if (value == null) return fallback;
  return String(value).toLowerCase() === 'true';
}

export function configFor(prefix) {
  const timeout = Number(process.env[`${prefix}_SQL_TIMEOUT_MS`] || 15000);
  if (prefix === 'LOCAL') {
    if ((process.env.LOCAL_SQL_AUTH || 'windows') !== 'windows') throw new Error('LOCAL_SQL_AUTH debe ser "windows"');
    const driver = process.env.LOCAL_SQL_ODBC_DRIVER || 'ODBC Driver 17 for SQL Server';
    const server = process.env.LOCAL_SQL_SERVER || 'localhost';
    const address = bool(process.env.LOCAL_SQL_USE_TCP) ? `tcp:${server},${process.env.LOCAL_SQL_PORT || 1433}` : server;
    const encryption = (process.env.LOCAL_SQL_ENCRYPT || 'false').toLowerCase();
    const encrypt = encryption === 'optional' ? 'Optional' : ['yes', 'true'].includes(encryption) ? 'Yes' : 'No';
    return { __driver: 'msnodesqlv8', __timeoutMs: timeout, connectionString: `Driver={${driver}};Server=${address};Database=${process.env.LOCAL_SQL_DATABASE || 'master'};Trusted_Connection=Yes;Encrypt=${encrypt};TrustServerCertificate=${bool(process.env.LOCAL_SQL_TRUST_CERT, true) ? 'Yes' : 'No'};`, requestTimeout: timeout, connectionTimeout: timeout, options: { useUTC: false } };
  }
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

export const queries = {
  environment: `
    SELECT @@SERVERNAME AS server_name, d.state_desc, d.is_read_only,
           d.is_in_standby, d.recovery_model_desc
    FROM sys.databases d WHERE d.name = N'TerraController';`,
  tables: `
    USE TerraController;
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
    WHERE s.database_name=N'TerraController' OR s.command LIKE N'%TerraController%'
    ORDER BY j.name;`,
  restoreHistory: `
    USE DBA_Migracion;
    SELECT TOP (100) restauracion_id, archivo,
      CONVERT(varchar(23), backup_start_date, 121) AS backup_start_date,
      CONVERT(varchar(23), backup_finish_date, 121) AS backup_finish_date,
      CONVERT(varchar(23), restore_date, 121) AS restore_date,
      CONVERT(varchar(30), first_lsn) AS first_lsn, CONVERT(varchar(30), last_lsn) AS last_lsn,
      tamano_mb, duracion_segundos, estado, mensaje
    FROM dbo.RestauracionLog ORDER BY restauracion_id DESC;`,
  validation: `
    USE DBA_Migracion;
    SELECT TOP (1) ultima_factura,
      CONVERT(varchar(23), ultima_fecha_facturacion, 121) AS ultima_fecha_facturacion,
      CONVERT(varchar(23), ultima_fecha_sync, 121) AS ultima_fecha_sync,
      estado_base, is_in_standby, is_read_only, resultado,
      CONVERT(varchar(23), fecha_validacion, 121) AS fecha_validacion
    FROM dbo.ValidacionDatos ORDER BY validacion_id DESC;`,
  latestBusinessPoint: `SELECT TOP (1) id_factura,
    CONVERT(varchar(23), fecha_facturacion, 121) AS fecha_facturacion,
    CONVERT(varchar(23), fecha_sync, 121) AS fecha_sync
    FROM TerraController.cw_core.facturas WHERE fecha_sync IS NOT NULL
    ORDER BY fecha_sync DESC, id_factura DESC;`
};

export { sql };
