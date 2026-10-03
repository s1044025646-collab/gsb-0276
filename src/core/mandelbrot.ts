import { ALGORITHM_VERSION, LIMITS, type CellResult, type ConfigInput, type TrajectoryStep } from "./types.js";
import { AppError } from "./errors.js";

/**
 * 像素中心坐标映射（width/height 为 1 时取矩形中心）：
 *   x(col) = xMin + (col + 0.5) * (xMax - xMin) / width
 *   y(row) = yMax - (row + 0.5) * (yMax - yMin) / height
 * 列从左到右实部增加，行从上到下虚部减小；矩形边界不作为边缘像素中心。
 */
export function cellCenter(cfg: Pick<ConfigInput, "xMin" | "xMax" | "yMin" | "yMax" | "width" | "height">, row: number, col: number): { x: number; y: number } {
  const x = cfg.xMin + ((col + 0.5) * (cfg.xMax - cfg.xMin)) / cfg.width;
  const y = cfg.yMax - ((row + 0.5) * (cfg.yMax - cfg.yMin)) / cfg.height;
  return { x, y };
}

/**
 * 单点逃逸时间核心。
 * z0 = 0；每一步先由“上一轮”的实部/虚部同时计算新实部与新虚部，
 * 再检查 |z|^2 是否严格大于 4。
 * 返回首次逃逸步号（从 1 开始）；maxIterations 步后仍未逃逸返回 null。
 */
export function escapeTime(cReal: number, cImag: number, maxIterations: number): number | null {
  let zReal = 0;
  let zImag = 0;
  for (let step = 1; step <= maxIterations; step++) {
    const prevReal = zReal;
    const prevImag = zImag;
    const nextReal = prevReal * prevReal - prevImag * prevImag + cReal;
    const nextImag = 2 * prevReal * prevImag + cImag;
    zReal = nextReal;
    zImag = nextImag;
    if (zReal * zReal + zImag * zImag > 4) {
      return step;
    }
  }
  return null;
}

/**
 * 单点轨迹：返回 z0..zK。每个元素的 escaped 表示该步后是否严格越过阈值。
 * 最后一项是首次逃逸步，或第 maxIterations 步（本次预算内未逃逸）。
 */
export function trajectory(cReal: number, cImag: number, maxIterations: number): { c: { real: number; imag: number }; points: TrajectoryStep[]; escaped: boolean; escapeStep: number | null } {
  const points: TrajectoryStep[] = [];
  let zReal = 0;
  let zImag = 0;
  for (let step = 1; step <= maxIterations; step++) {
    const prevReal = zReal;
    const prevImag = zImag;
    const nextReal = prevReal * prevReal - prevImag * prevImag + cReal;
    const nextImag = 2 * prevReal * prevImag + cImag;
    zReal = nextReal;
    zImag = nextImag;
    const normSquared = zReal * zReal + zImag * zImag;
    const escaped = normSquared > 4;
    points.push({ step, zReal, zImag, normSquared, escaped });
    if (escaped) {
      return { c: { real: cReal, imag: cImag }, points, escaped: true, escapeStep: step };
    }
  }
  return { c: { real: cReal, imag: cImag }, points, escaped: false, escapeStep: null };
}

export interface ComputeProgress {
  iterationsPerformed: number;
  computedCells: number;
  escapedCells: number;
  unresolvedCells: number;
  /** true 表示在算完下一个点之前全局迭代预算已不足以继续。 */
  stoppedByBudget: boolean;
}

/**
 * 从 startIndex（行优先，index = row*width+col）开始顺序计算网格，
 * 可在全局迭代预算耗尽时提前停止；每个点本身始终算满 maxIterations 或到首次逃逸，
 * 不存在“点算一半”。
 */
