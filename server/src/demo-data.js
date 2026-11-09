import { calculateLag, hasContinuousLsnChain } from './dashboard.js';
export const demoData = {
  generatedAt: new Date().toISOString(),
  mode: 'demo',
  summary: { sourceTime: '2026-09-03 10:00', destinationTime: '2026-09-01 12:59', lagMinutes: 2701, logsPending: 31, transferredMb: 81.04 },
  environments: [
    { key: 'kio', name: 'KIO', role: 'Producción / origen', status: 'online', databaseState: 'ONLINE', lastData: '2026-09-03 10:00', readOnly: false },
    { key: 'huawei', name: 'Huawei', role: 'Réplica', status: 'standby', databaseState: 'STANDBY', lastData: '2026-09-01 12:59', readOnly: true }
  ],
  chain: [
    { file: '113001.trn', firstLsn: '103824000046817800001', lastLsn: '103825000010982900001', sizeMb: 22.73, status: 'restored' },
    { file: '120000.trn', firstLsn: '103825000010982900001', lastLsn: '103825000025203000001', sizeMb: 19.79, status: 'restored' },
    { file: '123000.trn', firstLsn: '103825000025203000001', lastLsn: '103825000039859600001', sizeMb: 20.30, status: 'restored' },
    { file: '130000.trn', firstLsn: '103825000039859600001', lastLsn: '103826000000791400001', sizeMb: 18.22, status: 'restored' }
  ],
  business: {},
  tables: [
    { schema: 'cw_core', table: 'facturas', kioRows: 92845120, sizeGb: 184.2 },
    { schema: 'cw_core', table: 'item_factura', kioRows: 241885410, sizeGb: 326.8 },
    { schema: 'cw_core', table: 'clientes', kioRows: 624101, sizeGb: 8.4 }
  ],
  jobs: [
    { name: 'Backup_Log_TerraController', kio: 'Habilitado', huawei: 'Pendiente' },
    { name: 'Backup_Log_TCT_TCDS_Depurar', kio: 'Deshabilitado', huawei: 'Pendiente' }
  ]
};

demoData.status = 'ok';
demoData.warnings = [];
demoData.business.kio = { latestInvoice: 92845120, latestSync: '2026-09-03 10:00:00.000' };
demoData.business.huawei = { latestInvoice: 92823674, latestSync: '2026-09-01 12:59:30.000' };
demoData.summary.huaweiLag = calculateLag(demoData.business.kio.latestSync, demoData.business.huawei.latestSync);
demoData.chains = {
  huawei: { status: 'available', entries: demoData.chain, continuous: hasContinuousLsnChain(demoData.chain), totalMb: demoData.summary.transferredMb }
};
