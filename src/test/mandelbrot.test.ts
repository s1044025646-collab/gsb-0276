import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../db/store.js";
import { MandelbrotService } from "../core/service.js";
import { cellCenter, computeGrid, escapeTime, trajectory, validateConfigInput } from "../core/mandelbrot.js";
import type { ConfigInput } from "../core/types.js";
import { AppError } from "../core/errors.js";
import { exportPgm } from "../core/exporter.js";

const baseCfg: ConfigInput = {
  xMin: -2,
  xMax: 1,
  yMin: -1.5,
  yMax: 1.5,
  width: 6,
  height: 6,
  maxIterations: 100,
  totalIterationBudget: null,
};

describe("手算逃逸点核对", () => {
  test("c=0 在有限预算内不逃逸", () => {
    assert.equal(escapeTime(0, 0, 100), null);
  });
  test("c=-1 在有限预算内不逃逸（2 周期）", () => {
    assert.equal(escapeTime(-1, 0, 100), null);
  });
  test("c=1 第三步首次逃逸：z1=1, z2=2, z3=5>4", () => {
    assert.equal(escapeTime(1, 0, 100), 3);
  });
  test("c=2 第二步首次逃逸：z1=2(|z|²=4 不严格大于4), z2=6>4", () => {
    assert.equal(escapeTime(2, 0, 100), 2);
  });
  test("模恰好等于 2 时不算逃逸（边界严格性）", () => {
    const t = trajectory(2, 0, 1);
    assert.equal(t.points[0]!.normSquared, 4);
    assert.equal(t.points[0]!.escaped, false);
    assert.equal(t.escaped, false);
  });
  test("实部虚部同步更新：c=i 序列手算", () => {
    // z1=i(|i|²=1), z2=-1+i(2), z3=-i(1), z4=-1+i(2)... 有界
    assert.equal(escapeTime(0, 1, 100), null);
    const t = trajectory(0, 1, 3);
    assert.deepEqual(
      t.points.map((p) => [p.zReal, p.zImag]),
      [[0, 1], [-1, 1], [0, -1]],
    );
  });
});

describe("共轭点与轨迹", () => {
  test("共轭点步数相同", () => {
    for (const [x, y] of [[-0.5, 0.5], [0.2, 0.7], [-1.2, 0.4], [-0.1, 0.9]] as const) {
      assert.equal(escapeTime(x, y, 200), escapeTime(x, -y, 200), `c=${x}+${y}i`);
    }
  });
  test("轨迹含 z1..zK，逃逸步后立即终止", () => {
    const t = trajectory(1, 0, 100);
    assert.equal(t.escapeStep, 3);
    assert.equal(t.points.length, 3);
    assert.equal(t.points[2]!.escaped, true);
    assert.equal(t.points[2]!.normSquared, 25);
  });
});

describe("像素中心坐标", () => {
  test("边缘像素中心不在边界上", () => {
    const tl = cellCenter(baseCfg, 0, 0);
    assert.ok(tl.x > baseCfg.xMin && tl.x < baseCfg.xMax);
    assert.ok(tl.y < baseCfg.yMax && tl.y > baseCfg.yMin);
    const br = cellCenter(baseCfg, 5, 5);
    assert.ok(br.x > baseCfg.xMin && br.x < baseCfg.xMax);
  });
  test("宽高为一时取矩形中心", () => {
    const one: ConfigInput = { ...baseCfg, width: 1, height: 1 };
    assert.deepEqual(cellCenter(one, 0, 0), { x: -0.5, y: 0 });
  });
  test("列增实部增，行增虚部减", () => {
    const left = cellCenter(baseCfg, 2, 1);
    const right = cellCenter(baseCfg, 2, 2);
    const top = cellCenter(baseCfg, 1, 2);
    const bottom = cellCenter(baseCfg, 2, 2);
    assert.ok(right.x > left.x);
    assert.ok(bottom.y < top.y);
  });
});

describe("非法输入", () => {
  test("反转/退化范围", () => {
    assert.throws(() => validateConfigInput({ ...baseCfg, xMax: -3 }), (e: unknown) => e instanceof AppError && e.code === "INVALID_RANGE");
    assert.throws(() => validateConfigInput({ ...baseCfg, yMax: -1.5 }), (e: unknown) => e instanceof AppError && e.code === "INVALID_RANGE");
  });
  test("尺寸与预算越界", () => {
    assert.throws(() => validateConfigInput({ ...baseCfg, width: 0 }), (e: unknown) => e instanceof AppError && e.code === "INVALID_DIMENSIONS");
    assert.throws(() => validateConfigInput({ ...baseCfg, maxIterations: 0 }), (e: unknown) => e instanceof AppError && e.code === "INVALID_BUDGET");
    assert.throws(() => validateConfigInput({ ...baseCfg, totalIterationBudget: -1 }), (e: unknown) => e instanceof AppError && e.code === "INVALID_BUDGET");
  });
});

