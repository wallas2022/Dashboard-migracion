// "Exportar evidencia": serializa la pestaña (HTML + SVG con estilos calculados) a un PNG con fecha y hora.
const pad = n => String(n).padStart(2, '0');
export function evidenceFileName(date = new Date()) {
  return `evidencia-corte-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.png`;
}
function inlineStyles(source, target) {
  const computed = getComputedStyle(source);
  let css = '';
  for (const property of computed) css += `${property}:${computed.getPropertyValue(property)};`;
  target.setAttribute('style', css);
  const from = source.children, to = target.children;
  for (let i = 0; i < from.length; i++) if (to[i]) inlineStyles(from[i], to[i]);
}
function imageToDataUrl(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  return canvas.toDataURL('image/png');
}
export async function exportEvidence(node, generatedAt) {
  const width = Math.ceil(node.scrollWidth), height = Math.ceil(node.scrollHeight);
  const clone = node.cloneNode(true);
  inlineStyles(node, clone);
  clone.querySelectorAll('[data-no-export]').forEach(el => el.remove());
  const originals = node.querySelectorAll('img'), copies = clone.querySelectorAll('img');
  originals.forEach((img, i) => { try { copies[i].setAttribute('src', imageToDataUrl(img)); } catch { /* sin logo */ } });
  const now = new Date();
  const stamp = document.createElement('div');
  stamp.setAttribute('style', 'font:12px ui-monospace,Consolas,monospace;color:#9AA7B4;padding:0 0 12px;');
  stamp.textContent = `Evidencia exportada ${now.toLocaleString('es-GT', { timeZone: 'America/Guatemala' })} (hora de Guatemala) · datos generados ${generatedAt ? new Date(generatedAt).toLocaleString('es-GT', { timeZone: 'America/Guatemala' }) : 'sin fecha'}`;
  clone.prepend(stamp);
  clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  clone.style.width = `${width}px`;
  const html = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + 30}"><foreignObject x="0" y="0" width="100%" height="100%">${html}</foreignObject></svg>`;
  const image = new Image();
  await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('No fue posible generar la imagen.')); image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
  const scale = Math.min(2, 16000 / (height + 30));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale); canvas.height = Math.round((height + 30) * scale);
  const context = canvas.getContext('2d');
  context.fillStyle = '#0E151D'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(scale, scale); context.drawImage(image, 0, 0);
  const blob = await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('El navegador bloqueó la exportación.')), 'image/png'));
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = evidenceFileName(now);
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}
