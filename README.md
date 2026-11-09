# TerraController Migration Dashboard

Dashboard local para comparar KIO (origen) con la réplica Huawei, para las bases TerraController y TerraControllerDataSync.

## Inicio rápido

1. Instale Node.js 22.12 o superior (o Node.js 20.19 compatible con Vite).
2. Copie `.env.example` como `.env` y mantenga `DASHBOARD_MODE=demo` para la primera ejecución.
3. Ejecute `npm ci` y luego `npm run dev` para desarrollo. El controlador nativo `msnodesqlv8` debe completar su instalación para usar autenticación Windows; su script está autorizado en `package.json`.
4. Abra `http://localhost:5174`.

## Activar datos reales

El ambiente Local fue retirado (9 de noviembre de 2026): ya no hay conexión, consultas, columnas ni variables `LOCAL_*` en el código. El monitoreo utiliza KIO y Huawei.

Configure una cuenta SQL de solo lectura para KIO, complete `.env` y cambie `DASHBOARD_MODE=live`. La API escucha únicamente en `http://127.0.0.1:3100`.

Para una ejecución estable, use `npm run build` y después `npm start`; en ese modo todo el dashboard queda disponible en `http://localhost:3100`.

Ejecute `npm test` para comprobar las pruebas y `npm run check` para validar la sintaxis. `/api/health` comprueba el proceso; `/api/dashboard` informa el estado real de las fuentes (`ok`, `partial` o `error`). Una respuesta parcial conserva los resultados disponibles y muestra las advertencias de las fuentes que fallaron.

## Recuperación del proyecto — 29 de septiembre de 2026

Esta copia llegó sin `server/src`, `web/src` ni el logo fuente, y con dependencias incompletas. Se recuperó el código base del ZIP adjunto, se reconstruyeron las funcionalidades cubiertas por las pruebas existentes y se recuperó el logo desde la interfaz compilada. La configuración `.env` existente se conserva.

La comprobación SQL detectó que faltan `C:\SQLData\TerraController\DATA\TerraController.mdf` y `C:\SQLData\TerraController\LOG\TerraController_log.ldf`; el log de SQL Server registra el problema desde el 28 de septiembre. La base local no puede consultarse, aunque su historial de control puede seguir disponible. Huawei resuelve a su dirección de red, pero la conexión SQL configurada agota el tiempo de espera. Estos problemas requieren recuperar la base local y restablecer la conectividad con Huawei; no se realizaron cambios en archivos SQL ni en las bases.

No publique `.env` ni use cuentas `sysadmin`. Huawei se activa con HUAWEI_ENABLED=true y HUAWEI_SQL_SERVER, HUAWEI_SQL_PORT, HUAWEI_SQL_USER y HUAWEI_SQL_PASSWORD en el archivo .env de la ra?z (server/.env no se carga). Reinicie la API al cambiar variables. El dashboard consulta estado, tablas, jobs y ?ltimo punto de negocio de Huawei mediante consultas de solo lectura. Si una consulta falla, conserva los datos disponibles y muestra una advertencia; la vista Cadena de logs permite seleccionar Local o Huawei. Cada cadena consulta DBA_Migracion.dbo.RestauracionLog en su propio servidor y muestra hasta 100 registros. Si falta esa tabla o el permiso de lectura, se informa la indisponibilidad sin reutilizar datos del otro servidor.

## Retraso y fechas

El retraso compara el último `fecha_sync` de KIO con `ultima_fecha_sync` de la validación más reciente en `DBA_Migracion.dbo.ValidacionDatos`; nunca utiliza la hora actual. En KIO se selecciona `TOP (1)` por `fecha_sync DESC, id_factura DESC`. La consulta está respaldada por el índice habilitado `IX_facturas_fecha_sync`, cuyas claves son `fecha_sync, id_factura` e incluye `fecha_facturacion`.

Las fechas de negocio y restauración (`fecha_facturacion`, `fecha_sync`, `ultima_fecha_facturacion`, `ultima_fecha_sync`, `fecha_validacion`, `backup_start_date`, `backup_finish_date` y `restore_date`) son relojes locales de Guatemala almacenados en columnas SQL sin zona. La API las publica como texto `yyyy-MM-dd HH:mm:ss.SSS`, sin sufijo `Z`. `generatedAt` sí representa un instante UTC y conserva su formato ISO con `Z`.

## Verificación actual — 8 de octubre de 2026

Se revisó la copia de C:\Users\walte\Nextcloud\documentación\Proyectos\TerraController\TerraController_Migration_Dashboard. Git no tenía cambios pendientes al iniciar la revisión. Se conservó el .env existente y no se modificaron bases ni archivos SQL.

- Local sigue desactivada (LOCAL_ENABLED=false). Los archivos C:\SQLData\TerraController\DATA\TerraController.mdf y C:\SQLData\TerraController\LOG\TerraController_log.ldf no existen. La base figura RECOVERY_PENDING; la prueba de lectura devolvió error SQL 945. Las rutas registradas en sys.master_files no prueban que los archivos estén disponibles. Antes de reactivarla se necesita recuperar la base con autorización y validar su lectura.
- Huawei está habilitado y su conexión funciona: DNS resolvió y TCP 1433 respondió. TerraController en GTM-HC-SQL001 estaba ONLINE, en STANDBY y solo lectura. Funcionaron las consultas de estado, tablas (472), jobs (1), historial de restauraciones (100 registros) y último punto de negocio. El timeout documentado en septiembre es un antecedente, no el resultado actual.
- El último TRN observado fue TerraController_LogBackup_20261007_140000.trn, restaurado con estado EXITOSO el 8 de octubre a las 16:40:11.927, hora local de Guatemala. El último fecha_sync observado fue 2026-10-07 13:59:35.000. Son resultados de esta revisión y pueden cambiar mientras los jobs continúan.

No se requirieron cambios de código para este diagnóstico. La retirada de Local de la interfaz y la integración de TerraControllerDataSync solicitadas previamente siguen siendo tareas de desarrollo separadas: esta revisión no las implementa.

## TerraControllerDataSync — 9 de noviembre de 2026

El dashboard monitorea también `TerraControllerDataSync` en KIO y Huawei (pestaña **DataSync**): estado, inventario de tablas, jobs (p. ej. `Backup_Log_TerraControllerDataSync`), retraso y cadena full + logs. El punto de referencia es el último `FechaEvento` de `DataSync.Logs` (índice `IX_Logs_FechaEvento`). Requiere que `db_dashboard` tenga lectura en esa base. Si la base no existe en Huawei se muestra "No creada" sin generar alertas. Las cadenas de `RestauracionLog` se separan por `base_datos`; las filas con `base_datos` nulo se siguen atribuyendo a `TerraController`. Tomar backups o restaurar sigue siendo tarea del DBA: el dashboard solo lee.

## Retiro de Local — 9 de noviembre de 2026

Se eliminó la réplica Local del código, la interfaz, las pruebas y los datos demo. La API ya no publica `data.local`, `chains.local` ni `business.local`; el retraso se mide solo entre KIO y Huawei (`summary.huaweiLag`). Las variables `LOCAL_*` del `.env` quedan sin uso y pueden borrarse. La dependencia `msnodesqlv8` (autenticación Windows) ya no se necesita y puede retirarse de `package.json` cuando se desee.
