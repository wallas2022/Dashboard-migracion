import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download, RefreshCw, TriangleAlert } from 'lucide-react';
import { sankey, sankeyLinkHorizontal } from 'd3-sankey';
import { linkHorizontal } from 'd3-shape';
import { exportEvidence } from './corte-export.js';
import logoWhite from '../images/logo-servicios-compartidos.png';

const COLORS = { huawei: '#2BB39A', web01: '#2BB39A', web02: '#8B8CF8', lb: '#6C63D9', kio: '#F2B84B', warn: '#F2B84B', bad: '#F2696B' };
const nf = new Intl.NumberFormat('es-GT');
const fmt = value => value == null ? 'Sin datos' : nf.format(value);
const na = value => value == null || value.unavailable === true;
const hm = text => text ? text.slice(11, 16) : '—';
const hms = text => text ? text.slice(11, 19) : '—';
const localMs = text => Date.parse(text.replace(' ', 'T') + 'Z');
const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'], MON = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const dayLabel = text => { const d = new Date(localMs(text)); return `${DOW[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, '0')}-${MON[d.getUTCMonth()]}`; };
const compact = n => n >= 1e6 ? (n / 1e6).toFixed(1) + ' M' : n >= 1e3 ? Math.round(n / 1e3) + ' K' : String(n);
const duration = ms => ms < 1000 ? `${ms} ms` : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60000)} min ${Math.round(ms % 60000 / 1000)} s`;
const idle = s => s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;

function useCorte() {
  const [data, setData] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const request = useRef(null);
  const load = () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 25000);
    setLoading(true); setError('');
    fetch('/api/corte', { signal: controller.signal }).then(async response => {
      const text = await response.text();
      if (!text.trim()) throw new Error('HTTP ' + response.status + ' sin contenido');
      let body; try { body = JSON.parse(text); } catch { throw new Error('contenido no válido (HTTP ' + response.status + ')'); }
      if (!response.ok && !body.kpis) throw new Error(body.error || 'HTTP ' + response.status);
      return body;
    }).then(setData)
      .catch(e => { if (request.current === controller) setError(e.name === 'AbortError' ? 'La consulta excedió el tiempo de espera. Intente actualizar.' : e.message); })
      .finally(() => { clearTimeout(timeout); if (request.current === controller) setLoading(false); });
  };
  useEffect(() => { load(); const id = setInterval(load, 60000); return () => { clearInterval(id); request.current?.abort(); request.current = null; }; }, []);
  return { data, error, loading, load };
}

const Empty = ({ value }) => <p className="muted">{value?.reason || 'Sin datos'}</p>;
const Panel = ({ title, aside, children, className = '' }) => <section className={'card panel ' + className}><div className="panel-head"><h3>{title}</h3>{aside}</div>{children}</section>;
const Pill = ({ state, children }) => <span className={'pill ' + state}>{children}</span>;
const Scroll = ({ children }) => <div className="scroll">{children}</div>;

function Phases({ window: win }) {
  return <section className="card phases" aria-label="Fases de la ventana">{win.events.map((event, i) => <div key={event.key} className={'phase ' + (i < win.current ? 'done' : i === win.current ? 'current' : '')} aria-current={i === win.current ? 'step' : undefined}>
    <i /><span className="mono">{i === 0 ? dayLabel(event.at).split(' ')[0] + ' ' : ''}{hm(event.at)}</span><b>{event.label}</b></div>)}</section>;
}

function Kpis({ kpis }) {
  const { writes, sessions, requests, errors, ha } = kpis;
  return <section className="kpis">
    <article className="card kpi"><p>Escrituras Huawei</p>{na(writes) ? <Empty value={writes} /> : <><strong>{writes.huawei == null ? 'Sin datos' : fmt(writes.huawei)}<small> tx/s</small></strong><span className="ok">{writes.firstWriteHuawei ? `Primera escritura ${hms(writes.firstWriteHuawei.at)}` : 'Sin escrituras todavía'}</span></>}</article>
    <article className="card kpi"><p>Escrituras KIO</p>{na(writes) ? <Empty value={writes} /> : <><strong>{writes.kio == null ? 'Sin datos' : fmt(writes.kio)}<small> tx/s</small></strong><span>{writes.kioSilentSince ? `Sin escrituras desde ${hm(writes.kioSilentSince)}` : ' '}</span></>}</article>
    <article className="card kpi"><p>Sesiones de aplicación</p>{na(sessions) ? <Empty value={sessions} /> : <><strong>{fmt(sessions.total)}</strong><span>{sessions.groups.map(g => `${g.label} ${g.n}`).join(' · ')}</span></>}</article>
    <article className="card kpi"><p>Peticiones al balanceador</p>{na(requests) ? <Empty value={requests} /> : <><strong>{fmt(requests.perMin)}<small> /min</small></strong><span>{requests.p95Ms == null ? 'p95 sin datos' : `p95 ${requests.p95Ms} ms`}</span></>}</article>
    <article className="card kpi"><p>Errores 5xx</p>{na(errors) ? <Empty value={errors} /> : <><strong className={errors.count ? 'warn' : 'ok'}>{errors.pct.toLocaleString('es-GT', { minimumFractionDigits: 2 })}%</strong><span className={errors.topApp ? 'warn' : ''}>{errors.topApp ? `${errors.count} en ${errors.topApp.name} :${errors.topApp.port}` : 'Sin errores en el último minuto'}</span></>}</article>
    <article className="card kpi"><p>Alta disponibilidad</p>{na(ha) ? <Empty value={ha} /> : <><strong className={ha.health === 'HEALTHY' ? 'ok' : 'bad'}>{ha.health || 'Sin datos'}</strong><span>{ha.state ? ha.state.toLowerCase() : 'sin estado'} · cola {fmt(ha.logSendQueueKb)} KB · redo {fmt(ha.redoQueueKb)} KB</span></>}</article>
  </section>;
}

function WritesChart({ history, win }) {
  const W = 760, H = 310, M = { l: 40, r: 14, t: 52, b: 34 };
  const HOUR = 3600000;
  // El eje empieza en el primer dato disponible (no antes de la ventana) y llega hasta el último evento aún vigente.
  const windowStart = localMs(win.start), firstPoint = history.length ? localMs(history[0].t) : windowStart;
  const start = Math.max(windowStart, Math.floor(firstPoint / HOUR) * HOUR);
  const lastPoint = history.length ? localMs(history.at(-1).t) : start;
  const upcoming = win.events.map(e => localMs(e.at)).filter(t => t >= start && t <= start + 36 * HOUR);
  const end = Math.max(lastPoint, ...upcoming) + 30 * 60000;
  const top = Math.max(50, ...history.flatMap(p => [p.kio || 0, p.huawei || 0]));
  const ymax = Math.ceil(top / 50) * 50;
  const x = ms => M.l + (ms - start) / (end - start) * (W - M.l - M.r), y = v => M.t + (1 - v / ymax) * (H - M.t - M.b);
  const path = key => { let d = '', open = false; for (const p of history) { if (p[key] == null) { open = false; continue; } d += `${open ? 'L' : 'M'}${x(localMs(p.t)).toFixed(1)},${y(p[key]).toFixed(1)}`; open = true; } return d; };
  const step = ([1, 2, 3, 6, 12, 24].find(h => (end - start) / h / HOUR <= 8) || 24) * HOUR;
  const ticks = []; for (let t = Math.ceil(start / step) * step; t <= end; t += step) ticks.push(t);
  const multiDay = end - start > 24 * HOUR;
  const lastIdx = win.events.length - 1;
  // Etiquetas de eventos en hasta 4 filas para que no se encimen.
  const rowEnds = [-1e9, -1e9, -1e9, -1e9], labelRow = {};
  win.events.map((event, i) => ({ event, i, px: x(localMs(event.at)) })).sort((a, b) => a.px - b.px).forEach(({ event, i, px }) => {
    const width = event.short.length * 6.5 + 8; let row = rowEnds.findIndex(end2 => px - width / 2 > end2);
    if (row < 0) row = i % rowEnds.length; rowEnds[row] = px + width / 2; labelRow[event.key] = row;
  });
  return <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Escrituras por segundo de KIO y Huawei">
    {[0, 0.5, 1].map(f => <g key={f}><line x1={M.l} x2={W - M.r} y1={y(ymax * f)} y2={y(ymax * f)} className="grid" /><text x={M.l - 6} y={y(ymax * f) + 4} textAnchor="end" className="tick">{Math.round(ymax * f)}</text></g>)}
    {ticks.map(t => { const d = new Date(t); return <text key={t} x={x(t)} y={H - 10} textAnchor="middle" className="tick mono">{multiDay ? DOW[d.getUTCDay()] + ' ' : ''}{String(d.getUTCHours()).padStart(2, '0')}:00</text>; })}
    {win.events.map((event, i) => { const at = localMs(event.at), px = x(at); const go = i === lastIdx; return at >= start && at <= end ? <g key={event.key}><line x1={px} x2={px} y1={M.t - 6 - (3 - labelRow[event.key]) * 0} y2={H - M.b} className={'event' + (go ? ' go' : '')} /><text x={px} y={14 + labelRow[event.key] * 11} textAnchor="middle" className={'tick' + (go ? ' go' : '')}>{event.short}</text></g> : null; })}
    <path d={path('kio')} fill="none" stroke={COLORS.kio} strokeWidth="2" />
    <path d={path('huawei')} fill="none" stroke={COLORS.huawei} strokeWidth="2" />
  </svg>;
}

function NodeCard({ node }) {
  const color = { lb: COLORS.lb, web01: COLORS.web01, web02: COLORS.web02 }[node.key] || COLORS.huawei;
  const state = { ok: 'ok', warn: 'warn', down: 'bad', na: 'na' }[node.status];
  const rate = node.kind === 'NGINX' || node.kind === 'IIS' ? `${node.reqPerMin == null ? 'Sin datos' : fmt(node.reqPerMin) + ' req/min'}` : node.txPerSec != null ? `${fmt(node.txPerSec)} tx/s` : '';
  return <article className={'node ' + (node.key === 'lb' ? 'wide' : '')}>
    <div className="node-top"><b>{node.name}</b>{node.key === 'lb' ? (node.backends ? <span className={node.backends.healthy === node.backends.total ? 'ok' : 'bad'}>{node.backends.healthy} de {node.backends.total} backends sanos</span> : <span className="muted">sin datos</span>) : node.role ? <span className="role">{node.role === 'PRIMARY' ? 'PRIMARIA' : node.role === 'SECONDARY' ? 'SECUNDARIA' : node.role}</span> : <i className={'dot ' + state} />}</div>
    <p className="mono sub">{node.ip || 'IP sin configurar'}{node.kind ? ` · ${node.kind}` : ''}{node.port ? ` · ${node.port}` : ''}{node.key === 'lb' ? ' · 443 → 9090–9999, 3000' : ''}</p>
    {node.key === 'sql002' && <p className="mono sub">{node.sync || 'sin estado'} · redo {fmt(node.redoKb)} KB</p>}
    <p className="mono nodeline">CPU {node.cpuPct == null ? 'Sin datos' : node.cpuPct + '%'}{rate ? ` · ${rate}` : ''}{node.connections != null ? ` · ${fmt(node.connections)} conexiones activas` : ''}</p>
    <div className="bar"><span style={{ width: (node.cpuPct || 0) + '%', background: color }} /></div>
  </article>;
}

function Flow({ flow }) {
  const layout = useMemo(() => {
    if (na(flow) || !flow.links.some(l => l.req > 0)) return null;
    const W = 1000, H = 440, nodeIds = ['lb', ...flow.apps.filter(a => a.req > 0).map(a => 'app:' + a.port), ...flow.nodes.map(n => 'node:' + n.name)];
    const nodes = nodeIds.map(id => ({ id })), links = [];
    for (const app of flow.apps.filter(a => a.req > 0)) links.push({ source: 'lb', target: 'app:' + app.port, value: app.req });
    for (const link of flow.links.filter(l => l.req > 0)) links.push({ source: 'app:' + link.port, target: 'node:' + link.node, value: link.req });
    const graph = sankey().nodeId(d => d.id).nodeWidth(14).nodePadding(10).nodeSort(null).extent([[0, 8], [W - 160, H - 34]])({ nodes, links });
    const byId = Object.fromEntries(graph.nodes.map(n => [n.id, n]));
    return { W, H, graph, byId };
  }, [flow]);
  if (!layout) return <Empty value={na(flow) ? flow : { reason: 'Sin peticiones en el último minuto' }} />;
  const { W, H, graph, byId } = layout, path = sankeyLinkHorizontal(), dashed = linkHorizontal().x(d => d[0]).y(d => d[1]);
  const appOf = id => flow.apps.find(a => 'app:' + a.port === id), nodeColor = name => name === 'WEB02' ? COLORS.web02 : COLORS.web01;
  const dead = flow.links.filter(l => l.noResponse);
  return <Scroll><svg viewBox={`0 0 ${W} ${H}`} className="sankey" role="img" aria-label="Flujo de peticiones del balanceador a los nodos web">
    {graph.links.map((link, i) => <path key={i} d={path(link)} fill="none" strokeWidth={Math.max(1, link.width)} stroke={link.source.id === 'lb' ? COLORS.lb : nodeColor(link.target.id.slice(5))} strokeOpacity={link.source.id === 'lb' ? 0.32 : 0.5}><title>{link.source.id === 'lb' ? `${appOf(link.target.id)?.name}: ${fmt(link.value)} req/min` : `${appOf(link.source.id)?.name} → ${link.target.id.slice(5)}: ${fmt(link.value)} req/min`}</title></path>)}
    {dead.map((link, i) => { const a = byId['app:' + link.port], n = byId['node:' + link.node]; if (!a || !n) return null; const d = dashed({ source: [a.x1, (a.y0 + a.y1) / 2], target: [n.x0, n.y1 - 3] }); return <g key={i}><path d={d} fill="none" stroke={COLORS.bad} strokeWidth="1.6" strokeDasharray="6 4" /></g>; })}
    {graph.nodes.map(n => { const isLb = n.id === 'lb', isApp = n.id.startsWith('app:'), name = n.id.slice(n.id.indexOf(':') + 1); const color = isLb ? COLORS.lb : isApp ? COLORS.web01 : nodeColor(name); const app = isApp ? appOf(n.id) : null, node = !isLb && !isApp ? flow.nodes.find(x => x.name === name) : null;
      return <g key={n.id}><rect x={n.x0} y={n.y0} width={n.x1 - n.x0} height={Math.max(2, n.y1 - n.y0)} fill={color} rx="2" />
        {isLb && <text x={n.x1 + 10} y={(n.y0 + n.y1) / 2 - 4} className="slabel"><tspan fontWeight="700">Balanceador</tspan><tspan x={n.x1 + 10} dy="17" className="mono dim">{flow.total ? fmt(flow.total) + ' req/min' : ''}</tspan></text>}
        {isApp && <text x={n.x0 - 8} y={(n.y0 + n.y1) / 2 + 4} textAnchor="end" className="slabel">{app.name.replace(/^Controller-/, '')} :{app.port} · {fmt(app.req)}</text>}
        {node && <text x={n.x1 + 8} y={(n.y0 + n.y1) / 2 + 4} className="slabel"><tspan fontWeight="700">{name}</tspan><tspan x={n.x1 + 8} dy="16" className="mono dim">{fmt(node.req)} · {flow.total ? Math.round(node.req / flow.total * 100) : 0}%</tspan></text>}</g>; })}
    {dead.map((link, i) => <text key={i} x={W - 160} y={H - 8 - i * 16} textAnchor="end" className="slabel bad">{link.app.replace(/^Controller-/, '')} → {link.node} sin respuesta</text>)}
  </svg></Scroll>;
}

function Heatmap({ heatmap }) {
  if (na(heatmap)) return <Empty value={heatmap} />;
  const n = heatmap.minutes.length;
  return <Scroll><div className="heat" style={{ gridTemplateColumns: `170px repeat(${n}, minmax(18px, 1fr))` }}>
    {heatmap.rows.map(row => <React.Fragment key={row.port}><span className="heat-label">{row.name.replace(/^Controller-/, '')} <em className="mono">:{row.port}</em></span>{row.cells.map((cell, i) => {
      const bad = cell.err5xx > 0 || cell.noNodes.length > 0, level = heatmap.max ? cell.req / heatmap.max : 0;
      const background = bad ? `rgba(242,105,107,${0.45 + 0.5 * Math.min(1, level + 0.3)})` : `rgba(43,179,154,${0.1 + 0.9 * level})`;
      const tip = `${row.name} :${row.port} · ${heatmap.minutes[i]} · ${fmt(cell.req)} req/min${cell.err5xx ? ` · ${cell.err5xx} errores 5xx` : ''}${cell.noNodes.length ? ` · sin tráfico a ${cell.noNodes.join(', ')}` : ''}`;
      return <i key={i} className="cell" style={{ background }} title={tip} aria-label={tip} />; })}</React.Fragment>)}
    <span />{heatmap.minutes.map((m, i) => <em key={i} className="mono hx">{i % 7 === 0 || i === n - 1 ? m : ''}</em>)}
  </div><p className="muted note">Más intenso = más peticiones · rojo = errores 5xx o un nodo sin respuesta</p></Scroll>;
}

function Ports({ ports }) {
  return <ul className="ports">{ports.map((p, i) => <li key={i}><b className="mono">{p.port}</b><span title={p.sites ? p.sites.map(s => `${s.name} :${s.port} → ` + Object.entries(s.nodes).map(([k, v]) => `${k} ${v ? (v.ok ? 'ok ' + v.ms + ' ms' : 'sin respuesta') : '—'}`).join(', ')).join('\n') : undefined}>{p.label}</span><Pill state={p.state}>{p.badge}</Pill></li>)}</ul>;
}

const SEGMENTS = [['running', COLORS.huawei], ['suspended', COLORS.warn], ['sleeping', '#3B4A58'], ['zombie', COLORS.bad]];
function Pools({ pools }) {
  if (na(pools)) return <Empty value={pools} />;
  return <div className="pools">{pools.map(pool => <div key={pool.app} className="pool"><span>{pool.app}</span><div className="track" title={`${pool.running} running · ${pool.suspended} suspended · ${pool.sleeping} sleeping · ${pool.zombie} zombie`}>{SEGMENTS.map(([key, color]) => pool[key] ? <i key={key} style={{ width: pool[key] / pool.max * 100 + '%', background: color }} /> : null)}</div><b className={'mono' + (pool.alert ? ' bad' : '')}>{fmt(pool.total)} / {fmt(pool.max)}{pool.alert ? ' ⚠' : ''}</b></div>)}</div>;
}

function Activity({ activity, connections }) {
  if (na(activity)) return <Panel title="Actividad de SQL Server"><Empty value={activity} /></Panel>;
  const { states, pools, cpuQueue, waits, processes, blockChains, zombies, counters, thresholds } = activity;
  const tiles = states && !na(states) ? [['Running', states.running, 'ejecutando ahora', 'ok'], ['Runnable', states.runnable, 'en cola de CPU', 'ok'], ['Suspended', states.suspended, 'esperando un recurso', 'warn'], ['Sleeping', states.sleeping, 'conexión inactiva en pool', 'na'], ['Zombie', states.zombie, 'sleeping con tx abierta', 'bad'], ['Bloqueadas', states.blocked, 'sesiones bloqueadas', 'bad']] : [];
  const maxWait = Math.max(1, ...(waits?.perMinute || []).map(w => w.seconds));
  return <>
    <div className="section-title"><h3>Actividad de SQL Server · {activity.server}</h3><span className="mono muted">sys.dm_exec_sessions · dm_exec_requests · dm_os_schedulers · dm_os_wait_stats</span></div>
    {tiles.length ? <section className="tiles">{tiles.map(([label, value, sub, tone]) => <article key={label} className={'card tile ' + tone}><p>{label}</p><strong>{value}</strong><span>{sub}</span></article>)}</section> : <Empty value={states} />}
    <div className="split">
      <Panel title="Pool de conexiones por aplicación" aside={<span className="legend">{SEGMENTS.map(([k, c]) => <em key={k}><i style={{ background: c }} />{k}</em>)}</span>}><Pools pools={pools} /><p className="muted note">Ancho total = Max Pool Size configurado (CORTE_POOL_MAX) · rojo por encima del 80 %.</p></Panel>
      <div className="stack">
        <Panel title="Cola de CPU por scheduler">{na(cpuQueue) ? <Empty value={cpuQueue} /> : <><p className="muted note">Tareas runnable esperando CPU · alerta con 2 o más sostenido 3 min{cpuQueue.sustained ? ' — ACTIVA' : ''}</p><div className="bars">{cpuQueue.schedulers.map(s => <div key={s.id}><b className="mono">{s.runnable}</b><i style={{ height: 8 + s.runnable * 18, background: cpuQueue.sustained ? COLORS.bad : s.runnable >= 2 ? COLORS.warn : COLORS.huawei }} /><em className="mono">{s.id}</em></div>)}</div></>}</Panel>
        <Panel title="Esperas principales · último minuto">{na(waits) ? <Empty value={waits} /> : <>{waits.perMinute ? waits.perMinute.map((w, i) => <div key={w.wait} className="wait"><span className="mono">{w.wait}</span><div className="track"><i style={{ width: w.seconds / maxWait * 100 + '%', background: i === 0 ? COLORS.bad : i < 3 ? COLORS.warn : COLORS.web02 }} /></div><b className="mono">{w.seconds} s</b></div>) : <p className="muted">Calculando (se necesita una segunda lectura)…</p>}{waits.current.length > 0 && <p className="muted note">Ahora: {waits.current.map(w => `${w.wait} ×${w.sessions}`).join(' · ')}</p>}</>}</Panel>
      </div>
    </div>
    <Panel title="Procesos en ejecución · ordenados por duración" aside={<span className="muted">Ámbar ≥ {thresholds.amberS} s · rojo ≥ {thresholds.redS} s · bloqueos resaltados</span>}>
      {na(processes) ? <Empty value={processes} /> : <Scroll><table><thead><tr>{['SPID', 'Aplicación', 'Origen', 'Estado', 'Espera', 'Duración', 'CPU', 'Lecturas', 'Bloqueado por', 'Consulta'].map(h => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{processes.map(p => <tr key={p.spid} className={p.blockedBy ? 'blocked' : ''}><td className="mono">{p.spid}</td><td>{p.app || '—'}</td><td className="mono">{p.origin || '—'}</td><td><Pill state={p.status === 'bloqueada' ? 'bad' : p.status === 'suspended' ? 'warn' : 'ok'}>{p.status}</Pill></td><td className="mono">{p.wait || '—'}</td><td className={'mono ' + (p.level === 'red' ? 'bad' : p.level === 'amber' ? 'warn' : '')}>{duration(p.durationMs)}</td><td className="mono">{(p.cpuMs / 1000).toFixed(1)} s</td><td className="mono">{compact(p.reads)}</td><td className={'mono ' + (p.blockedBy ? 'bad' : '')}>{p.blockedBy || '—'}</td><td className="mono sql" title={p.sql || ''}>{p.sql || '—'}</td></tr>)}</tbody></table>{!processes.length && <p className="muted">Sin procesos en ejecución.</p>}</Scroll>}
    </Panel>
    <div className="split even">
      <Panel title="Cadena de bloqueo">{na(blockChains) ? <Empty value={blockChains} /> : blockChains.length ? blockChains.map(c => <p key={c.root.spid} className="chain"><b className="mono bad">SPID {c.root.spid}</b> ({c.root.app || 'sin aplicación'}{c.root.origin ? ' · ' + c.root.origin : ''}{c.root.state ? ' · ' + c.root.state : ''}) bloquea a {c.victims.map(v => <b key={v} className="mono"> {v}</b>)} · cadena de {c.length} sesiones</p>) : <p className="muted">Sin bloqueos.</p>}</Panel>
      <Panel title="Contadores de conexión">{na(counters) ? <Empty value={counters} /> : <dl className="counters">{[['User Connections', counters.userConnections], ['Logins/sec', counters.loginsSec], ['Logouts/sec', counters.logoutsSec], ['Connection Reset/sec', counters.resetSec]].map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="mono">{v == null ? 'Sin datos' : fmt(v)}</dd></div>)}</dl>}</Panel>
    </div>
    <Panel title="Sesiones zombie · sleeping con transacción abierta" aside={<span className="bad">Retienen bloqueos y no dejan truncar el log</span>}>
      {na(zombies) ? <Empty value={zombies} /> : <Scroll><table><thead><tr>{['SPID', 'Aplicación', 'Origen', 'Tx abiertas', 'Inactiva hace', 'Login'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{zombies.map(z => <tr key={z.spid}><td className="mono">{z.spid}</td><td>{z.app || '—'}</td><td className="mono">{z.origin || '—'}</td><td className="mono warn">{z.openTransactions}</td><td className="mono warn">{idle(z.idleS)}</td><td className="mono">{z.login || '—'} · {hms(z.loginTime)}</td></tr>)}</tbody></table>{!zombies.length && <p className="muted">Sin sesiones zombie.</p>}</Scroll>}
    </Panel>
    <Panel title="Aplicaciones conectadas a la base">
      {na(connections) ? <Empty value={connections} /> : <Scroll><table><thead><tr>{['Origen', 'Aplicación', 'Destino', 'Sesiones', 'Cifrado', 'Desde'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{connections.map((c, i) => <tr key={i}><td className="mono">{c.source}</td><td>{c.app || '—'}</td><td className="mono">{c.dest}</td><td className="mono">{fmt(c.sessions)}</td><td className={c.encrypt ? 'ok' : 'warn'}>{c.encrypt ? 'TLS' : 'Sin cifrar'}</td><td className="mono">{hms(c.firstLogin)}</td></tr>)}</tbody></table></Scroll>}
    </Panel>
  </>;
}

const envBadge = (name, dbs) => {
  if (na(dbs) || !dbs.length) return { text: `${name} · Sin datos`, tone: 'na', title: '' };
  const states = [...new Set(dbs.map(d => d.standby ? 'STANDBY' : d.state))];
  return { text: `${name} · ${states.join(' / ')}`, tone: states.every(s => s === 'ONLINE') ? 'ok' : states.includes('RESTORING') || states.includes('STANDBY') ? 'warn' : 'bad', title: dbs.map(d => `${d.name}: ${d.standby ? 'STANDBY' : d.state}`).join('\n') };
};

export function CorteView() {
  const { data, error, loading, load } = useCorte();
  const root = useRef(null);
  const [exporting, setExporting] = useState(false), [exportError, setExportError] = useState('');
  const doExport = async () => { setExporting(true); setExportError(''); try { await exportEvidence(root.current, data?.generatedAt); } catch (e) { setExportError(e.message); } finally { setExporting(false); } };
  if (!data) return <div className="corte"><p className="muted">{error ? '' : 'Cargando monitor del corte…'}</p>{error && <p className="alert" role="alert"><TriangleAlert size={16} /> {error} <button onClick={load}>Reintentar</button></p>}</div>;
  const kio = envBadge('KIO', data.dbs.kio), huawei = envBadge('Huawei', data.dbs.huawei);
  return <div className="corte" ref={root}>
    <header className="c-head">
      <img className="c-logo" src={logoWhite} alt="Servicios Compartidos" />
      <div><span className="eyebrow">CENTRO DE MIGRACIÓN · CONTROLLER</span><h2>Monitor del corte KIO → Huawei</h2></div>
      <div className="c-meta">
        <span className={'badge ' + kio.tone} title={kio.title}>{kio.text}</span><span className={'badge ' + huawei.tone} title={huawei.title}>{huawei.text}</span>
        <span className="mono clock">{dayLabel(data.window.now)} {hms(data.window.now)} · cada 60 s</span>
        <span className={'badge ' + (data.mode === 'live' ? 'ok' : 'warn')}>{data.mode === 'live' ? 'En vivo' : 'Demostración'}</span>
        <button data-no-export onClick={load} disabled={loading}><RefreshCw size={14} />{loading ? 'Actualizando…' : 'Actualizar'}</button>
        <button data-no-export onClick={doExport} disabled={exporting}><Download size={14} />{exporting ? 'Exportando…' : 'Exportar evidencia'}</button>
      </div>
    </header>
    {error && <p className="alert" role="alert"><TriangleAlert size={16} /> {error} · Se conservan los últimos datos disponibles.</p>}
    {exportError && <p className="alert" role="alert" data-no-export>{exportError}</p>}
    {data.warnings.map((w, i) => <p className="alert" role="status" key={i}><b>{w.source}</b>: {w.message}</p>)}
    {data.status === 'error' && <p className="alert" role="alert">No hay fuentes disponibles. Revise las conexiones e intente actualizar.</p>}
    <Phases window={data.window} />
    <Kpis kpis={data.kpis} />
    <div className="split">
      <Panel title="Escrituras por segundo · KIO frente a Huawei" aside={<span className="legend"><em><i style={{ background: COLORS.kio }} />KIO</em><em><i style={{ background: COLORS.huawei }} />Huawei</em></span>}>{data.history.length ? <Scroll><WritesChart history={data.history} win={data.window} /></Scroll> : <p className="muted">Sin historial todavía: se guarda una muestra por minuto.</p>}</Panel>
      <Panel title="Nodos"><div className="nodes">{data.nodes.map(n => <NodeCard key={n.key} node={n} />)}</div>{data.alerts.map((a, i) => <p key={i} className="warn note">{a.node} sin respuesta en {a.app} :{a.port} desde {a.since}</p>)}</Panel>
    </div>
    <Panel title="Flujo de peticiones · balanceador → aplicación y puerto → nodo" aside={<span className="legend"><em><i style={{ background: COLORS.web01 }} />WEB01</em><em><i style={{ background: COLORS.web02 }} />WEB02</em><em className="bad"><i className="dash" />sin respuesta</em><em>ancho = req/min</em></span>}><Flow flow={data.flow} /></Panel>
    <div className="split">
      <Panel title="Mapa de calor · peticiones por minuto, últimos 15 min"><Heatmap heatmap={data.heatmap} /></Panel>
      <Panel title="Puertos"><Ports ports={data.ports} /></Panel>
    </div>
    <Activity activity={data.activity} connections={data.connections} />
  </div>;
}
