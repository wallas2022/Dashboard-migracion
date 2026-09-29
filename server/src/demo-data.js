import { calculateLag, hasContinuousLsnChain } from './dashboard.js';
export const demoData = {
  generatedAt: new Date().toISOString(),
  mode: 'demo',
  summary: { sourceTime: '2026-09-03 10:00', destinationTime: '2026-09-01 12:59', lagMinutes: 2701, logsPending: 31, transferredMb: 81.04 },
  environments: [
    { key: 'kio', name: 'KIO', role: 'Producción / origen', status: 'online', databaseState: 'ONLINE', lastData: '2026-09-03 10:00', readOnly: false },
    { key: 'local', name: 'Local', role: 'Réplica piloto', status: 'standby', databaseState: 'STANDBY', lastData: '2026-09-01 12:59', readOnly: true },
    { key: 'huawei', name: 'Huawei', role: 'Futuro productivo', status: 'pending', databaseState: 'SIN CONFIGURAR', lastData: null, readOnly: null }
  ],
  chain: [
    { file: '113001.trn', firstLsn: '103824000046817800001', lastLsn: '103825000010982900001', sizeMb: 22.73, status: 'restored' },
    { file: '120000.trn', firstLsn: '103825000010982900001', lastLsn: '103825000025203000001', sizeMb: 19.79, status: 'restored' },
    { file: '123000.trn', firstLsn: '103825000025203000001', lastLsn: '103825000039859600001', sizeMb: 20.30, status: 'restored' },
    { file: '130000.trn', firstLsn: '103825000039859600001', lastLsn: '103826000000791400001', sizeMb: 18.22, status: 'restored' }
  ],
  business: { latestInvoice: 92823674, latestInvoiceDate: '2026-09-01 12:58:51', latestSync: '2026-09-01 12:59:30', validation: 'CORRECTO' },
  tables: [
    { schema: 'cw_core', table: 'facturas', kioRows: 92845120, localRows: 92823674, sizeGb: 184.2, difference: 21446 },
    { schema: 'cw_core', table: 'item_factura', kioRows: 241885410, localRows: 241821003, sizeGb: 326.8, difference: 64407 },
    { schema: 'cw_core', table: 'clientes', kioRows: 624101, localRows: 624088, sizeGb: 8.4, difference: 13 }
  ],
  jobs: [
    { name: 'Backup_Log_TerraController', kio: 'Habilitado', local: 'No requerido', huawei: 'Pendiente' },
    { name: 'Backup_Log_TCT_TCDS_Depurar', kio: 'Deshabilitado', local: 'No requerido', huawei: 'Pendiente' }
  ]
};

demoData.status = 'ok';
demoData.warnings = [];
demoData.business.local = { ...demoData.business };
demoData.business.kio = { latestInvoice: 92845120, latestSync: '2026-09-03 10:00:00.000' };
demoData.business.huawei = { latestInvoice: null, latestSync: null };
Object.assign(demoData.summary, calculateLag(demoData.business.kio.latestSync, demoData.business.local.latestSync));
demoData.summary.huaweiLag = calculateLag(null, null);
demoData.chains = {
  local: { status: 'available', entries: demoData.chain, continuous: hasContinuousLsnChain(demoData.chain), totalMb: demoData.summary.transferredMb },
  huawei: { status: 'disabled', entries: [], continuous: null, totalMb: 0 }
};
