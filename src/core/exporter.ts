import { CELL_PENDING, type GridRow, Store } from "../db/store.js";
import { cellCenter } from "./mandelbrot.js";

export interface ExportCell {
  row: number;
  col: number;
  x: number;
  y: number;
  escaped: boolean | null;
  escapeStep: number | null;
}

/**
 * 导出原始计算矩阵为 JSON。
 * escaped=null 表示该点尚未计算（网格不完整）；
 * escaped=false 表示本次迭代预算内未观测到逃逸（不是集合成员证明）。
 */
export function exportJson(store: Store, grid: GridRow): {
  id: string;
  algorithmVersion: string;
  status: string;
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
  dimensions: { width: number; height: number };
  maxIterations: number;
  totalIterationBudget: number | null;
  coordinateMapping: { xFormula: string; yFormula: string };
  grayscaleRule: string;
  summary: Record<string, unknown>;
  cells: ExportCell[];
} {
  const indices: number[] = [];
  for (let i = 0; i < grid.width * grid.height; i++) {
    indices.push(i);
  }
  const values = store.getRegion(grid.id, indices);
  const cells: ExportCell[] = [];
  for (let i = 0; i < indices.length; i++) {
    const value = values[i]!;
    const row = Math.floor(i / grid.width);
    const col = i - row * grid.width;
    const { x, y } = cellCenter(grid, row, col);
    if (value === null || value === CELL_PENDING) {
      cells.push({ row, col, x, y, escaped: null, escapeStep: null });
    } else if (value === 0) {
      cells.push({ row, col, x, y, escaped: false, escapeStep: null });
    } else {
      cells.push({ row, col, x, y, escaped: true, escapeStep: value });
    }
  }
  return {
    id: grid.id,
    algorithmVersion: grid.algorithmVersion,
    status: grid.status,
    bounds: { xMin: grid.xMin, xMax: grid.xMax, yMin: grid.yMin, yMax: grid.yMax },
    dimensions: { width: grid.width, height: grid.height },
    maxIterations: grid.maxIterations,
    totalIterationBudget: grid.totalIterationBudget,
    coordinateMapping: {
      xFormula: "x(col) = xMin + (col + 0.5) * (xMax - xMin) / width",
      yFormula: "y(row) = yMax - (row + 0.5) * (yMax - yMin) / height",
    },
    grayscaleRule:
      "PGM(P5) 8-bit 灰度：尚未计算=0(黑)；预算内未逃逸=255(白)；已逃逸=ceil(254*(1-step/maxIterations))，step∈[1,maxIterations]，范围1..254，近逃逸为深色。",
    summary: {
      totalCells: grid.width * grid.height,
      computedCells: grid.computedCells,
      escapedCells: grid.escapedCells,
      unresolvedCells: grid.unresolvedCells,
      iterationsPerformed: grid.iterationsPerformed,
    },
    cells,
  };
}

function grayFor(escapeStep: number, maxIterations: number): number {
  if (escapeStep <= 0) {
    return 255;
  }
  const g = Math.ceil(254 * (1 - escapeStep / maxIterations));
  return Math.max(1, Math.min(254, g));
}

/**
 * 导出二进制灰度 PGM（P5）。灰度规则：
 * - 尚未计算：0（纯黑）
 * - 本次预算内未逃逸：255（纯白）
 * - 已逃逸，第 step 步首次逃逸：ceil(254*(1-step/maxIterations))，取值 1..254
 * 着色只用于展示，原始步数以 JSON / 查询接口为准。
 */
export function exportPgm(store: Store, grid: GridRow): Buffer {
  const values = store.getRegion(grid.id, Array.from({ length: grid.width * grid.height }, (_, i) => i));
  const pixels = Buffer.alloc(grid.width * grid.height);
  for (let i = 0; i < values.length; i++) {
    const value = values[i] ?? null;
    if (value === null) {
      pixels[i] = 0;
    } else if (value === 0) {
      pixels[i] = 255;
    } else {
      pixels[i] = grayFor(value, grid.maxIterations);
    }
  }
  const header = Buffer.from(`P5\n${grid.width} ${grid.height}\n255\n`, "ascii");
  return Buffer.concat([header, pixels]);
}
