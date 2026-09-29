# TerraController Migration Dashboard

Dashboard local para comparar KIO, la réplica Local y el futuro ambiente Huawei.

## Inicio rápido

1. Instale Node.js 22.12 o superior (o Node.js 20.19 compatible con Vite).
2. Copie `.env.example` como `.env` y mantenga `DASHBOARD_MODE=demo` para la primera ejecución.
3. Ejecute `npm ci` y luego `npm run dev` para desarrollo. El controlador nativo `msnodesqlv8` debe completar su instalación para usar autenticación Windows; su script está autorizado en `package.json`.
4. Abra `http://localhost:5174`.

## Activar datos reales

Local está desactivada (`LOCAL_ENABLED=false`): no se abren conexiones ni se consultan sus métricas o historiales, y su ausencia no genera alertas. Para reactivarla sería necesario establecer `LOCAL_ENABLED=true` y reiniciar la API. El monitoreo activo utiliza KIO y Huawei.

Local utiliza autenticación integrada de Windows (`LOCAL_SQL_AUTH=windows`). Configure una cuenta SQL de solo lectura para KIO, complete `.env` y cambie `DASHBOARD_MODE=live`. La API escucha únicamente en `http://127.0.0.1:3100`.

Para una ejecución estable, use `npm run build` y después `npm start`; en ese modo todo el dashboard queda disponible en `http://localhost:3100`.

Ejecute `npm test` para comprobar las pruebas y `npm run check` para validar la sintaxis. `/api/health` comprueba el proceso; `/api/dashboard` informa el estado real de las fuentes (`ok`, `partial` o `error`). Una respuesta parcial conserva los resultados disponibles y muestra las advertencias de las fuentes que fallaron.

## Recuperación del proyecto — 29 de septiembre de 2026

Esta copia llegó sin `server/src`, `web/src` ni el logo fuente, y con dependencias incompletas. Se recuperó el código base del ZIP adjunto, se reconstruyeron las funcionalidades cubiertas por las pruebas existentes y se recuperó el logo desde la interfaz compilada. La configuración `.env` existente se conserva.

La comprobación SQL detectó que faltan `C:\SQLData\TerraController\DATA\TerraController.mdf` y `C:\SQLData\TerraController\LOG\TerraController_log.ldf`; el log de SQL Server registra el problema desde el 28 de septiembre. La base local no puede consultarse, aunque su historial de control puede seguir disponible. Huawei resuelve a su dirección de red, pero la conexión SQL configurada agota el tiempo de espera. Estos problemas requieren recuperar la base local y restablecer la conectividad con Huawei; no se realizaron cambios en archivos SQL ni en las bases.

No publique `.env` ni use cuentas `sysadmin`. Huawei se activa con HUAWEI_ENABLED=true y HUAWEI_SQL_SERVER, HUAWEI_SQL_PORT, HUAWEI_SQL_USER y HUAWEI_SQL_PASSWORD en el archivo .env de la ra?z (server/.env no se carga). Reinicie la API al cambiar variables. El dashboard consulta estado, tablas, jobs y ?ltimo punto de negocio de Huawei mediante consultas de solo lectura. Si una consulta falla, conserva los datos disponibles y muestra una advertencia; la vista Cadena de logs permite seleccionar Local o Huawei. Cada cadena consulta DBA_Migracion.dbo.RestauracionLog en su propio servidor y muestra hasta 100 registros. Si falta esa tabla o el permiso de lectura, se informa la indisponibilidad sin reutilizar datos del otro servidor.

## Retraso y fechas

El retraso compara el último `fecha_sync` de KIO con `ultima_fecha_sync` de la validación más reciente en `DBA_Migracion.dbo.ValidacionDatos`; nunca utiliza la hora actual. En KIO se selecciona `TOP (1)` por `fecha_sync DESC, id_factura DESC`. La consulta está respaldada por el índice habilitado `IX_facturas_fecha_sync`, cuyas claves son `fecha_sync, id_factura` e incluye `fecha_facturacion`.

Las fechas de negocio y restauración (`fecha_facturacion`, `fecha_sync`, `ultima_fecha_facturacion`, `ultima_fecha_sync`, `fecha_validacion`, `backup_start_date`, `backup_finish_date` y `restore_date`) son relojes locales de Guatemala almacenados en columnas SQL sin zona. La API las publica como texto `yyyy-MM-dd HH:mm:ss.SSS`, sin sufijo `Z`. `generatedAt` sí representa un instante UTC y conserva su formato ISO con `Z`.
