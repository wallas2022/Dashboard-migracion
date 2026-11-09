import React, { useState } from 'react';
const fmt = value => value == null ? 'Sin datos' : new Intl.NumberFormat('es-GT').format(value);
export function Table({ heads, rows }) {
  return <div className="table-wrap"><table><thead><tr>{heads.map(head => <th scope="col" key={head}>{head}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table>{!rows.length && <p>Sin registros disponibles.</p>}</div>;
}
export function Inventory({ tables = [] }) {
  return <section className="panel"><h3>Inventario comparativo</h3><p>Conteos aproximados de las tablas.</p><Table heads={['Tabla', 'KIO', 'Huawei', 'Diferencia Huawei', 'GB KIO', 'GB Huawei']} rows={tables.map(t => [t.schema + '.' + t.table, fmt(t.kioRows), fmt(t.huaweiRows), fmt(t.huaweiDifference), fmt(t.sizeGb), fmt(t.huaweiSizeGb)])}/></section>;
}
export function ChainDetails({ name, chain }) {
  return <section className="panel"><h3>Cadena de {name}</h3><p>{chain?.error?.message || ({ disabled: 'Servidor no habilitado', unavailable: 'Historial no disponible', empty: 'Sin registros' }[chain?.status]) || (chain?.continuous === true ? 'LSN continuos' : chain?.continuous === false ? 'Discontinuidad de LSN: revisar la secuencia' : 'Continuidad pendiente de verificación')}</p><Table heads={['Archivo', 'First LSN', 'Last LSN', 'MB', 'Estado']} rows={(chain?.entries || []).map(c => [c.file, c.firstLsn, c.lastLsn, fmt(c.sizeMb), c.status])}/></section>;
}
const CHAIN_BASES = [['terracontroller', 'TerraController'], ['datasync', 'TerraControllerDataSync']];
export function LogChains({ chains = {}, syncChain }) {
  const [selected, setSelected] = useState('terracontroller');
  const isSync = selected === 'datasync';
  const chain = isSync ? (syncChain?.status === 'notcreated' ? { ...syncChain, error: { message: 'TerraControllerDataSync aún no existe en Huawei: falta restaurar el full.' } } : syncChain) : chains.huawei;
  const label = CHAIN_BASES.find(([key]) => key === selected)[1];
  return <><div className="header-actions" role="group" aria-label="Base de datos">{CHAIN_BASES.map(([key, name]) => <button key={key} aria-pressed={selected === key} onClick={() => setSelected(key)}>{name}</button>)}</div><ChainDetails name={'Huawei · ' + label} chain={chain}/></>;
}

const STATUS_LABEL = { disabled: 'Desactivada', notcreated: 'No creada', online: 'online', standby: 'standby', offline: 'offline' };
export function DataSyncView({ sync }) {
  if (!sync) return <section className="panel"><p>Sin datos de TerraControllerDataSync.</p></section>;
  return <>
    <section className="env-grid">{sync.environments.map(e => <article className={'env ' + e.status} key={e.key}><div className="env-top"><span className="status">{STATUS_LABEL[e.status] || e.status}</span></div><h2>{e.name}</h2><p>{sync.database}</p><dl><div><dt>Base</dt><dd>{e.databaseState}</dd></div><div><dt>Modo</dt><dd>{e.readOnly === true ? 'Solo lectura' : e.readOnly === false ? 'Lectura/escritura' : 'No aplica'}</dd></div></dl></article>)}</section>
    <section className="panel"><h3>Retraso Huawei respecto a KIO</h3><p><strong>{sync.huaweiLag?.lagLabel || 'Pendiente'}</strong></p><p>KIO (último evento DataSync.Logs): {sync.business.kio?.latestSync || 'Sin datos'}</p><p>Huawei: {sync.business.huawei?.latestSync || 'Sin datos'}</p></section>
    <section className="panel"><h3>Inventario DataSync</h3><Table heads={['Tabla', 'KIO', 'Huawei', 'Diferencia Huawei', 'GB KIO', 'GB Huawei']} rows={sync.tables.map(t => [t.schema + '.' + t.table, fmt(t.kioRows), fmt(t.huaweiRows), fmt(t.huaweiDifference), fmt(t.sizeGb), fmt(t.huaweiSizeGb)])}/></section>
    <section className="panel"><h3>Jobs DataSync</h3><Table heads={['Job', 'KIO', 'Huawei']} rows={sync.jobs.map(j => [j.name, j.kio, j.huawei])}/></section>
  </>;
}
