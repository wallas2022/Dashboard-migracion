export async function readApiJson(response) {
  const text = await response.text();
  if (!text.trim()) throw new Error('HTTP ' + response.status + ' sin contenido');
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('contenido no válido (HTTP ' + response.status + ')'); }
  if (!response.ok && !body.environments) throw new Error(body.error || 'HTTP ' + response.status);
  return body;
}
export function formatGuatemalaSqlDate(value) {
  if (value == null) return 'Sin datos';
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{3})?$/.test(value)) return 'Fecha no válida';
  const date = new Date(value.replace(' ', 'T') + 'Z');
  return Number.isNaN(date.getTime()) ? 'Fecha no válida' : date.toLocaleString('es-GT', { timeZone: 'UTC' });
}

