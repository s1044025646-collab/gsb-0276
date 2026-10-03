/** 本服务固定使用的算法版本标识。 */
export const ALGORITHM_VERSION = "escape-time-z0-v1";

/** 硬上限（合理范围，防止普通本机资源被耗尽）。 */
export const LIMITS = {
  MAX_WIDTH: 4096,
  MAX_HEIGHT: 4096,
  MAX_CELLS: 4_000_000,
  MAX_ITERATIONS: 100_000,
  MAX_TOTAL_ITERATION_BUDGET: 500_000_000,
  MIN_ABS_EXTENT: 1e-15,
} as const;

/** 一次网格计算配置（复平面矩形 + 网格尺寸 + 迭代预算）。 */
export interface GridConfig {
  id: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  width: number;
  height: number;
  maxIterations: number;
  totalIterationBudget: number | null;
  algorithmVersion: string;
}

export type GridStatus = "complete" | "budget_exhausted";

/**
 * 格点结果：
 * - escaped=true ：第 escapeStep 步首次逃逸，escapeStep ∈ [1, maxIterations]
 * - escaped=false：在本次预算内未观测到逃逸（不证明该点属于 Mandelbrot 集）
 */
export interface CellResult {
  row: number;
  col: number;
  x: number;
  y: number;
  escaped: boolean;
  escapeStep: number | null;
}

/** 单点迭代轨迹中的一步（z 在执行第 step 次递推之后的值）。 */
export interface TrajectoryStep {
  step: number;
  zReal: number;
  zImag: number;
  normSquared: number;
  escaped: boolean;
}

export interface GridSummary {
  computedCells: number;
  totalCells: number;
  escapedCells: number;
  unresolvedCells: number;
  iterationsPerformed: number;
  status: GridStatus;
}

/** 校验通过并归一化后的创建配置输入。 */
export interface ConfigInput {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  width: number;
  height: number;
  maxIterations: number;
  totalIterationBudget?: number | null;
}
