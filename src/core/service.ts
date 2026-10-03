import { randomUUID } from "node:crypto";
import { CELL_PENDING, CELL_UNRESOLVED, Store, type GridRow } from "../db/store.js";
import {
  ALGORITHM_VERSION,
  type CellResult,
  type ConfigInput,
  type GridConfig,
  type GridSummary,
} from "./types.js";
import {
  cellCenter,
  computeGrid,
  escapeTime,
  trajectory,
  validateConfigInput,
  validateRegion,
  type Region,
} from "./mandelbrot.js";
import { AppError } from "./errors.js";

const FLUSH_BATCH = 2048;

export class MandelbrotService {
  constructor(private readonly store: Store) {}

  /** 创建配置（仅落库参数，尚未产生任何结果）。 */
  createConfig(raw: Record<string, unknown>): GridRow {
    const input = validateConfigInput(raw);
    const cfg: GridConfig = {
      id: randomUUID(),
      xMin: input.xMin,
      xMax: input.xMax,
      yMin: input.yMin,
      yMax: input.yMax,
      width: input.width,
      height: input.height,
      maxIterations: input.maxIterations,
      totalIterationBudget: input.totalIterationBudget ?? null,
      algorithmVersion: ALGORITHM_VERSION,
    };
    this.store.createGrid(cfg);
    return this.requireGrid(cfg.id);
  }

  /**
   * 继续计算某个网格：已完整则直接返回；因全局迭代预算停止时
   * 状态保持 budget_exhausted，绝不会标记为 complete。
   */
  compute(id: string): GridRow {
    const row = this.requireGrid(id);
    if (row.status === "complete") {
      return row;
    }
    const cfg = this.toConfigInput(row);
    const startIndex = 0;
    const existing = this.store.getExistingIndices(row.id, 0);
    const batch: { idx: number; escapeStep: number }[] = [];
    let deltaEscaped = 0;
    let deltaUnresolved = 0;
    let deltaIterations = 0;
    let deltaComputed = 0;

    const flush = (): void => {
      if (batch.length === 0) {
        return;
      }
      this.store.writeCells(row.id, batch.splice(0, batch.length), {
        computed: deltaComputed,
        escaped: deltaEscaped,
        unresolved: deltaUnresolved,
        iterations: deltaIterations,
      });
      deltaComputed = 0;
      deltaEscaped = 0;
      deltaUnresolved = 0;
      deltaIterations = 0;
    };

    const progress = computeGrid(
      cfg,
      startIndex,
      row.iterationsPerformed,
      existing,
      (cell, idx, iterationsUsed) => {
        batch.push({ idx, escapeStep: cell.escaped ? cell.escapeStep! : CELL_UNRESOLVED });
        deltaComputed++;
        deltaIterations += iterationsUsed;
        if (cell.escaped) {
          deltaEscaped++;
        } else {
          deltaUnresolved++;
        }
        if (batch.length >= FLUSH_BATCH) {
          flush();
        }
      },
    );
    flush();

    const updated = this.requireGrid(id);
    const totalCells = cfg.width * cfg.height;
    if (!progress.stoppedByBudget && updated.computedCells >= totalCells) {
      this.store.markStatus(id, "complete");
    } else {
      this.store.markStatus(id, "budget_exhausted");
    }
    return this.requireGrid(id);
  }