describe("数据库持久化", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mandel-test-"));
    dbPath = join(dir, "data.sqlite");
  });

  test("完整计算后可在新 Store 中复查同一网格", () => {
    let store = new Store(dbPath);
    const svc = new MandelbrotService(store);
    const created = svc.createConfig({ xMin: -2, xMax: 1, yMin: -1.5, yMax: 1.5, width: 12, height: 10, maxIterations: 50 });
    const done = svc.compute(created.id);
    assert.equal(done.status, "complete");
    assert.equal(done.computedCells, 120);
    assert.equal(done.escapedCells + done.unresolvedCells, 120);
    const beforeReopen = svc.getCell(created.id, 5, 3);
    store.close();

    store = new Store(dbPath);
    const svc2 = new MandelbrotService(store);
    const reopened = svc2.getGrid(created.id);
    assert.equal(reopened.status, "complete");
    assert.deepEqual(svc2.getCell(created.id, 5, 3), beforeReopen);
    store.close();
  });

  test("超全局迭代预算时状态为 budget_exhausted，且不可误报 complete", () => {
    const store = new Store(dbPath);
    const svc = new MandelbrotService(store);
    // 每点最多 1000 次迭代，共 400 点；预算只允许前几个点
    const created = svc.createConfig({ xMin: -0.2, xMax: 0.2, yMin: -0.2, yMax: 0.2, width: 20, height: 20, maxIterations: 1000, totalIterationBudget: 1500 });
    const row = svc.compute(created.id);
    assert.equal(row.status, "budget_exhausted");
    assert.ok(row.computedCells < 400);
    assert.ok(row.iterationsPerformed <= 1500 + 1000);
    // 再次计算（预算未变）仍不能完成
    const row2 = svc.compute(created.id);
    assert.equal(row2.status, "budget_exhausted");
    store.close();
  });

  test("提高迭代上限生成新报告，部分原未决点获得逃逸结论", () => {
    const store = new Store(dbPath);
    const svc = new MandelbrotService(store);
    const low = svc.compute(svc.createConfig({ xMin: -2, xMax: 1, yMin: -1.5, yMax: 1.5, width: 30, height: 30, maxIterations: 5 }).id);
    const high = svc.compute(svc.createConfig({ xMin: -2, xMax: 1, yMin: -1.5, yMax: 1.5, width: 30, height: 30, maxIterations: 200 }).id);
    assert.notEqual(low.id, high.id);
    assert.ok(high.unresolvedCells < low.unresolvedCells);
    store.close();
  });

  test("先按需查点再整图计算：跳过已算点，结果完整且统计不重复", () => {
    const store2 = new Store(dbPath + ".p.sqlite");
    const svc = new MandelbrotService(store2);
    const created = svc.createConfig({ xMin: -2, xMax: 1, yMin: -1.5, yMax: 1.5, width: 10, height: 8, maxIterations: 40 });
    const onDemand = svc.getCell(created.id, 3, 4);
    const done = svc.compute(created.id);
    assert.equal(done.status, "complete");
    assert.equal(done.computedCells, 80);
    assert.equal(done.escapedCells + done.unresolvedCells, 80);
    const again = svc.getCell(created.id, 3, 4);
    assert.equal(again.escapeStep, onDemand.escapeStep);
    assert.equal(again.escaped, onDemand.escaped);
    store2.close();
  });
});

describe("子区域拼接一致", () => {
  let dir: string;
  let store: Store;
  let svc: MandelbrotService;
  let id: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mandel-test-"));
    store = new Store(join(dir, "data.sqlite"));
    svc = new MandelbrotService(store);
    id = svc.compute(
      svc.createConfig({ xMin: -2, xMax: 1, yMin: -1.5, yMax: 1.5, width: 24, height: 18, maxIterations: 80 }).id,
    ).id;
  });

  afterEach(() => store.close());

  test("四块子区域拼回后与整图逐点相同（且使用全图索引坐标）", () => {
    const full = svc.getRegion(id, { rowStart: 0, colStart: 0, width: 24, height: 18 });
    const quads = [
      svc.getRegion(id, { rowStart: 0, colStart: 0, width: 12, height: 9 }),
      svc.getRegion(id, { rowStart: 0, colStart: 12, width: 12, height: 9 }),
      svc.getRegion(id, { rowStart: 9, colStart: 0, width: 12, height: 9 }),
      svc.getRegion(id, { rowStart: 9, colStart: 12, width: 12, height: 9 }),
    ];
    const stitched = new Map<string, (typeof full.cells)[number]>();
    for (const q of quads) {
      for (const cell of q.cells) {
        stitched.set(`${cell.row}:${cell.col}`, cell);
      }
    }
    assert.equal(stitched.size, full.cells.length);
    for (const cell of full.cells) {
      const other = stitched.get(`${cell.row}:${cell.col}`)!;
      assert.equal(other.x, cell.x);
      assert.equal(other.y, cell.y);
      assert.equal(other.escapeStep, cell.escapeStep);
      assert.equal(other.escaped, cell.escaped);
    }
  });

  test("越界子区域被拒绝", () => {
    assert.throws(() => svc.getRegion(id, { rowStart: 10, colStart: 0, width: 12, height: 9 }), (e: unknown) => e instanceof AppError && e.code === "INVALID_REGION");
  });

  test("PGM 导出：未逃逸=255，已逃逸灰度在1..254，且与步长单调", () => {
    const grid = svc.getGrid(id);
    const pgm = exportPgm(store, grid);
    assert.ok(pgm.subarray(0, 3).toString("ascii").startsWith("P5"));
    const cell = svc.getCell(id, 0, 0);
    if (cell.escaped) {
      const headerEnd = pgm.indexOf(10, pgm.indexOf(10, pgm.indexOf(10) + 1) + 1) + 1;
      const v = pgm[headerEnd]!;
      assert.ok(v >= 1 && v <= 254);
    }
  });
});

describe("computeGrid 顺序与预算", () => {
  test("按行优先顺序，每点完整算完", () => {
    const seen: number[] = [];
    const cfg: ConfigInput = { ...baseCfg, width: 3, height: 2, maxIterations: 10 };
    computeGrid(cfg, 0, 0, new Set(), (_cell, index) => seen.push(index));
    assert.deepEqual(seen, [0, 1, 2, 3, 4, 5]);
  });
});
