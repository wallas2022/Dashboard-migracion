import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('rendered inventory aligns all six headings including Huawei with row cells', async () => {
  const vite = await createServer({ root: fileURLToPath(new URL('../../web', import.meta.url)), configFile: false, server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { Inventory, LogChains, ChainDetails } = await vite.ssrLoadModule('/src/server-views.jsx');
    const html=renderToStaticMarkup(React.createElement(Inventory,{tables:[{schema:'dbo',table:'test',kioRows:20,huaweiRows:18,huaweiDifference:2,sizeGb:3,huaweiSizeGb:2}]}));
    assert.equal((html.match(/<th scope=/g)||[]).length,6);
    assert.equal((html.match(/<td>/g)||[]).length,6);
    assert.match(html,/>Huawei<\/th>/);
    assert.match(html,/>18<\/td>/);
    const tabs=renderToStaticMarkup(React.createElement(LogChains,{}));
    assert.match(tabs,/aria-pressed="true">TerraController</);
    assert.match(tabs,/aria-pressed="false">TerraControllerDataSync</);
    assert.match(tabs,/Cadena de Huawei · TerraController/);
    assert.doesNotMatch(tabs,/Local/);
    const detail=renderToStaticMarkup(React.createElement(ChainDetails,{name:'Huawei',chain:{status:'unavailable',entries:[],continuous:null,error:{message:'Permiso denegado'}}}));
    assert.match(detail,/Cadena de Huawei/);
    assert.match(detail,/Permiso denegado/);
    assert.doesNotMatch(detail,/LSN continuos/);
  } finally { await vite.close(); }
});