  /** 查询单个格点（按全图行列索引；未计算的点当场计算并持久化，仅对该点生效）。 */
  getCell(id: string, row: number, col: number): CellResult & { status: string } {
    const grid = this.requireGrid(id);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= grid.height || col >= grid.width) {
      throw new AppError("INVALID_REGION", "格点行列索引超出网格范围", 404);
    }
    const idx = row * grid.width + col;
    let stored = this.store.getCell(id, idx);
    if (stored === null) {
      const { x, y } = cellCenter(grid, row, col);
      const step = escapeTime(x, y, grid.maxIterations);
      stored = step ?? CELL_UNRESOLVED;
      this.store.writeCells(id, [{ idx, escapeStep: stored }], {
        computed: 1,
        escaped: step === null ? 0 : 1,
        unresolved: step === null ? 1 : 0,
        iterations: step ?? grid.maxIterations,
      });
    }
    const { x, y } = cellCenter(grid, row, col);
    if (stored === CELL_PENDING) {
      throw new AppError("BAD_REQUEST", "内部错误：格点处于未计算状态");
    }
    return {
      row,
      col,
      x,
      y,
      escaped: stored > 0,
      escapeStep: stored > 0 ? stored : null,
      status: grid.status,
    };
  }

  /** 单点轨迹（只读重算，不改变网格状态）。 */
  getTrajectory(id: string, row: number, col: number) {
    const grid = this.requireGrid(id);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= grid.height || col >= grid.width) {
      throw new AppError("INVALID_REGION", "格点行列索引超出网格范围", 404);
    }
    const { x, y } = cellCenter(grid, row, col);
    return { row, col, x, y, ...trajectory(x, y, grid.maxIterations) };
  }

  /**
   * 提取矩形子区域：使用全图行列索引取样，不重新缩放坐标。
   * 未持久化的格点当场计算（不改写网格整体状态，放回后与整图计算逐点相同）。
   */
  getRegion(id: string, raw: Record<string, unknown>): {
    region: Region;
    coordinateMapping: { xFormula: string; yFormula: string };
    cells: CellResult[];
    gridStatus: string;
  } {
    const grid = this.requireGrid(id);
    const region = validateRegion(raw, grid.width, grid.height);
    const indices: number[] = [];
    for (let r = 0; r < region.height; r++) {
      for (let c = 0; c < region.width; c++) {
        indices.push((region.rowStart + r) * grid.width + region.colStart + c);
      }
    }
    const values = this.store.getRegion(id, indices);
    const pending: { idx: number; escapeStep: number; iterations: number }[] = [];
    const cells: CellResult[] = [];
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i]!;
      let value = values[i]!;
      const row = region.rowStart + Math.floor(i / region.width);
      const col = region.colStart + (i % region.width);
      const { x, y } = cellCenter(grid, row, col);
      if (value === null) {
        const step = escapeTime(x, y, grid.maxIterations);
        value = step ?? CELL_UNRESOLVED;
        pending.push({ idx, escapeStep: value, iterations: step ?? grid.maxIterations });
      }
      cells.push({ row, col, x, y, escaped: value > 0, escapeStep: value > 0 ? value : null });
    }
    if (pending.length > 0) {
      this.store.writeCells(
        id,
        pending.map((p) => ({ idx: p.idx, escapeStep: p.escapeStep })),
        {
          computed: pending.length,
          escaped: pending.filter((p) => p.escapeStep > 0).length,
          unresolved: pending.filter((p) => p.escapeStep === 0).length,
          iterations: pending.reduce((sum, p) => sum + p.iterations, 0),
        },
      );
    }
    return {
      region,
      coordinateMapping: {
        xFormula: "x(col) = xMin + (col + 0.5) * (xMax - xMin) / width",
        yFormula: "y(row) = yMax - (row + 0.5) * (yMax - yMin) / height",
      },
      cells,
      gridStatus: grid.status,
    };
  }

  getGrid(id: string): GridRow {
    return this.requireGrid(id);
  }

  listGrids(limit = 50): GridRow[] {
    return this.store.listGrids(Math.min(Math.max(limit, 1), 200));
  }

  summary(row: GridRow): GridSummary & { totalIterationBudget: number | null; id: string; algorithmVersion: string } {
    return {
      id: row.id,
      status: row.status,
      totalCells: row.width * row.height,
      computedCells: row.computedCells,
      escapedCells: row.escapedCells,
      unresolvedCells: row.unresolvedCells,
      iterationsPerformed: row.iterationsPerformed,
      totalIterationBudget: row.totalIterationBudget,
      algorithmVersion: row.algorithmVersion,
    };
  }

  private requireGrid(id: string): GridRow {
    const row = this.store.getGrid(id);
    if (!row) {
      throw new AppError("NOT_FOUND", `找不到网格配置：${id}`, 404);
    }
    return row;
  }

  private toConfigInput(row: GridRow): ConfigInput {
    return {
      xMin: row.xMin,
      xMax: row.xMax,
      yMin: row.yMin,
      yMax: row.yMax,
      width: row.width,
      height: row.height,
      maxIterations: row.maxIterations,
      totalIterationBudget: row.totalIterationBudget,
    };
  }
}
