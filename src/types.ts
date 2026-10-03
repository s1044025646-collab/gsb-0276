export interface ComputeParams {
  /** 复平面矩形实部左边界 */
  reMin: number;
  /** 复平面矩形实部右边界 */
  reMax: number;
  /** 复平面矩形虚部下边界 */
  imMin: number;
  /** 复平面矩形虚部上边界 */
  imMax: number;
  /** 网格列数（水平像素数） */
  width: number;
  /** 网格行数（垂直像素数） */
  height: number;
  /** 每个格点的最大迭代次数（预算） */
  maxIterations: number;
}

/** 单个格点的逃逸结果。escapeStep 为 null 表示在本次预算内未逃逸（非集合成员证明） */
export interface CellResult {
  col: number;
  row: number;
  re: number;
  im: number;
  escaped: boolean;
  /** 首次逃逸步号，从 1 开始；预算内未逃逸为 null */
  escapeStep: number | null;
}

export interface TrajectoryPoint {
  /** 步号，0 表示初值 z=0 */
  step: number;
  zRe: number;
  zIm: number;
  mod2: number;
  /** 本步更新后模平方是否严格大于 4 */
  escaped: boolean;
}

export interface Trajectory {
  re: number;
  im: number;
  maxIterations: number;
  finalStatus: 'escaped' | 'bounded-within-budget';
  escapeStep: number | null;
  points: TrajectoryPoint[];
}

export interface ConfigSummary {
  id: string;
  params: ComputeParams;
  algorithmVersion: string;
  status: 'complete';
  cellCount: number;
  escapedCount: number;
  boundedCount: number;
  minEscapeStep: number | null;
  maxEscapeStep: number | null;
  createdAt: string;
}
