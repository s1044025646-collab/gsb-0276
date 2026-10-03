import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Storage } from '../dist/storage.js';
import { createApp } from '../dist/server.js';

const dataDir = mkdtempSync(join(tmpdir(), 'mandel-api-'));
const storage = new Storage(join(dataDir, 'mandelbrot.db'));
const server = createApp(storage);

test.before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

test.after(() => {
  server.close();
  storage.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const port = () => server.address().port;
const base = () => `http://127.0.0.1:${port()}`;

async function post(path, body) {
  return fetch(base() + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('健康检查', async () => {
  const res = await fetch(base() + '/health');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('创建配置 -> 201，重复创建幂等返回同一 ID', async () => {
  const params = { reMin: -2.5, reMax: 1, imMin: -1.25, imMax: 1.25, width: 30, height: 20, maxIterations: 80 };
  const r1 = await post('/configs', params);
  assert.equal(r1.status, 201);
  const j1 = await r1.json();
  const r2 = await post('/configs', params);
  const j2 = await r2.json();
  assert.equal(j1.summary.id, j2.summary.id);
  assert.ok(j1.coordinateMapping.re.includes('(col + 0.5)'));
});

test('非法范围返回 400 与错误码 INVALID_RANGE', async () => {
  const res = await post('/configs', { reMin: 2, reMax: -2, imMin: -1, imMax: 1, width: 10, height: 10, maxIterations: 10 });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'INVALID_RANGE');
});

test('超预算返回 400 与错误码 BUDGET_EXCEEDED，且不产生记录', async () => {
  const before = storage.list().length;
  const res = await post('/configs', { reMin: -2, reMax: 2, imMin: -2, imMax: 2, width: 4000, height: 4000, maxIterations: 100000 });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'BUDGET_EXCEEDED');
  assert.equal(storage.list().length, before);
});

test('查询格点、全量矩阵、历史', async () => {
  const params = { reMin: -2, reMax: 2, imMin: -2, imMax: 2, width: 8, height: 8, maxIterations: 40 };
  const created = await (await post('/configs', params)).json();
  const id = created.summary.id;
  const cellRes = await fetch(`${base()}/configs/${id}/cell?col=0&row=0`);
  assert.equal(cellRes.status, 200);
  const cell = (await cellRes.json()).cell;
  assert.equal(cell.col, 0);
  const cellsRes = await fetch(`${base()}/configs/${id}/cells`);
  assert.equal((await cellsRes.json()).cells.length, 64);
  const list = await (await fetch(`${base()}/configs`)).json();
  assert.ok(list.configs.length >= 2);
});

test('格点越界返回 400', async () => {
  const params = { reMin: -2, reMax: 2, imMin: -2, imMax: 2, width: 4, height: 4, maxIterations: 10 };
  const id = (await (await post('/configs', params)).json()).summary.id;
  const res = await fetch(`${base()}/configs/${id}/cell?col=9&row=0`);
  assert.equal(res.status, 400);
});

test('未知配置返回 404 NOT_FOUND', async () => {
  const res = await fetch(`${base()}/configs/deadbeefdeadbeef`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'NOT_FOUND');
});

test('子区域 API 结果与全局索引对应', async () => {
  const params = { reMin: -2.5, reMax: 1, imMin: -1.25, imMax: 1.25, width: 16, height: 10, maxIterations: 60 };
  const id = (await (await post('/configs', params)).json()).summary.id;
  const res = await post(`/configs/${id}/subgrid`, { colStart: 2, colEnd: 10, rowStart: 1, rowEnd: 8 });
  assert.equal(res.status, 200);
  const { cells, globalBounds } = await res.json();
  assert.equal(cells.length, 8 * 7);
  assert.equal(cells[0].col, 2);
  assert.equal(cells[0].row, 1);
  assert.deepEqual(globalBounds, { colStart: 2, colEnd: 10, rowStart: 1, rowEnd: 8 });
});

test('轨迹 API：c=1 第 3 步逃逸', async () => {
  const res = await post('/trajectory', { re: 1, im: 0, maxIterations: 10 });
  const { trajectory: tr } = await res.json();
  assert.equal(tr.escapeStep, 3);
  assert.equal(tr.finalStatus, 'escaped');
});

test('导出 JSON 与 PGM', async () => {
  const params = { reMin: -2, reMax: 1, imMin: -1, imMax: 1, width: 6, height: 4, maxIterations: 30 };
  const id = (await (await post('/configs', params)).json()).summary.id;
  const jsonRes = await fetch(`${base()}/configs/${id}/export/json`);
  assert.equal(jsonRes.status, 200);
  const json = await jsonRes.json();
  assert.equal(json.cells.length, 24);
  const pgmRes = await fetch(`${base()}/configs/${id}/export/pgm`);
  assert.equal(pgmRes.headers.get('content-type'), 'image/x-portable-graymap');
  const pgmBuf = Buffer.from(await pgmRes.arrayBuffer());
  assert.ok(pgmBuf.subarray(0, 2).toString('ascii') === 'P5');
});

test('非法 JSON 返回 INVALID_JSON', async () => {
  const res = await fetch(base() + '/configs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'INVALID_JSON');
});
