import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import { formatGuatemalaSqlDate, readApiJson } from '../../web/src/api.js';

test('frontend ends loading and renders warnings from partial responses', async () => {
  const source = await readFile(new URL('../../web/src/main.jsx', import.meta.url), 'utf8');
  assert.match(source, /\.then\(setData\)/);
  assert.match(source, /AbortController/);
  assert.match(source, /setLoading\(false\)/);
  assert.match(source, /data\.warnings\?\.map/);
});

test('API parser handles an empty response without JSON.parse errors', async () => {
  await assert.rejects(readApiJson(new Response('', { status: 502 })), /HTTP 502 sin contenido/);
});

test('API parser identifies non-JSON proxy responses', async () => {
  await assert.rejects(readApiJson(new Response('<html>Bad Gateway</html>', { status: 502 })), /contenido no válido \(HTTP 502\)/);
});

test('API parser accepts valid JSON', async () => {
  assert.deepEqual(await readApiJson(new Response('{"status":"partial"}', { status: 200 })), { status: 'partial' });
});

test('frontend preserves a Guatemala SQL wall clock without subtracting six hours', () => {
  const formatted = formatGuatemalaSqlDate('2026-09-01 13:59:35.000');
  assert.match(formatted, /1\/9\/2026/);
  assert.match(formatted, /1:59:35\s*p\.\s*m\./i);
  assert.doesNotMatch(formatted, /7:59:35/);
  assert.equal(formatGuatemalaSqlDate(null), 'Sin datos');
  assert.equal(formatGuatemalaSqlDate('2026-09-01T13:59:35.000Z'), 'Fecha no válida');
});

test('frontend renders lag label and both compared synchronization points', async () => {
  const source = await readFile(new URL('../../web/src/main.jsx', import.meta.url), 'utf8');
  assert.match(source, /s\.lagLabel/);
  assert.match(source, /data\.business\.kio\?\.latestSync/);
  assert.match(source, /data\.business\.local\?\.latestSync/);
});

test('frontend references the real Servicios Compartidos logo with accessible alt text', async () => {
  const source = await readFile(new URL('../../web/src/main.jsx', import.meta.url), 'utf8');
  await access(new URL('../../web/images/logoservicioscompartidos.jpg', import.meta.url));
  assert.match(source, /\.\.\/images\/logoservicioscompartidos\.jpg/);
  assert.match(source, /alt="Servicios Compartidos"/);
  assert.match(source, /className="brand-logo"/);
});

test('dashboard keeps refresh control, tabs and loading/partial/error states', async () => {
  const source = await readFile(new URL('../../web/src/main.jsx', import.meta.url), 'utf8');
  for (const label of ['Actualizar', 'Resumen', 'Tablas', 'Jobs', 'Cadena de logs']) assert.match(source, new RegExp(label));
  assert.match(source, /Cargando métricas/);
  assert.match(source, /data\.warnings\?\.map/);
  assert.match(source, /className="center error"/);
  assert.match(source, /disabled=\{loading\}/);
});

test('light corporate theme preserves semantic colors and responsive accessibility', async () => {
  const css = await readFile(new URL('../../web/src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /--background:\s*#ffffff/);
  assert.match(css, /--navy:\s*#0b2545/);
  assert.match(css, /object-fit:\s*contain/);
  assert.match(css, /button:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /overflow-x:\s*auto/);
  assert.match(css, /--success:\s*#047857/);
  assert.match(css, /--danger:\s*#b91c1c/);
  assert.doesNotMatch(css, /#07101d|#101c2b|linear-gradient\(145deg/);
});
