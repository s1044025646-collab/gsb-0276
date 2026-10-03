import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage, configId } from '../dist/storage.js';
import { computeGrid } from '../dist/mandelbrot.js';
import { encodePGM } from '../dist/pgm.js';

const params = { reMin: -2.5, reMax: 1, imMin: -1.25, imMax: 1.25, width: 20, height: 12, maxIterations: 60 };

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'mandel-'));
  return { dir, dbPath: join(dir, 'mandelbrot.db') };
}

test('保存后可读取摘要、格点，且统计自洽', () => {
  const { dir, dbPath } = freshDb();
  const storage = new Storage(dbPath);
  const cells = computeGrid(params);
  const summary = storage.save(params, cells);
  assert.equal(summary.status, 'complete');
  assert.equal(summary.cellCount, 240);
  assert.equal(summary.escapedCount + summary.boundedCount, 240);
  assert.equal(summary.algorithmVersion, 'mandelbrot-escape-v1');
  const cell = storage.getCell(summary.id, 0, 0);
  assert.equal(cell.col, 0);
  assert.equal(typeof cell.escapeStep === 'number' || cell.escapeStep === null, true);
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

test('同参数 ID 确定且幂等；改参数产生新 ID', () => {
  const a = configId(params);
  const b = configId({ ...params });
  const c = configId({ ...params, maxIterations: 61 });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('重新打开数据库（模拟重启）后能读取同一网格', () => {
  const { dir, dbPath } = freshDb();
  const id = configId(params);
  const s1 = new Storage(dbPath);
  s1.save(params, computeGrid(params));
  s1.close();

  const s2 = new Storage(dbPath);
  const summary = s2.get(id);
  assert.ok(summary);
  assert.equal(summary.cellCount, 240);
  const all = s2.getAllCells(id);
  assert.equal(all.length, 240);
  // 行优先排序
  assert.equal(all[0].row, 0);
  assert.equal(all.at(-1).row, 11);
  s2.close();
  rmSync(dir, { recursive: true, force: true });
});

test('重复保存同一配置不产生重复记录', () => {
  const { dir, dbPath } = freshDb();
  const storage = new Storage(dbPath);
  storage.save(params, computeGrid(params));
  storage.save(params, computeGrid(params));
  assert.equal(storage.list().length, 1);
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

test('PGM 编码：未逃逸为黑(0)，已逃逸非黑，且尺寸正确', () => {
  const { dir, dbPath } = freshDb();
  const storage = new Storage(dbPath);
  const summary = storage.save(params, computeGrid(params));
  const cells = storage.getAllCells(summary.id);
  const buf = encodePGM(summary, cells);
  const headerEnd = buf.indexOf(0x0a, buf.indexOf(0x0a, buf.indexOf(0x0a) + 1) + 1) + 1;
  assert.ok(buf.subarray(0, headerEnd).toString('ascii').startsWith('P5\n20 12\n255\n'));
  const body = buf.subarray(headerEnd);
  assert.equal(body.length, 20 * 12);
  for (const c of cells) {
    const gray = body[c.row * 20 + c.col];
    if (c.escapeStep === null) assert.equal(gray, 0);
    else assert.ok(gray >= 1 && gray <= 255);
  }
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});
