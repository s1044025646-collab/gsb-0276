import { ESCAPE_MOD2_THRESHOLD, LIMITS } from './constants.js';
import { budgetExceeded, invalidDimensions, invalidRange } from './errors.js';
import type {
  CellResult,
  ComputeParams,
  Trajectory,
  TrajectoryPoint,
} from './types.js';

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/**
 * 校验计算参数。任何非法输入都抛出带错误码的 AppError（HTTP 400）。
 */
export function validateParams(input: unknown): ComputeParams {
  if (typeof input !== 'object' || input === null) {
    throw invalidRange('请求体必须是 JSON 对象');
  }
  const p = input as Record<string, unknown>;
  for (const key of ['reMin', 'reMax', 'imMin', 'imMax', 'width', 'height', 'maxIterations']) {
    if (!isFiniteNumber(p[key])) {
      throw invalidRange(`字段 ${key} 必须是有限数值`, { field: key });
    }
  }
  const params: ComputeParams = {
    reMin: p.reMin as number,
    reMax: p.reMax as number,
    imMin: p.imMin as number,
    imMax: p.imMax as number,
    width: (p.width as number) | 0,
    height: (p.height as number) | 0,
    maxIterations: (p.maxIterations as number) | 0,
  };

  for (const [key, v] of Object.entries({
    reMin: params.reMin,
    reMax: params.reMax,
    imMin: params.imMin,
    imMax: params.imMax,
  })) {
    if (Math.abs(v) > LIMITS.MAX_ABS_COORD) {
      throw invalidRange(`${key} 绝对值超过上限 ${LIMITS.MAX_ABS_COORD}`, { field: key });
    }
  }

  if (!(params.reMax > params.reMin)) {
    throw invalidRange('reMax 必须严格大于 reMin');
  }
  if (!(params.imMax > params.imMin)) {
    throw invalidRange('imMax 必须严格大于 imMin');
  }
  if (params.reMax - params.reMin < LIMITS.MIN_SPAN) {
    throw invalidRange(`实部跨度小于最小允许值 ${LIMITS.MIN_SPAN}（不支持高精度深缩放）`);
  }
  if (params.imMax - params.imMin < LIMITS.MIN_SPAN) {
    throw invalidRange(`虚部跨度小于最小允许值 ${LIMITS.MIN_SPAN}（不支持高精度深缩放）`);
  }

  if (
    !Number.isInteger(p.width) ||
    params.width < LIMITS.MIN_DIMENSION ||
    params.width > LIMITS.MAX_WIDTH
  ) {
    throw invalidDimensions(
      `width 必须是 [${LIMITS.MIN_DIMENSION}, ${LIMITS.MAX_WIDTH}] 内的整数`,
    );
  }
  if (
    !Number.isInteger(p.height) ||
    params.height < LIMITS.MIN_DIMENSION ||
    params.height > LIMITS.MAX_HEIGHT
  ) {
    throw invalidDimensions(
      `height 必须是 [${LIMITS.MIN_DIMENSION}, ${LIMITS.MAX_HEIGHT}] 内的整数`,
    );
  }
  if (
    !Number.isInteger(p.maxIterations) ||
    params.maxIterations < LIMITS.MIN_ITERATIONS ||
    params.maxIterations > LIMITS.MAX_ITERATIONS
  ) {
    throw invalidDimensions(
      `maxIterations 必须是 [${LIMITS.MIN_ITERATIONS}, ${LIMITS.MAX_ITERATIONS}] 内的整数`,
    );
  }

  if (params.width * params.height > LIMITS.MAX_CELLS) {
    throw budgetExceeded(
      `格点总数 ${params.width * params.height} 超过上限 ${LIMITS.MAX_CELLS}`,
    );
  }
  if (params.width * params.height * params.maxIterations > LIMITS.MAX_ITERATION_BUDGET) {
    throw budgetExceeded(
      `总迭代预算 格点数×最大迭代次数 = ${
        params.width * params.height * params.maxIterations
      } 超过上限 ${LIMITS.MAX_ITERATION_BUDGET}`,
    );
  }

  return params;
}

/**
 * 核心递推：z0=0，z_{n+1}=z_n^2+c。
 *
 * 关键正确性：实部与虚部的新值必须同时来自上一轮，
 * 先用两个局部变量算完再一起回写，禁止“先改实部再拿新实部算虚部”。
 *
 * 每步更新后检查模平方是否严格大于 4；首次满足的步号（从 1 起）即逃逸步数。
 * 模平方恰好等于 4 时不逃逸。
 *
 * @returns 首次逃逸步号（>=1）；预算内未逃逸返回 null
 */
