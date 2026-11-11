// Pestaña Corte (modo demo): escenario del prototipo, sábado 14-nov-2026 09:42.
const pad = n => String(n).padStart(2, '0');
const at = (day, h, m, s = 0) => `2026-11-${pad(day)} ${pad(h)}:${pad(m)}:${pad(s)}.000`;

export function demoCorte() {
  const events = [
    ['Detener KIO', 'Detener apps', at(13, 22, 0)], ['Congelar y TRN puente', 'Puente', at(13, 23, 0)],
    ['Tail-log', 'Tail-log', at(14, 0, 30)], ['RECOVERY en Huawei', 'RECOVERY', at(14, 3, 30)],
    ['Conectar WEB01/02', 'Conectar WEB', at(14, 7, 0)], ['Pruebas', 'Pruebas', at(14, 8, 30)],
    ['Go y operación', 'Go', at(14, 9, 30)]
  ].map(([label, short, when], i) => ({ key: `e${i}`, label, short, at: when }));

  const history = [];
  const end = 13 * 60 + 42; // minutos desde vie 20:00 hasta sáb 09:42
  for (let minutes = 0; minutes <= end; minutes += minutes < 13 * 60 + 20 ? 5 : 1) {
    const total = 20 * 60 + minutes;
    const kio = minutes < 115 ? Math.round(150 + 20 * Math.sin(minutes / 9)) : minutes < 127 ? 10 : 0;
    const huawei = minutes >= 13 * 60 + 31 ? Math.round(184 - 5 * Math.cos(minutes)) : 0;
    history.push({ t: at(13 + Math.floor(total / 1440), Math.floor(total % 1440 / 60), total % 60), kio, huawei });
  }

  const apps = [
    ['Controller-Portal-Admin', 9090, 1410, [700, 710]], ['Controller-Portal-Clientes', 9091, 960, [500, 460]],
    ['Controller-Servicio-Soap', 9092, 620, [340, 280]], ['Controller-Api', 9093, 1180, [640, 540]],
    ['API-V2', 9095, 540, [540, 0]], ['RidersApi', 9999, 210, [100, 110]], ['Controller-Internal-Services', 3000, 160, [20, 140]]
  ];
  const nodeNames = ['WEB01', 'WEB02'];
  const flow = {
    minute: Date.parse('2026-11-14T15:41:00Z'), total: 5080,
    apps: apps.map(([name, port, req]) => ({ name, port, req, err5xx: port === 9093 ? 3 : 0 })),
    nodes: [{ name: 'WEB01', req: 2840 }, { name: 'WEB02', req: 2240 }],
    links: apps.flatMap(([name, port, , split]) => split.map((req, i) => ({
      app: name, port, node: nodeNames[i], req, err5xx: port === 9093 && i === 0 ? 3 : 0, p95Ms: 180 + (port % 7) * 20, noResponse: req === 0
    })))
  };
  const minutes = Array.from({ length: 15 }, (_, i) => `09:${pad(28 + i)}`);
  const heatmap = {
    minutes, max: 1410,
    rows: apps.map(([name, port, req], row) => ({
      name, port,
      cells: minutes.map((_, i) => {
        const wobble = i === 14 ? 1 : 0.55 + 0.45 * Math.abs(Math.sin(i * 1.7 + row));
        return { req: i < 2 ? Math.round(req * 0.1) : Math.round(req * wobble), err5xx: port === 9093 && i === 13 ? 3 : 0, noNodes: port === 9095 && i >= 10 ? ['WEB02'] : [] };
      })
    }))
  };
  const pools = [
    ['Controller-Site', 500, [8, 3, 106, 2]], ['Controller-Portal-Clientes', 500, [1, 1, 20, 0]], ['API-V-2.0 (.NET 8)', 100, [3, 2, 26, 0]],
    ['Controller-Api', 100, [3, 2, 14, 1]], ['RidersApi', 100, [2, 0, 13, 0]], ['ControllerDataSync', 100, [1, 1, 12, 0]]
  ].map(([app, max, [running, suspended, sleeping, zombie]]) => {
    const total = running + suspended + sleeping + zombie;
    return { app, running, suspended, sleeping, zombie, total, max, pct: Math.round(total / max * 1000) / 10, alert: total / max > 0.8 };
  });
  const proc = (spid, app, origin, status, wait, durationMs, cpuMs, reads, blockedBy, sql) => ({
    spid, app, host: null, origin, status, wait, durationMs, level: durationMs >= 30000 ? 'red' : durationMs >= 10000 ? 'amber' : 'ok', cpuMs, reads, blockedBy, sql
  });
  const dest = (ip) => `${ip}:1433`;

  return {
    generatedAt: new Date().toISOString(), mode: 'demo', status: 'ok', warnings: [],
    window: { start: at(13, 20, 0), now: at(14, 9, 42, 18), current: 6, events },
    dbs: {
      kio: [{ name: 'TerraController', state: 'RESTORING', standby: false }, { name: 'TerraControllerDataSync', state: 'RESTORING', standby: false }],
      huawei: [{ name: 'TerraController', state: 'ONLINE', standby: false }, { name: 'TerraControllerDataSync', state: 'ONLINE', standby: false }]
    },
    kpis: {
      writes: { kio: 0, huawei: 184, kioSilentSince: at(13, 22, 7), firstWriteHuawei: { at: at(14, 9, 31, 7), db: 'TerraController' }, huaweiByDb: { TerraController: 171, TerraControllerDataSync: 13 }, kioByDb: {} },
      sessions: { total: 212, groups: [{ label: 'WEB01', n: 108 }, { label: 'WEB02', n: 90 }, { label: 'DataSync', n: 14 }] },
      requests: { perMin: 5080, p95Ms: 240 },
      errors: { pct: 0.06, count: 3, topApp: { name: 'Controller-Api', port: 9093, count: 3 } },
      ha: { state: 'SYNCHRONIZED', health: 'HEALTHY', logSendQueueKb: 0, redoQueueKb: 0, databases: 2 }
    },
    history,
    nodes: [
      { key: 'lb', name: 'Balanceador', ip: '10.22.0.18', kind: 'NGINX', status: 'ok', cpuPct: 22, reqPerMin: 5080, connections: 1240, backends: { healthy: 2, total: 2 } },
      { key: 'web01', name: 'WEB01', ip: '10.22.0.35', kind: 'IIS', status: 'ok', cpuPct: 38, reqPerMin: 2840 },
      { key: 'web02', name: 'WEB02', ip: '10.22.0.34', kind: 'IIS', status: 'warn', cpuPct: 31, reqPerMin: 2240 },
      { key: 'sql001', name: 'SQL001', ip: '10.22.0.10', port: 1433, role: 'PRIMARY', status: 'ok', cpuPct: 44, txPerSec: 184 },
      { key: 'sql002', name: 'SQL002', ip: '10.22.0.11', port: 5022, role: 'SECONDARY', status: 'ok', cpuPct: 12, sync: 'SYNCHRONIZED', redoKb: 0 }
    ],
    alerts: [{ kind: 'noResponse', app: 'API-V2', port: 9095, node: 'WEB02', since: '09:38', minutes: 5 }],
    flow, heatmap,
    ports: [
      { port: '443', label: 'Usuarios → balanceador 10.22.0.18 · TLSv1.3', state: 'ok', badge: 'abierto', ms: 42, code: 200 },
      { port: '80', label: 'Redirección 301 a HTTPS', state: 'ok', badge: 'correcto', ms: 8, code: 301 },
      { port: '9090–9095', label: '10.22.0.18 → sitios IIS en WEB01/WEB02', state: 'warn', badge: '4 de 5' },
      { port: '3000–9999', label: 'RidersApi · Internal-Services', state: 'ok', badge: 'abierto' },
      { port: '1433', label: 'Nodos web → Listener', state: 'ok', badge: '198 sesiones' },
      { port: '1433', label: 'ControllerDataSync → Listener DS', state: 'warn', badge: 'sin cifrar' },
      { port: '5022', label: 'SQL001 ↔ SQL002 · réplica', state: 'ok', badge: 'conectado' },
      { port: '3343', label: 'Clúster WSFC', state: 'ok', badge: '2 nodos' },
      { port: '445', label: 'Clúster → testigo', state: 'warn', badge: 'sin testigo' }
    ],
    connections: [
      { source: '10.22.0.35', app: 'Controller-Site', dest: dest('10.22.0.12'), sessions: 62, encrypt: true, firstLogin: at(14, 9, 30, 12) },
      { source: '10.22.0.34', app: 'Controller-Site', dest: dest('10.22.0.12'), sessions: 58, encrypt: true, firstLogin: at(14, 9, 30, 15) },
      { source: '10.22.0.35', app: 'API-V-2.0 (.NET 8)', dest: dest('10.22.0.12'), sessions: 31, encrypt: true, firstLogin: at(14, 9, 31, 2) },
      { source: '10.22.0.34', app: 'Controller-Portal-Clientes', dest: dest('10.22.0.12'), sessions: 22, encrypt: true, firstLogin: at(14, 9, 31, 40) },
      { source: '10.22.0.35', app: 'RidersApi', dest: dest('10.22.0.12'), sessions: 15, encrypt: true, firstLogin: at(14, 9, 32, 5) },
      { source: '10.10.4.21', app: 'ControllerDataSync', dest: dest('10.22.0.13'), sessions: 14, encrypt: false, firstLogin: at(14, 9, 34, 51) }
    ],
    activity: {
      server: 'SQL001',
      states: { running: 18, runnable: 4, suspended: 9, sleeping: 179, zombie: 2, blocked: 1 },
      pools,
      cpuQueue: { schedulers: [0, 1, 0, 2, 0, 0, 1, 0].map((runnable, id) => ({ id, runnable })), sustained: false, samples: 3 },
      waits: {
        perMinute: [{ wait: 'LCK_M_U', seconds: 18.4 }, { wait: 'PAGEIOLATCH_SH', seconds: 9.6 }, { wait: 'WRITELOG', seconds: 5.2 }, { wait: 'ASYNC_NETWORK_IO', seconds: 3.1 }, { wait: 'CXPACKET', seconds: 2.4 }],
        current: [{ wait: 'PAGEIOLATCH_SH', sessions: 4 }, { wait: 'ASYNC_NETWORK_IO', sessions: 3 }, { wait: 'LCK_M_U', sessions: 1 }]
      },
      processes: [
        proc(87, 'Controller-Api', '10.22.0.34', 'bloqueada', 'LCK_M_U', 48000, 400, 1204, 112, 'UPDATE cw_core.facturas SET estado = @p1 WHERE id_factura = @p2'),
        proc(112, 'Controller-Site', '10.22.0.35', 'suspended', 'PAGEIOLATCH_SH', 34000, 12800, 1900000, null, 'EXEC cw_core.sp_reporte_ventas_credito_cliente @desde, @hasta'),
        proc(141, 'ControllerDataSync', '10.10.4.21', 'running', null, 12000, 9100, 640000, null, 'INSERT INTO DataSync.DatosAsincronos (…) SELECT …'),
        proc(96, 'API-V-2.0 (.NET 8)', '10.22.0.35', 'runnable', 'SOS_SCHEDULER_YIELD', 6000, 5700, 220000, null, 'SELECT f.*, t.* FROM cw_core.facturas f JOIN cw_core.turnos t …'),
        proc(133, 'Controller-Portal-Clientes', '10.22.0.34', 'suspended', 'ASYNC_NETWORK_IO', 4000, 900, 88000, null, 'SELECT * FROM cw_core.reporte_transaccion_factura WHERE …'),
        proc(158, 'RidersApi', '10.22.0.35', 'running', null, 1000, 200, 3000, null, 'EXEC cw_core.sp_riders_pedidos_pendientes @rider'),
        proc(74, 'Controller-Site', '10.22.0.35', 'running', 'WRITELOG', 400, 100, 120, null, 'INSERT INTO cw_core.detalle_log_proceso (…) VALUES (…)')
      ],
      thresholds: { amberS: 10, redS: 30 },
      blockChains: [{ root: { spid: 112, app: 'Controller-Site', origin: '10.22.0.35', state: 'zombie' }, victims: [87], length: 2 }],
      zombies: [
        { spid: 112, app: 'Controller-Site', origin: '10.22.0.35', openTransactions: 1, idleS: 732, login: 'app_controller', loginTime: at(14, 9, 30) },
        { spid: 205, app: 'Controller-Api', origin: '10.22.0.34', openTransactions: 2, idleS: 880, login: 'app_api', loginTime: at(14, 9, 31) }
      ],
      counters: { userConnections: 212, loginsSec: 3.2, logoutsSec: 3.1, resetSec: 41.5 }
    }
  };
}
