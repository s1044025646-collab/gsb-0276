import type { CellResult, ConfigSummary } from './types.js';

/**
 * 导出灰度 PGM（P5 二进制，每像素 1 字节，最大灰度 255）。
 *
 * 公开的着色规则（仅影响图像展示，不改变原始 escapeStep）：
 *   - 本次预算内未逃逸：灰度 0（纯黑）
 *   - 已逃逸：灰度 = 255 - round(254 * (escapeStep - 1) / maxIterations)
 *     即第 1 步逃逸为近白(255)，越晚逃逸越暗；未逃逸为黑色，二者始终可区分。
 * 行从上到下，列从左到右，与网格行列一致。
 */
export function encodePGM(summary: ConfigSummary, cells: CellResult[]): Buffer {
  const { width, height, maxIterations } = summary.params;
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`, 'ascii');
  const body = Buffer.alloc(width * height);
  const scale = maxIterations - 1 > 0 ? maxIterations - 1 : 1;
  for (const c of cells) {
    let gray: number;
    if (c.escapeStep === null) {
      gray = 0;
    } else {
      gray = 255 - Math.round((254 * (c.escapeStep - 1)) / scale);
      if (gray < 1) gray = 1;
    }
    body[c.row * width + c.col] = gray;
  }
  return Buffer.concat([header, body]);
}
