import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../db/store.js";
import { MandelbrotService } from "../core/service.js";
import { exportJson, exportPgm } from "../core/exporter.js";
import { AppError, errorBody } from "../core/errors.js";
import { ALGORITHM_VERSION, LIMITS } from "../core/types.js";
import type { GridRow } from "../db/store.js";

const DATA_DIR = process.env["MANDEL_DATA_DIR"] ?? join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "mandelbrot.sqlite");

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("无法获取空闲端口")));
      }
    });
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1_048_576) {
      throw new AppError("BAD_REQUEST", "请求体过大（上限 1 MiB）", 413);
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError("BAD_REQUEST", "请求体必须是 JSON 对象", 400);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

export function createApp(store: Store): Server {
  const service = new MandelbrotService(store);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    void (async (): Promise<void> => {
      try {
        if (method === "GET" && path === "/api/v1/health") {
          sendJson(res, 200, { ok: true, algorithmVersion: ALGORITHM_VERSION, limits: LIMITS });
          return;
        }
        if (method === "POST" && path === "/api/v1/grids") {
          const body = await readJson(req);
          const grid = service.createConfig(body);
          sendJson(res, 201, { grid: serializeGrid(grid), summary: service.summary(grid) });
          return;
        }
        if (method === "GET" && path === "/api/v1/grids") {
          const limit = Number(url.searchParams.get("limit") ?? "50");
          const rows = service.listGrids(Number.isFinite(limit) ? limit : 50);
          sendJson(res, 200, { grids: rows.map(serializeGrid) });
          return;
        }

        const gridMatch = path.match(/^\/api\/v1\/grids\/([^/]+)(\/(compute|cell|trajectory|region|export(?:\/json|\/pgm)?))?$/);
        if (gridMatch) {
          const id = decodeURIComponent(gridMatch[1]!);
          const action = (gridMatch[3] ?? "").replace(/^\//, "");
          if (action === "" && method === "GET") {
            const grid = service.getGrid(id);
            sendJson(res, 200, { grid: serializeGrid(grid), summary: service.summary(grid) });
            return;
          }
          if (action === "compute" && method === "POST") {
            const grid = service.compute(id);
            sendJson(res, 200, { grid: serializeGrid(grid), summary: service.summary(grid) });
            return;
          }
          if (action === "cell" && method === "GET") {
            const row = Number(url.searchParams.get("row"));
            const col = Number(url.searchParams.get("col"));
            sendJson(res, 200, service.getCell(id, row, col));
            return;
          }
          if (action === "trajectory" && method === "GET") {
            const row = Number(url.searchParams.get("row"));
            const col = Number(url.searchParams.get("col"));
            sendJson(res, 200, service.getTrajectory(id, row, col));
            return;
          }
          if (action === "region" && method === "POST") {
            const body = await readJson(req);
            sendJson(res, 200, service.getRegion(id, body));
            return;
          }
          if ((action === "export" || action === "export/json") && method === "GET") {
            const grid = service.getGrid(id);
            sendJson(res, 200, exportJson(store, grid));
            return;
          }
          if (action === "export/pgm" && method === "GET") {
            const grid = service.getGrid(id);
            const pgm = exportPgm(store, grid);
            res.writeHead(200, {
              "content-type": "image/x-portable-graymap",
              "content-disposition": `attachment; filename="mandelbrot-${id}.pgm"`,
              "content-length": pgm.length,
            });
            res.end(pgm);
            return;
          }
        }

        sendJson(res, 404, errorBody("NOT_FOUND", `未找到路由：${method} ${path}`));
      } catch (err) {
        if (err instanceof AppError) {
          sendJson(res, err.httpStatus, errorBody(err.code, err.message));
        } else {
          sendJson(res, 500, errorBody("BAD_REQUEST", err instanceof Error ? err.message : "内部错误"));
        }
      }
    })();
  });

  return server;
}

function serializeGrid(g: GridRow) {
  return {
    id: g.id,
    bounds: { xMin: g.xMin, xMax: g.xMax, yMin: g.yMin, yMax: g.yMax },
    dimensions: { width: g.width, height: g.height },
    maxIterations: g.maxIterations,
    totalIterationBudget: g.totalIterationBudget,
    algorithmVersion: g.algorithmVersion,
    status: g.status,
    computedCells: g.computedCells,
    totalCells: g.width * g.height,
    escapedCells: g.escapedCells,
    unresolvedCells: g.unresolvedCells,
    iterationsPerformed: g.iterationsPerformed,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

async function main(): Promise<void> {
  const requested = process.env["PORT"] ?? process.argv[2];
  const port = requested ? Number(requested) : await findFreePort();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`非法端口：${requested}`);
  }
  const store = new Store(DB_PATH);
  const server = createApp(store);
  server.listen(port, "127.0.0.1", () => {
    console.log(`Mandelbrot 逃逸网格服务已启动`);
    console.log(`  地址:   http://127.0.0.1:${port}`);
    console.log(`  数据:   ${DB_PATH}`);
    console.log(`  算法:   ${ALGORITHM_VERSION}`);
  });

  const shutdown = (): void => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
