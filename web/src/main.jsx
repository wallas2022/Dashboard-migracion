import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RefreshCw, Server, TriangleAlert } from 'lucide-react';
import { readApiJson, formatGuatemalaSqlDate } from './api.js';
import { Inventory, LogChains, Table } from './server-views.jsx';
import logo from '../images/logoservicioscompartidos.jpg';
import './styles.css';
const fmt = value => value == null ? 'Sin datos' : new Intl.NumberFormat('es-GT').format(value);
function App() {
  const [data,setData]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[tab,setTab]=useState('resumen');
  const request = useRef(null);
  const load = () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 25000);
    setLoading(true); setError('');
    fetch('/api/dashboard', { signal: controller.signal }).then(readApiJson).then(setData)
      .catch(e => { if (request.current === controller) setError(e.name === 'AbortError' ? 'La consulta excedió el tiempo de espera. Intente actualizar.' : e.message); })
      .finally(() => { clearTimeout(timeout); if (request.current === controller) setLoading(false); });
  };
  useEffect(() => { load(); const id=setInterval(load,60000); return () => { clearInterval(id); request.current?.abort(); request.current=null; }; },[]);
  if(loading&&!data)return <div className="center">Cargando métricas…</div>;
  if(error&&!data)return <div className="center error"><TriangleAlert/>{error}<button onClick={load}>Reintentar</button></div>;
  const s=data.summary||{};
  const localDisabled=data.chains?.local?.status==='disabled';
  return <main>
    <header><div className="brand"><img className="brand-logo" src={logo} alt="Servicios Compartidos"/><div><span className="eyebrow">TERRACONTROLLER</span><h1>Centro de migración</h1></div></div><div className="header-actions"><span className={'mode '+data.mode}>{data.mode==='live'?'Datos en vivo':'Demostración'}</span><button onClick={load} disabled={loading}><RefreshCw size={16}/>{loading?'Actualizando…':'Actualizar'}</button></div></header>
    <nav>{[['resumen','Resumen'],['tablas','Tablas'],['jobs','Jobs'],['historial','Cadena de logs']].map(([key,label])=><button key={key} className={tab===key?'active':''} aria-pressed={tab===key} onClick={()=>setTab(key)}>{label}</button>)}</nav>
    {error&&<p className="warning" role="alert">{error} · Se conservan los últimos datos disponibles.</p>}
    {data.warnings?.map((w,i)=><p className="warning" role="status" key={i}><strong>{w.source}</strong>: {w.message}</p>)}
    {data.status==='error'&&<p className="warning" role="alert">No hay fuentes SQL disponibles. Revise las conexiones e intente actualizar.</p>}
    {tab==='resumen'&&<>
      <section className="env-grid">{data.environments.map(e=><article className={'env '+e.status} key={e.key}><div className="env-top"><Server/><span className="status">{e.status==='disabled'?'Desactivada':e.status}</span></div><h2>{e.name}</h2><p>{e.role}</p><dl><div><dt>Base</dt><dd>{e.databaseState}</dd></div><div><dt>Modo</dt><dd>{e.status==='disabled'?'No aplica':e.readOnly===true?'Solo lectura':e.readOnly===false?'Lectura/escritura':'Pendiente'}</dd></div></dl></article>)}</section>
      <section className="metric-grid"><Metric label="Retraso Local respecto a KIO" value={localDisabled?'Desactivada':s.lagLabel || 'Pendiente'}/><Metric label="Retraso Huawei respecto a KIO" value={s.huaweiLag?.lagLabel || 'Pendiente'}/><Metric label="Última factura local" value={localDisabled?'Desactivada':fmt(data.business.latestInvoice)}/><Metric label="Logs locales registrados" value={localDisabled?'Desactivada':data.chains?.local?.status==='unavailable'?'Sin datos':fmt(data.chain?.length)}/></section>
      <section className="panel"><h3>Puntos de sincronización comparados</h3><p>KIO: <strong>{formatGuatemalaSqlDate(data.business.kio?.latestSync)}</strong></p><p>Local: <strong>{localDisabled?'Desactivada':formatGuatemalaSqlDate(data.business.local?.latestSync)}</strong></p><p>Huawei: <strong>{formatGuatemalaSqlDate(data.business.huawei?.latestSync)}</strong></p><p>Validación local: {localDisabled?'No aplica':data.business.validation}</p></section>
    </>}
    {tab==='tablas'&&<Inventory tables={data.tables}/>}
    {tab==='jobs'&&<section className="panel"><h3>Inventario de jobs</h3><Table heads={['Job','KIO','Local','Huawei']} rows={data.jobs.map(j=>[j.name,j.kio,j.local,j.huawei])}/></section>}
    {tab==='historial'&&<LogChains chains={data.chains}/>}
    <footer>Actualizado {new Date(data.generatedAt).toLocaleString('es-GT',{timeZone:'America/Guatemala'})} · refresco automático cada 60 segundos</footer>
  </main>;
}
function Metric({label,value}) { return <article className="metric"><p>{label}</p><strong>{value}</strong></article>; }
createRoot(document.getElementById('root')).render(<App/>);

