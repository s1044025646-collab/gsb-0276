export const ALGORITHM_VERSION = 'mandelbrot-escape-v1';

/** 参数上限（普通双精度、同步计算下的合理预算） */
export const LIMITS = {
  MAX_WIDTH: 4096,
  MAX_HEIGHT: 4096,
  MIN_DIMENSION: 1,
  MAX_ITERATIONS: 100_000,
  MIN_ITERATIONS: 1,
  /** 网格点总数上限 */
  MAX_CELLS: 2_000_000,
  /** 总迭代预算上限 = 格点数 × 最大迭代次数 */
  MAX_ITERATION_BUDGET: 100_000_000,
  /** 矩形跨度下限，防止退化区间与极端深缩放 */
  MIN_SPAN: 1e-9,
  /** 坐标绝对值上限 */
  MAX_ABS_COORD: 1e6,
} as const;

/** 逃逸判据阈值：模平方严格大于 4（即 |z| 严格大于 2） */
export const ESCAPE_MOD2_THRESHOLD = 4;
