Agrega al **TerraController Migration Dashboard** (esta carpeta) una pestaña nueva llamada **Corte**: un monitor en tiempo real del paso de Controller de KIO a Huawei, que se actualiza cada 60 segundos. El diseño de referencia es el prototipo "Centro de migración · Monitor de tráfico".

## Lo que ya existe (respétalo)
- Monorepo npm con workspaces `server` y `web`. Se arranca con `npm run dev` (API en 127.0.0.1:3100 y Vite en 5174 con proxy `/api`) o con `npm run build` + `npm start` (todo en :3100).
- **server/**: Express en ESM con `mssql` (driver tedious).
  - `src/sql.js` tiene `configFor(prefix)` (lee `<PREFIX>_SQL_*` del `.env` de la raíz), `withPool(config, action)` (abre, consulta y cierra con timeout), `classifySqlError` y `serializeSqlError` (oculta datos sensibles), y los objetos de consultas `queries` / `syncQueries`.
  - `src/index.js` expone `/api/health` y `/api/dashboard`. Usa `Promise.allSettled` por fuente y una promesa `pending` para no lanzar consultas en paralelo si llegan varias peticiones.
  - `src/dashboard.js` arma la respuesta (`ok` / `partial` / `error`, advertencias por fuente).
  - `src/demo-data.js` sirve el modo `DASHBOARD_MODE=demo`.
  - Las pruebas son `node --test`, en `server/test/`.
- **web/**: React + Vite + `lucide-react`.
  - `src/main.jsx` tiene las pestañas (resumen, tablas, jobs, historial, datasync), hace un `fetch` cada 60 s con `AbortController` y usa `src/api.js` (`readApiJson`, `formatGuatemalaSqlDate`).
  - Estilos en `src/styles.css` (tema claro, navy). Logo en `web/images/logoservicioscompartidos.jpg`.
- Convenciones del README:
  - Fechas SQL en hora local de Guatemala, publicadas como `yyyy-MM-dd HH:mm:ss.SSS` sin `Z`; `generatedAt` es UTC con `Z`.
  - Sin cuentas sysadmin y `.env` nunca se publica.
  - El dashboard solo lee: nada de backups, restores ni KILL.

## Antes de escribir código
1. Lee `README.md`, `server/src/*.js`, `web/src/*` y las pruebas. Ejecuta `npm test` para conocer la línea base.
2. Muéstrame un plan corto: archivos nuevos y modificados, variables de entorno nuevas, y el contrato JSON de `/api/corte`. Espera mi visto bueno antes de implementar.

## Cómo integrarlo
- **Backend**:
  - Crea `server/src/corte.js` con sus consultas (mismo estilo que `sql.js`) y un endpoint nuevo `GET /api/corte`, separado de `/api/dashboard` para no hacer más lento lo que ya funciona.
  - Reutiliza `configFor`, `withPool`, `classifySqlError` y `serializeSqlError`, y el patrón `allSettled` + `pending`.
  - Cada fuente es independiente: si una falla, su sección dice "Sin datos" y la respuesta queda `partial`.
- **Fuentes nuevas** (agrégalas a `.env.example` con valores de ejemplo, nunca reales):
  - `HUAWEI2_SQL_*` para la réplica secundaria (SQL002 10.22.0.11, conexión a `master`; las DMV del servidor se leen aunque la base sea secundaria no legible).
  - `CORTE_NGINX_LOG_URL` o `CORTE_NGINX_SSH_*` para leer el log de acceso del balanceador 10.22.0.18.
  - `CORTE_NGINX_STATUS_URL` (stub_status).
  - `CORTE_WEB_NODES=10.22.0.35,10.22.0.34`.
  - `CORTE_SITES` con nombre:puerto de cada sitio.
  - `CORTE_POOL_MAX` por aplicación.
  - `CORTE_EVENTS` con las horas de la ventana.
  - Para probar en QA, `HUAWEI_*` y `HUAWEI2_*` apuntan a SQL63\MSSQLSERVER02 y SQL66.
- **Historial**: la gráfica de escrituras necesita una muestra por minuto desde el viernes 20:00. Guárdala en `.runtime/corte-history.jsonl`, que ya está fuera de git, y conserva 48 h.
- **Demo**: agrega `corte` a `demo-data.js` con datos parecidos a los del prototipo, para que `DASHBOARD_MODE=demo` muestre la pestaña completa.
- **Frontend**:
  - Crea `web/src/corte-view.jsx` y agrega la pestaña `['corte','Corte']` al `nav` de `main.jsx`. Debe tener su propio `fetch` a `/api/corte` cada 60 s, con el mismo manejo de errores y timeout.
  - Usa `d3-sankey` + `d3-shape` para el flujo; el resto (barras, mapa de calor, líneas) va en SVG o CSS sin otra librería.
  - Los estilos van en un bloque con alcance `.corte` dentro de `styles.css`: tema oscuro tipo sala de monitoreo solo en esta pestaña, sin tocar el tema claro del resto.
- **Permisos del login de monitoreo** en cada servidor: `VIEW SERVER STATE` (DMV de sesiones, esperas, schedulers, contadores) y `VIEW ANY DEFINITION`. Documéntalo en el README, sin pedir sysadmin.
- **Reglas SQL**: solo SELECT sobre DMV. Empieza cada lote con `SET LOCK_TIMEOUT 5000; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;` y excluye la sesión del propio dashboard (`@@SPID` y `program_name` del monitor).

## Servidores
- KIO: el `KIO_*` actual (TerraController y TerraControllerDataSync).
- Huawei: SQL001 10.22.0.10 (`HUAWEI_*`, primaria) y SQL002 10.22.0.11 (`HUAWEI2_*`, secundaria), por el Listener cuando exista.
- Balanceador: 10.22.0.18 (NGINX, Huawei). Es el origen del log de acceso del panel 6 y el destino de las pruebas de 443/80. Se muestra como nodo en el panel 5: estado, CPU, req/min, conexiones activas y backends sanos. Las conexiones activas salen de `stub_status`; habilita `location /nginx_status { stub_status; allow <IP del monitor>; deny all; }`.
- Nodos web: WEB01 10.22.0.35, WEB02 10.22.0.34.
- Sitios IIS y puertos: Controller-Portal-Admin 9090, Controller-Portal-Clientes 9091, Controller-Servicio-Soap 9092, Controller-Api 9093, API-V2 9095, RidersApi 9999, Controller-Internal-Services 3000.
- Eventos de la ventana (configurables): 22:00 detener apps, 23:00 TRN puente, 00:30 tail-log, 03:30 RECOVERY, 09:30 Go.

## Paneles (de arriba hacia abajo)
1. **Encabezado**: el mismo logo y la marca del dashboard. Sobre fondo oscuro usa la versión blanca `logo-servicios-compartidos.png`, que está junto a este prompt: cópiala a `web/images/`. Agrega etiquetas de estado por base en KIO y Huawei (`state_desc`, `is_in_standby`) y la hora de la última actualización.
2. **Fases de la ventana**: 7 pasos en una barra; el actual resaltado según la hora.
3. **Indicadores** (6 tarjetas):
   - Escrituras Huawei y KIO (tx/s): `Write Transactions/sec` de `sys.dm_os_performance_counters` (objeto `%:Databases`, instancia = nombre de la base). Es acumulado: diferencia contra la lectura anterior entre los segundos transcurridos.
   - Primera escritura en Huawei: `MAX(last_user_update)` de `sys.dm_db_index_usage_stats` por base. Guarda la primera vez que aparece después de la hora del RECOVERY.
   - Sesiones de aplicación: `sys.dm_exec_sessions` con `is_user_process = 1`, por `host_name`.
   - Peticiones por minuto y p95: del log de NGINX (panel 6).
   - Errores 5xx: porcentaje y aplicación con más errores, del log de NGINX.
   - Alta disponibilidad: `sys.dm_hadr_database_replica_states` (`synchronization_state_desc`, `synchronization_health_desc`, `log_send_queue_size`, `redo_queue_size`).
4. **Escrituras por segundo KIO frente a Huawei**: líneas con el historial guardado. Las líneas verticales marcan los eventos; la del Go va resaltada.
5. **Nodos**: Balanceador, WEB01, WEB02, SQL001 y SQL002, con estado, CPU y req/min o tx/s.
   - CPU de SQL: `sys.dm_os_ring_buffers` (`RING_BUFFER_SCHEDULER_MONITOR`).
   - CPU de WEB y del balanceador: si no hay acceso, "Sin datos", y explica en el README cómo habilitarlo.
6. **Flujo de peticiones (Sankey)**: balanceador → aplicación y puerto → nodo; el ancho es proporcional a req/min. Si una aplicación no tiene tráfico hacia un nodo en el último minuto, va una línea roja discontinua con la leyenda "sin respuesta".
   - Fuente: log de NGINX con `log_format corte '$time_iso8601 $upstream_addr $status $upstream_response_time "$host" "$request_uri"';`.
   - `$upstream_addr` es `IP:puerto`; el puerto identifica la aplicación.
   - Agrega por minuto: puerto, nodo, peticiones, 5xx y p95.
7. **Mapa de calor**: una fila por aplicación y una columna por minuto (últimos 15). La intensidad es req/min; el rojo marca 5xx o un nodo sin tráfico. Tooltip con el valor exacto.
8. **Puertos**: 443, 80→301, 9090–9095, 9999, 3000, 1433 al Listener, 5022, 3343 y 445 al testigo.
   - 1433: `sys.dm_exec_connections` (`local_net_address`, `local_tcp_port`, `encrypt_option`).
   - 5022: `sys.tcp_endpoints` y `connected_state_desc` de `sys.dm_hadr_availability_replica_states`.
   - 3343 y testigo: `sys.dm_hadr_cluster_members`.
   - 443, 80 y sitios: prueba HTTP desde el backend (código y tiempo).
9. **Aplicaciones conectadas**: origen (`client_net_address`), aplicación (`program_name`), destino (`local_net_address:local_tcp_port`), sesiones, cifrado (`encrypt_option`) y `MIN(login_time)`.
10. **Actividad de SQL Server** (SQL001; en QA, SQL63):
    - **Estados**:
      - Running, Runnable y Suspended: `sys.dm_exec_requests.status`.
      - Sleeping: `sys.dm_exec_sessions.status = 'sleeping'` sin request activo.
      - Zombie: sleeping con `open_transaction_count > 0` y `last_request_end_time` de hace más de 60 s.
      - Bloqueadas: `blocking_session_id <> 0`.
    - **Pool por aplicación**: por `program_name`, sesiones running, suspended, sleeping y zombie contra el Max Pool Size configurado (Controller-Site 500, el resto 100, editable). Alerta en rojo por encima del 80 %.
    - **Cola de CPU**: `runnable_tasks_count` por scheduler (`sys.dm_os_schedulers`, `status = 'VISIBLE ONLINE'`). Alerta con 2 o más sostenido durante 3 minutos.
    - **Esperas principales**: diferencia por minuto de `sys.dm_os_wait_stats` (top 5, sin esperas benignas: SLEEP_%, BROKER_%, XE_%, HADR_FILESTREAM_IOMGR_IOCOMPLETION, etc.), más las esperas actuales de `sys.dm_exec_requests.wait_type`.
    - **Procesos en ejecución**: `sys.dm_exec_requests` + `sys.dm_exec_sessions` + `CROSS APPLY sys.dm_exec_sql_text(sql_handle)`.
      - Columnas: SPID, aplicación, origen, estado, espera, duración (ahora − `start_time`), `cpu_time`, `logical_reads`, `blocking_session_id` y los primeros 200 caracteres de la consulta.
      - Orden por duración. Ámbar desde 10 s y rojo desde 30 s (configurable). Fila resaltada si está bloqueada.
    - **Cadena de bloqueo**: muestra el bloqueador raíz.
    - **Sesiones zombie**: SPID, aplicación, origen, `open_transaction_count`, tiempo inactiva y login. Sin botón de matar sesiones.
    - **Contadores de conexión**: `User Connections`, `Logins/sec`, `Logouts/sec` y `Connection Reset/sec` (objeto `General Statistics`).

## Diseño (solo dentro de `.corte`)
- Logo blanco en el encabezado, 48 px de alto, a la izquierda.
- Colores: fondo #0E151D, tarjetas #141D27, bordes #22303D, texto #E6EDF3, texto secundario #9AA7B4.
- Acentos: Huawei/WEB01 #2BB39A, WEB02 #8B8CF8, balanceador #6C63D9, KIO/advertencia #F2B84B, error #F2696B.
- Tipografía: Inter, con JetBrains Mono para IPs, horas y puertos; números tabulares.
- La pestaña funciona a ancho de teléfono: tarjetas en una columna; el Sankey y las tablas con scroll horizontal.

## Entregables y criterios de aceptación
- Pruebas nuevas en `server/test/corte.test.js` con `node --test`:
  - Cálculo de tx/s por diferencia de contadores.
  - Agregado del log de NGINX por puerto y nodo.
  - Clasificación de zombies y bloqueos.
  - Respuesta `partial` cuando falla una fuente.
  - `npm test` y `npm run check` en verde.
- `DASHBOARD_MODE=demo` muestra la pestaña completa; `live` funciona contra QA (SQL63/SQL66, AG_Controller y AG_DataSync).
- Agrega al README una sección "Pestaña Corte — noviembre 2026": variables, permisos `VIEW SERVER STATE` y `VIEW ANY DEFINITION`, `log_format` y `stub_status` de NGINX, y cómo probarla.
- Botón "Exportar evidencia" que descarga un PNG del estado actual con fecha y hora.
- No toques `.env` ni las pestañas existentes salvo el `nav`. Al terminar, dime cómo probarlo y qué panel quedó sin datos y por qué.