export function escapeTime(cRe: number, cIm: number, maxIterations: number): number | null {
  let zRe = 0;
  let zIm = 0;
  for (let step = 1; step <= maxIterations; step++) {
    // z^2 = (a+bi)^2 = (a^2-b^2) + 2abi
    const nextRe = zRe * zRe - zIm * zIm + cRe;
    const nextIm = 2 * zRe * zIm + cIm;
    zRe = nextRe;
    zIm = nextIm;
    if (zRe * zRe + zIm * zIm > ESCAPE_MOD2_THRESHOLD) {
      return step;
    }
  }
  return null;
}

/**
 * 像素中心坐标映射（宽高为 1 时中心即矩形中点）：
 *   re(col) = reMin + (col + 0.5) * (reMax - reMin) / width
 *   im(row) = imMax - (row + 0.5) * (imMax - imMin) / height
 * 列从左到右实部增大；行从上到下虚部减小。边界不作为边缘像素中心。
 */
export function cellCoord(
  params: ComputeParams,
  col: number,
  row: number,
): { re: number; im: number } {
  const re = params.reMin + ((col + 0.5) * (params.reMax - params.reMin)) / params.width;
  const im = params.imMax - ((row + 0.5) * (params.imMax - params.imMin)) / params.height;
  return { re, im };
}

/** 计算完整网格，行优先返回每个格点结果。 */
export function computeGrid(params: ComputeParams): CellResult[] {
  const cells = new Array<CellResult>(params.width * params.height);
  let idx = 0;
  for (let row = 0; row < params.height; row++) {
    for (let col = 0; col < params.width; col++) {
      const { re, im } = cellCoord(params, col, row);
      const escapeStep = escapeTime(re, im, params.maxIterations);
      cells[idx++] = {
        col,
        row,
        re,
        im,
        escaped: escapeStep !== null,
        escapeStep,
      };
    }
  }
  return cells;
}

/**
 * 计算矩形子区域。子区域仍按“全图行列索引”取样：
 * 每个子格点先用全局列/行映射到原坐标，再做同一递推，
 * 因此把子区域结果放回原位置与整图计算逐点相同，不会因重新缩放产生另一套坐标。
 *
 * colStart/colEnd/rowStart/rowEnd 为全图索引，范围 [start, end)。
 */
export function computeSubgrid(
  params: ComputeParams,
  bounds: { colStart: number; colEnd: number; rowStart: number; rowEnd: number },
): CellResult[] {
  const { colStart, colEnd, rowStart, rowEnd } = bounds;
  for (const [name, v] of Object.entries(bounds)) {
    if (!Number.isInteger(v) || v < 0) {
      throw invalidDimensions(`${name} 必须是非负整数`);
    }
  }
  if (colEnd <= colStart || rowEnd <= rowStart) {
    throw invalidDimensions('子区域宽高必须至少为 1（要求 end > start）');
  }
  if (colEnd > params.width || rowEnd > params.height) {
    throw invalidDimensions('子区域超出全图网格范围');
  }
  const out: CellResult[] = [];
  for (let row = rowStart; row < rowEnd; row++) {
    for (let col = colStart; col < colEnd; col++) {
      const { re, im } = cellCoord(params, col, row);
      const escapeStep = escapeTime(re, im, params.maxIterations);
      out.push({ col, row, re, im, escaped: escapeStep !== null, escapeStep });
    }
  }
  return out;
}

/**
 * 单点迭代轨迹。返回 z0..zN（含），最后一个点为首次逃逸点或预算终点。
 */
export function trajectory(cRe: number, cIm: number, maxIterations: number): Trajectory {
  if (!Number.isFinite(cRe) || !Number.isFinite(cIm)) {
    throw invalidRange('c 的实部与虚部必须是有限数值');
  }
  if (
    !Number.isInteger(maxIterations) ||
    maxIterations < LIMITS.MIN_ITERATIONS ||
    maxIterations > LIMITS.MAX_ITERATIONS
  ) {
    throw invalidDimensions(
      `maxIterations 必须是 [${LIMITS.MIN_ITERATIONS}, ${LIMITS.MAX_ITERATIONS}] 内的整数`,
    );
  }
  const points: TrajectoryPoint[] = [
    { step: 0, zRe: 0, zIm: 0, mod2: 0, escaped: false },
  ];
  let zRe = 0;
  let zIm = 0;
  let escapeStep: number | null = null;
  for (let step = 1; step <= maxIterations; step++) {
    const nextRe = zRe * zRe - zIm * zIm + cRe;
    const nextIm = 2 * zRe * zIm + cIm;
    zRe = nextRe;
    zIm = nextIm;
    const mod2 = zRe * zRe + zIm * zIm;
    const escaped = mod2 > ESCAPE_MOD2_THRESHOLD;
    points.push({ step, zRe, zIm, mod2, escaped });
    if (escaped) {
      escapeStep = step;
      break;
    }
  }
  return {
    re: cRe,
    im: cIm,
    maxIterations,
    finalStatus: escapeStep === null ? 'bounded-within-budget' : 'escaped',
    escapeStep,
    points,
  };
}
