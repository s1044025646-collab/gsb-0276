import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ALGORITHM_VERSION, type GridConfig, type GridStatus } from "../core/types.js";

export interface GridRow extends GridConfig {
  status: GridStatus;
  computedCells: number;
  escapedCells: number;
  unresolvedCells: number;
  iterationsPerformed: number;
  createdAt: string;
  updatedAt: string;
}

/** 未计算/未逃逸的 Int16 存储约定。 */
export const CELL_PENDING = -1;
export const CELL_UNRESOLVED = 0;

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS grids (
        id TEXT PRIMARY KEY,
        x_min REAL NOT NULL,
        x_max REAL NOT NULL,
        y_min REAL NOT NULL,
        y_max REAL NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        max_iterations INTEGER NOT NULL,
        total_iteration_budget INTEGER,
        algorithm_version TEXT NOT NULL,
        status TEXT NOT NULL,
        computed_cells INTEGER NOT NULL,
        escaped_cells INTEGER NOT NULL,
        unresolved_cells INTEGER NOT NULL,
        iterations_performed INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cells (
        grid_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        escape_step INTEGER NOT NULL,
        PRIMARY KEY (grid_id, idx)
      ) WITHOUT ROWID;
    `);
  }

  close(): void {
    this.db.close();
  }

  createGrid(cfg: GridConfig): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO grids (id, x_min, x_max, y_min, y_max, width, height, max_iterations,
          total_iteration_budget, algorithm_version, status, computed_cells, escaped_cells,
          unresolved_cells, iterations_performed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'budget_exhausted', 0, 0, 0, 0, ?, ?)`,
      )
      .run(
        cfg.id, cfg.xMin, cfg.xMax, cfg.yMin, cfg.yMax, cfg.width, cfg.height,
        cfg.maxIterations, cfg.totalIterationBudget, cfg.algorithmVersion, now, now,
      );
  }

  getGrid(id: string): GridRow | null {
    const r = this.db.prepare("SELECT * FROM grids WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? this.toRow(r) : null;
  }

  listGrids(limit: number): GridRow[] {
    const rows = this.db.prepare("SELECT * FROM grids ORDER BY created_at DESC, id ASC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.toRow(r));
  }

  /** 写入一批格点并更新累计统计。 */
  writeCells(
    id: string,
    entries: { idx: number; escapeStep: number }[],
    delta: { computed: number; escaped: number; unresolved: number; iterations: number },
  ): void {
    const insert = this.db.prepare(
      "INSERT INTO cells (grid_id, idx, escape_step) VALUES (?, ?, ?) ON CONFLICT(grid_id, idx) DO UPDATE SET escape_step = excluded.escape_step",
    );
    const tx = this.db.prepare(
      `UPDATE grids SET computed_cells = computed_cells + ?,
         escaped_cells = escaped_cells + ?, unresolved_cells = unresolved_cells + ?,
         iterations_performed = iterations_performed + ?, updated_at = ? WHERE id = ?`,
    );
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const e of entries) {
        insert.run(id, e.idx, e.escapeStep);
      }
      tx.run(delta.computed, delta.escaped, delta.unresolved, delta.iterations, now, id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  markStatus(id: string, status: GridStatus): void {
    this.db.prepare("UPDATE grids SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
  }

  /** 读取格点 escapeStep：null=尚未计算；0=预算内未逃逸；>=1=首次逃逸步号。 */
  getCell(id: string, idx: number): number | null {
    const r = this.db.prepare("SELECT escape_step FROM cells WHERE grid_id = ? AND idx = ?").get(id, idx) as { escape_step?: number } | undefined;
    return r?.escape_step ?? null;
  }

  /** 按行优先顺序读取连续区域；未计算项为 null。 */
  getRegion(id: string, indices: number[]): (number | null)[] {
    const stmt = this.db.prepare("SELECT escape_step FROM cells WHERE grid_id = ? AND idx = ?");
    return indices.map((idx) => {
      const r = stmt.get(id, idx) as { escape_step?: number } | undefined;
      return r?.escape_step ?? null;
    });
  }

  /** 返回已持久化格点的索引集合（用于续算时跳过）。 */
  getExistingIndices(id: string, fromIdx = 0): Set<number> {
    const rows = this.db.prepare("SELECT idx FROM cells WHERE grid_id = ? AND idx >= ?").all(id, fromIdx) as { idx: number }[];
    return new Set(rows.map((r) => r.idx));
  }

  private toRow(r: Record<string, unknown>): GridRow {
    return {
      id: r["id"] as string,
      xMin: r["x_min"] as number,
      xMax: r["x_max"] as number,
      yMin: r["y_min"] as number,
      yMax: r["y_max"] as number,
      width: r["width"] as number,
      height: r["height"] as number,
      maxIterations: r["max_iterations"] as number,
      totalIterationBudget: (r["total_iteration_budget"] as number | null) ?? null,
      algorithmVersion: r["algorithm_version"] as string,
      status: r["status"] as GridStatus,
      computedCells: r["computed_cells"] as number,
      escapedCells: r["escaped_cells"] as number,
      unresolvedCells: r["unresolved_cells"] as number,
      iterationsPerformed: r["iterations_performed"] as number,
      createdAt: r["created_at"] as string,
      updatedAt: r["updated_at"] as string,
    };
  }
}

export { ALGORITHM_VERSION };
