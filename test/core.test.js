import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeTime,
  trajectory,
  cellCoord,
  computeGrid,
  computeSubgrid,
  validateParams,
} from '../dist/mandelbrot.js';
import { AppError } from '../dist/errors.js';

test('手算点：c=0 与 c=-1 在有限预算内不逃逸', () => {
  assert.equal(escapeTime(0, 0, 50), null);
  assert.equal(escapeTime(-1, 0, 50), null);
});

test('手算点：c=1 第 3 步首次逃逸', () => {
  assert.equal(escapeTime(1, 0, 50), 3);
});

test('手算点：c=2 第 2 步首次逃逸', () => {
  assert.equal(escapeTime(2, 0, 50), 2);
});

test('模平方恰好等于 4 时不逃逸（严格大于阈值）', () => {
  // c=1：z1=1(mod2=1), z2=2(mod2=4，恰好等于阈值，不逃逸), z3=5(mod2=25，逃逸)
  const tr = trajectory(1, 0, 3);
  assert.equal(tr.points[2].mod2, 4);
  assert.equal(tr.points[2].escaped, false);
  assert.equal(tr.points[3].escaped, true);
  assert.equal(tr.escapeStep, 3);
});

test('共轭点 c 与 conj(c) 逃逸步数相同', () => {
  for (const [re, im] of [[-0.5, 0.5], [-1.2, 0.3], [0.2, 0.7]]) {
    assert.equal(escapeTime(re, im, 300), escapeTime(re, -im, 300));
  }
});

test('轨迹步号从 0 开始且最后一步逃逸状态不与上限混淆', () => {
  const tr = trajectory(2, 0, 10);
  assert.equal(tr.finalStatus, 'escaped');
  assert.equal(tr.escapeStep, 2);
  assert.equal(tr.points.at(-1).step, 2);
  const bounded = trajectory(0, 0, 5);
  assert.equal(bounded.finalStatus, 'bounded-within-budget');
  assert.equal(bounded.escapeStep, null);
  assert.equal(bounded.points.length, 6); // z0..z5
});

test('像素中心坐标：边界不作为边缘像素中心', () => {
  const p = { reMin: -2, reMax: 2, imMin: -1, imMax: 1, width: 4, height: 2, maxIterations: 10 };
  const tl = cellCoord(p, 0, 0);
  assert.equal(tl.re, -1.5); // -2 + 0.5*4/4
  assert.equal(tl.im, 0.5); // 1 - 0.5*(1-(-1))/2 = 1 - 0.5
  const br = cellCoord(p, 3, 1);
  assert.equal(br.re, 1.5);
  assert.equal(br.im, -0.5);
});

test('宽高为 1 时中心即矩形中点', () => {
  const p = { reMin: -2, reMax: 2, imMin: -1, imMax: 1, width: 1, height: 1, maxIterations: 10 };
  assert.deepEqual(cellCoord(p, 0, 0), { re: 0, im: 0 });
  const cells = computeGrid(p);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].escaped, false);
});

test('行列方向：列增大实部增大，行增大虚部减小', () => {
  const p = { reMin: -2, reMax: 2, imMin: -1, imMax: 1, width: 3, height: 3, maxIterations: 5 };
  const cells = computeGrid(p);
  const at = (c, r) => cells[r * 3 + c];
  assert.ok(at(1, 0).re > at(0, 0).re);
  assert.ok(at(0, 1).im < at(0, 0).im);
});

test('子区域按全图索引取样，放回原位置与整图相同', () => {
  const p = { reMin: -2.5, reMax: 1, imMin: -1.25, imMax: 1.25, width: 24, height: 18, maxIterations: 80 };
  const full = computeGrid(p);
  const sub = computeSubgrid(p, { colStart: 5, colEnd: 20, rowStart: 3, rowEnd: 15 });
  for (const c of sub) {
    assert.equal(c.escapeStep, full[c.row * p.width + c.col].escapeStep);
    assert.equal(c.re, full[c.row * p.width + c.col].re);
  }
  // 子区域尺寸正确
  assert.equal(sub.length, 15 * 12);
});

test('单行、单列子区域也合法', () => {
  const p = { reMin: -2, reMax: 2, imMin: -2, imMax: 2, width: 10, height: 10, maxIterations: 20 };
  assert.equal(computeSubgrid(p, { colStart: 1, colEnd: 2, rowStart: 0, rowEnd: 10 }).length, 10);
  assert.equal(computeSubgrid(p, { colStart: 0, colEnd: 10, rowStart: 4, rowEnd: 5 }).length, 10);
});

test('最后一步（恰在第 maxIterations 步）逃逸记为已逃逸而非未决', () => {
  // 手工找一个点：用不同预算交叉验证。c=1 在预算 3 时第 3 步逃逸
  assert.equal(escapeTime(1, 0, 3), 3);
  assert.equal(escapeTime(1, 0, 2), null); // 预算 2 时尚未逃逸（z2 模=2）
});

test('非法范围：reMax<=reMin、非数值、退化区间均报 INVALID_RANGE', () => {
  const base = { reMin: -2, reMax: 2, imMin: -1, imMax: 1, width: 10, height: 10, maxIterations: 20 };
  assert.throws(() => validateParams({ ...base, reMax: -2 }), (e) => e instanceof AppError && e.code === 'INVALID_RANGE');
  assert.throws(() => validateParams({ ...base, imMax: -1 }), (e) => e.code === 'INVALID_RANGE');
  assert.throws(() => validateParams({ ...base, reMin: 'x' }), (e) => e.code === 'INVALID_RANGE');
  assert.throws(() => validateParams({ ...base, reMin: 0, reMax: 1e-12 }), (e) => e.code === 'INVALID_RANGE');
});

test('超尺寸与超预算报 BUDGET_EXCEEDED', () => {
  // 单维在允许范围内，但总迭代预算超过上限
  assert.throws(
    () => validateParams({ reMin: -2, reMax: 2, imMin: -2, imMax: 2, width: 4000, height: 4000, maxIterations: 100000 }),
    (e) => e.code === 'BUDGET_EXCEEDED',
  );
});

test('单维超上限报 INVALID_DIMENSIONS', () => {
  assert.throws(
    () => validateParams({ reMin: -2, reMax: 2, imMin: -2, imMax: 2, width: 99999, height: 10, maxIterations: 10 }),
    (e) => e.code === 'INVALID_DIMENSIONS',
  );
});

test('非整数尺寸报 INVALID_DIMENSIONS', () => {
  assert.throws(
    () => validateParams({ reMin: -2, reMax: 2, imMin: -2, imMax: 2, width: 1.5, height: 10, maxIterations: 10 }),
    (e) => e.code === 'INVALID_DIMENSIONS',
  );
});

test('提高迭代上限只会把部分未决点变为逃逸，已逃逸步数不变', () => {
  const base = { reMin: -0.8, reMax: -0.6, imMin: -0.2, imMax: 0.2, width: 12, height: 12 };
  const g1 = computeGrid({ ...base, maxIterations: 10 });
  const g2 = computeGrid({ ...base, maxIterations: 500 });
  for (let i = 0; i < g1.length; i++) {
    if (g1[i].escapeStep !== null) assert.equal(g1[i].escapeStep, g2[i].escapeStep);
  }
});
