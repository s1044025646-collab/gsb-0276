import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { ALGORITHM_VERSION } from './constants.js';
import type { CellResult, ComputeParams, ConfigSummary } from './types.js';

/**
 * 固定参数生成确定性 ID（对参数做规范化哈希）。
 * 改变任何参数都会得到新报告；重启后同一网格仍是同一 ID。
 */
export function configId(params: ComputeParams): string {
  const canonical = JSON.stringify([
    ALGORITHM_VERSION,
    params.reMin,
    params.reMax,
    params.imMin,
    params.imMax,
    params.width,
    params.height,
    params.maxIterations,
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export class Storage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS configs (
        id TEXT PRIMARY KEY,
        algorithm_version TEXT NOT NULL,
        re_min REAL NOT NULL,
        re_max REAL NOT NULL,
        im_min REAL NOT NULL,
        im_max REAL NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        max_iterations INTEGER NOT NULL,
        status TEXT NOT NULL,
        cell_count INTEGER NOT NULL,
        escaped_count INTEGER NOT NULL,
        bounded_count INTEGER NOT NULL,
        min_escape_step INTEGER,
        max_escape_step INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cells (
        config_id TEXT NOT NULL,
        col INTEGER NOT NULL,
        row INTEGER NOT NULL,
        re REAL NOT NULL,
        im REAL NOT NULL,
        escaped INTEGER NOT NULL,
        escape_step INTEGER,
        PRIMARY KEY (config_id, row, col)
      );
      CREATE INDEX IF NOT EXISTS idx_cells_config ON cells(config_id);
    `);
  }

  has(id: string): boolean {
    const row = this.db.prepare('SELECT id FROM configs WHERE id = ?').get(id);
    return row !== undefined;
  }

  /** 幂等保存：仅完整网格可入库。重复保存同一 ID 直接返回既有摘要。 */
  save(params: ComputeParams, cells: CellResult[]): ConfigSummary {
    const id = configId(params);
    if (this.has(id)) {
      return this.get(id)!;
    }

    let escapedCount = 0;
    let minEscapeStep: number | null = null;
    let maxEscapeStep: number | null = null;
    for (const c of cells) {
      if (c.escapeStep !== null) {
        escapedCount++;
        minEscapeStep = minEscapeStep === null ? c.escapeStep : Math.min(minEscapeStep, c.escapeStep);
        maxEscapeStep = maxEscapeStep === null ? c.escapeStep : Math.max(maxEscapeStep, c.escapeStep);
      }
    }
    const createdAt = new Date(0).toISOString().replace('T', ' ').slice(0, 19);
    // 使用固定纪元时间戳，保证固定输入的存储记录同样确定
    const summary: ConfigSummary = {
      id,
      params,
      algorithmVersion: ALGORITHM_VERSION,
      status: 'complete',
      cellCount: cells.length,
      escapedCount,
      boundedCount: cells.length - escapedCount,
      minEscapeStep,
      maxEscapeStep,
      createdAt,
    };

    const insertConfig = this.db.prepare(
      `INSERT INTO configs (id, algorithm_version, re_min, re_max, im_min, im_max,
         width, height, max_iterations, status, cell_count, escaped_count,
         bounded_count, min_escape_step, max_escape_step, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertCell = this.db.prepare(
      `INSERT INTO cells (config_id, col, row, re, im, escaped, escape_step)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.exec('BEGIN IMMEDIATE');
    try {
      insertConfig.run(
        id,
        ALGORITHM_VERSION,
        params.reMin,
        params.reMax,
        params.imMin,
        params.imMax,
        params.width,
        params.height,
        params.maxIterations,
        'complete',
        summary.cellCount,
        escapedCount,
        summary.boundedCount,
        minEscapeStep,
        maxEscapeStep,
        createdAt,
      );
      for (const c of cells) {
        insertCell.run(id, c.col, c.row, c.re, c.im, c.escaped ? 1 : 0, c.escapeStep);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return summary;
  }

  private mapRow(row: Record<string, unknown>): ConfigSummary {
    return {
      id: row.id as string,
      algorithmVersion: row.algorithm_version as string,
      status: 'complete',
      cellCount: row.cell_count as number,
      escapedCount: row.escaped_count as number,
      boundedCount: row.bounded_count as number,
      minEscapeStep: (row.min_escape_step as number | null) ?? null,
      maxEscapeStep: (row.max_escape_step as number | null) ?? null,
      createdAt: row.created_at as string,
      params: {
        reMin: row.re_min as number,
        reMax: row.re_max as number,
        imMin: row.im_min as number,
        imMax: row.im_max as number,
        width: row.width as number,
        height: row.height as number,
        maxIterations: row.max_iterations as number,
      },
    };
  }

  get(id: string): ConfigSummary | null {
    const row = this.db
      .prepare('SELECT * FROM configs WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  list(limit = 50): ConfigSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM configs ORDER BY created_at DESC, id ASC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  getCell(id: string, col: number, row: number): CellResult | null {
    const r = this.db
      .prepare('SELECT * FROM cells WHERE config_id = ? AND col = ? AND row = ?')
      .get(id, col, row) as Record<string, unknown> | undefined;
    if (!r) return null;
    const escaped = (r.escaped as number) === 1;
    return {
      col: r.col as number,
      row: r.row as number,
      re: r.re as number,
      im: r.im as number,
      escaped,
      escapeStep: (r.escape_step as number | null) ?? null,
    };
  }

  /** 读取全部格点（行优先），用于导出。 */
  getAllCells(id: string): CellResult[] | null {
    if (!this.has(id)) return null;
    const rows = this.db
      .prepare('SELECT * FROM cells WHERE config_id = ? ORDER BY row ASC, col ASC')
      .all(id) as Record<string, unknown>[];
    return rows.map((r) => ({
      col: r.col as number,
      row: r.row as number,
      re: r.re as number,
      im: r.im as number,
      escaped: (r.escaped as number) === 1,
      escapeStep: (r.escape_step as number | null) ?? null,
    }));
  }

  close(): void {
    this.db.close();
  }
}