export function computeGrid(
  cfg: ConfigInput,
  startIndex: number,
  alreadyPerformed: number,
  skipIndices: ReadonlySet<number>,
  onCell: (result: CellResult, index: number, iterationsUsed: number) => void,
): ComputeProgress {
  const total = cfg.width * cfg.height;
  const budget = cfg.totalIterationBudget ?? null;
  let iterationsPerformed = alreadyPerformed;
  let computedCells = 0;
  let escapedCells = 0;
  let unresolvedCells = 0;

  for (let index = startIndex; index < total; index++) {
    if (skipIndices.has(index)) {
      continue;
    }
    if (budget !== null && iterationsPerformed + cfg.maxIterations > budget) {
      return { iterationsPerformed, computedCells, escapedCells, unresolvedCells, stoppedByBudget: true };
    }
    const row = Math.floor(index / cfg.width);
    const col = index - row * cfg.width;
    const { x, y } = cellCenter(cfg, row, col);
    let zReal = 0;
    let zImag = 0;
    let escapeStep: number | null = null;
    let used = 0;
    for (let step = 1; step <= cfg.maxIterations; step++) {
      used = step;
      const prevReal = zReal;
      const prevImag = zImag;
      zReal = prevReal * prevReal - prevImag * prevImag + x;
      zImag = 2 * prevReal * prevImag + y;
      if (zReal * zReal + zImag * zImag > 4) {
        escapeStep = step;
        break;
      }
    }
    iterationsPerformed += used;
    computedCells++;
    const escaped = escapeStep !== null;
    if (escaped) {
      escapedCells++;
    } else {
      unresolvedCells++;
    }
    onCell(
      { row, col, x, y, escaped, escapeStep },
      index,
      used,
    );
  }
  return { iterationsPerformed, computedCells, escapedCells, unresolvedCells, stoppedByBudget: false };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 校验并归一化创建/计算配置输入；非法输入抛 AppError（稳定错误码）。 */
export function validateConfigInput(raw: Record<string, unknown>): ConfigInput {
  const nums = {
    xMin: raw["xMin"],
    xMax: raw["xMax"],
    yMin: raw["yMin"],
    yMax: raw["yMax"],
    maxIterations: raw["maxIterations"],
  };
  if (!Object.values(nums).every(isFiniteNumber)) {
    throw new AppError("INVALID_RANGE", "xMin、xMax、yMin、yMax、maxIterations 必须全部为有限数值");
  }
  const width = raw["width"];
  const height = raw["height"];
  if (!(typeof width === "number" && Number.isInteger(width) && typeof height === "number" && Number.isInteger(height))) {
    throw new AppError("INVALID_DIMENSIONS", "width、height 必须为整数");
  }
  const { xMin, xMax, yMin, yMax, maxIterations } = nums as {
    xMin: number; xMax: number; yMin: number; yMax: number; maxIterations: number;
  };
  if (xMax <= xMin || yMax <= yMin) {
    throw new AppError("INVALID_RANGE", "要求 xMax > xMin 且 yMax > yMin");
  }
  if (xMax - xMin < LIMITS.MIN_ABS_EXTENT || yMax - yMin < LIMITS.MIN_ABS_EXTENT) {
    throw new AppError("INVALID_RANGE", `矩形跨度不能小于 ${LIMITS.MIN_ABS_EXTENT}（本服务不支持高精度深度缩放）`);
  }
  if (width < 1 || height < 1 || width > LIMITS.MAX_WIDTH || height > LIMITS.MAX_HEIGHT) {
    throw new AppError("INVALID_DIMENSIONS", `width、height 须在 1..${LIMITS.MAX_WIDTH} / 1..${LIMITS.MAX_HEIGHT} 之间`);
  }
  if (width * height > LIMITS.MAX_CELLS) {
    throw new AppError("INVALID_DIMENSIONS", `网格总点数不能超过 ${LIMITS.MAX_CELLS}`);
  }
  if (maxIterations < 1 || maxIterations > LIMITS.MAX_ITERATIONS) {
    throw new AppError("INVALID_BUDGET", `maxIterations 须在 1..${LIMITS.MAX_ITERATIONS} 之间`);
  }
  let totalIterationBudget: number | null = null;
  if (raw.totalIterationBudget !== undefined && raw.totalIterationBudget !== null) {
    if (!isFiniteNumber(raw.totalIterationBudget) || raw.totalIterationBudget < 1 || raw.totalIterationBudget > LIMITS.MAX_TOTAL_ITERATION_BUDGET) {
      throw new AppError("INVALID_BUDGET", `totalIterationBudget 须为 1..${LIMITS.MAX_TOTAL_ITERATION_BUDGET} 的有限数值`);
    }
    totalIterationBudget = Math.floor(raw.totalIterationBudget);
  }
  return { xMin, xMax, yMin, yMax, width, height, maxIterations, totalIterationBudget };
}

/** 子区域（按全图行列索引取样，不重新缩放）。 */
export interface Region {
  rowStart: number;
  colStart: number;
  width: number;
  height: number;
}

export function validateRegion(raw: { rowStart?: unknown; colStart?: unknown; width?: unknown; height?: unknown }, gridWidth: number, gridHeight: number): Region {
  const { rowStart, colStart, width, height } = raw;
  if (
    !(
      typeof rowStart === "number" && Number.isInteger(rowStart) &&
      typeof colStart === "number" && Number.isInteger(colStart) &&
      typeof width === "number" && Number.isInteger(width) &&
      typeof height === "number" && Number.isInteger(height)
    )
  ) {
    throw new AppError("INVALID_REGION", "rowStart、colStart、width、height 必须全部为整数");
  }
  if (rowStart < 0 || colStart < 0 || width < 1 || height < 1) {
    throw new AppError("INVALID_REGION", "rowStart、colStart 不能为负，width、height 至少为 1");
  }
  if (colStart + width > gridWidth || rowStart + height > gridHeight) {
    throw new AppError("INVALID_REGION", "子区域超出全图网格范围");
  }
  return { rowStart, colStart, width, height };
}

export { ALGORITHM_VERSION };
