import React, { useState } from 'react';
const fmt = value => value == null ? 'Sin datos' : new Intl.NumberFormat('es-GT').format(value);
export function Table({ heads, rows }) {
  return <div className="table-wrap"><table><thead><tr>{heads.map(head => <th scope="col" key={head}>{head}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table>{!rows.length && <p>Sin registros disponibles.</p>}</div>;
}
export function Inventory({ tables = [] }) {
  return <section className="panel"><h3>Inventario comparativo</h3><p>Conteos aproximados de las tablas.</p><Table heads={['Tabla', 'KIO', 'Local', 'Huawei', 'Diferencia Local', 'Diferencia Huawei', 'GB KIO', 'GB Huawei']} rows={tables.map(t => [t.schema + '.' + t.table, fmt(t.kioRows), fmt(t.localRows), fmt(t.huaweiRows), fmt(t.difference), fmt(t.huaweiDifference), fmt(t.sizeGb), fmt(t.huaweiSizeGb)])}/></section>;
}
export function ChainDetails({ name, chain }) {
  return <section className="panel"><h3>Cadena de {name}</h3><p>{chain?.error?.message || ({ disabled: 'Servidor no habilitado', unavailable: 'Historial no disponible', empty: 'Sin registros' }[chain?.status]) || (chain?.continuous === true ? 'LSN continuos' : chain?.continuous === false ? 'Discontinuidad de LSN: revisar la secuencia' : 'Continuidad pendiente de verificación')}</p><Table heads={['Archivo', 'First LSN', 'Last LSN', 'MB', 'Estado']} rows={(chain?.entries || []).map(c => [c.file, c.firstLsn, c.lastLsn, fmt(c.sizeMb), c.status])}/></section>;
}
export function LogChains({ chains = {} }) {
  const [selected, setSelected] = useState('local');
  return <><div className="header-actions">{['local', 'huawei'].map(key => <button key={key} aria-pressed={selected === key} onClick={() => setSelected(key)}>{key === 'local' ? 'Local' : 'Huawei'}</button>)}</div><ChainDetails name={selected === 'local' ? 'Local' : 'Huawei'} chain={chains[selected]}/></>;
}

