import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AppError } from './errors.js';
import { encodePGM } from './pgm.js';
import { computeGrid, computeSubgrid, escapeTime, trajectory, validateParams, cellCoord } from './mandelbrot.js';
import { Storage, configId } from './storage.js';

export interface ServiceOptions {
  dataDir: string;
  port: number;
}

/** 让操作系统分配空闲端口。 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('无法获取空闲端口')));
      }
    });
    srv.on('error', reject);
  });
}

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
};

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new AppError('VALIDATION_ERROR', 400, '请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (raw.length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AppError('INVALID_JSON', 400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });

export function createApp(storage: Storage): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (method === 'GET' && (path === '/' || path === '/health')) {
        return sendJson(res, 200, { ok: true, service: 'mandelbrot-escape-service' });
      }

      // 创建配置并计算网格
      if (method === 'POST' && path === '/configs') {
        const body = await readBody(req);
        const params = validateParams(body);
        const id = configId(params);
        let summary = storage.get(id);
        if (!summary) {
          const cells = computeGrid(params);
          summary = storage.save(params, cells);
        }
        return sendJson(res, 201, {
          coordinateMapping: {
            re: 're(col) = reMin + (col + 0.5) * (reMax - reMin) / width',
            im: 'im(row) = imMax - (row + 0.5) * (imMax - imMin) / height',
          },
          summary,
        });
      }

      // 历史列表
      if (method === 'GET' && path === '/configs') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? '50') || 50, 500);
        return sendJson(res, 200, { configs: storage.list(limit) });
      }

      const cfgMatch = path.match(/^\/configs\/([A-Za-z0-9]+)$/);
      if (cfgMatch) {
        if (method !== 'GET') throw new AppError('METHOD_NOT_ALLOWED', 405, '仅支持 GET');
        const summary = storage.get(cfgMatch[1]!);
        if (!summary) throw new AppError('NOT_FOUND', 404, '配置不存在（可能从未完整生成或 ID 错误）');
        return sendJson(res, 200, { summary });
      }

      const cellsMatch = path.match(/^\/configs\/([A-Za-z0-9]+)\/cells$/);
      if (cellsMatch) {
        if (method !== 'GET') throw new AppError('METHOD_NOT_ALLOWED', 405, '仅支持 GET');
        const id = cellsMatch[1]!;
        if (!storage.get(id)) throw new AppError('NOT_FOUND', 404, '配置不存在');
        const cells = storage.getAllCells(id)!;
        return sendJson(res, 200, {
          coordinateMapping: {
            re: 're(col) = reMin + (col + 0.5) * (reMax - reMin) / width',
            im: 'im(row) = imMax - (row + 0.5) * (imMax - imMin) / height',
          },
          cells,
        });
      }

      const cellMatch = path.match(/^\/configs\/([A-Za-z0-9]+)\/cell$/);
      if (cellMatch) {
        if (method !== 'GET') throw new AppError('METHOD_NOT_ALLOWED', 405, '仅支持 GET');
        const id = cellMatch[1]!;
        const summary = storage.get(id);
        if (!summary) throw new AppError('NOT_FOUND', 404, '配置不存在');
        const col = Number(url.searchParams.get('col'));
        const row = Number(url.searchParams.get('row'));
        if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0) {
          throw new AppError('VALIDATION_ERROR', 400, 'col 与 row 必须是非负整数');
        }
        if (col >= summary.params.width || row >= summary.params.height) {
          throw new AppError('VALIDATION_ERROR', 400, '坐标超出网格范围', {
            width: summary.params.width,
            height: summary.params.height,
          });
        }
        return sendJson(res, 200, { cell: storage.getCell(id, col, row) });
      }

      // 矩形子区域：仍按全图行列索引取样
      const subMatch = path.match(/^\/configs\/([A-Za-z0-9]+)\/subgrid$/);
      if (subMatch) {
        if (method !== 'POST') throw new AppError('METHOD_NOT_ALLOWED', 405, '仅支持 POST');
        const id = subMatch[1]!;
        const summary = storage.get(id);
        if (!summary) throw new AppError('NOT_FOUND', 404, '配置不存在');
        const body = (await readBody(req)) as Record<string, unknown>;
        const ints = ['colStart', 'colEnd', 'rowStart', 'rowEnd'].map((k) => Number(body[k]));
        if (ints.some((v) => !Number.isInteger(v))) {
          throw new AppError('VALIDATION_ERROR', 400, 'colStart/colEnd/rowStart/rowEnd 必须为整数');
        }
        const cells = computeSubgrid(summary.params, {
          colStart: ints[0]!, colEnd: ints[1]!, rowStart: ints[2]!, rowEnd: ints[3]!,
        });
        return sendJson(res, 200, {
          globalBounds: { colStart: ints[0], colEnd: ints[1], rowStart: ints[2], rowEnd: ints[3] },
          coordinateMapping: '复用全图索引：re(col)/im(row) 公式与整图一致，不重新缩放',
          cells,
        });
      }

      // 导出 JSON
      const jsonMatch = path.match(/^\/configs\/([A-Za-z0-9]+)\/export\/json$/);
      if (jsonMatch) {
        if (method !== 'GET') throw new AppError('METHOD_NOT_ALLOWED', 405, '仅支持 GET');
        const id = jsonMatch[1]!;
        const summary = storage.get(id);
        if (!summary) throw new AppError('NOT_FOUND', 404, '配置不存在');
        const cells = storage.getAllCells(id)!;
        res.setHeader('content-disposition', `attachment; filename="mandelbrot-${id}.json"`);
        return sendJson(res, 200, {
          note: 'escapeStep=null 表示本次预算内未逃逸，是数值观察而非集合成员证明',
          summary,
          coordinateMapping: {
            re: 're(col) = reMin + (col + 0.5) * (reMax - reMin) / width',
            im: 'im(row) = imMax - (row + 0.5) * (imMax - imMin) / height',
          },
          cells,
        });
      }

      // 导出灰度 PGM
      const pgmMatch = path.match(/^\/configs\/([A-Za-z0-9]+)\/export\/pgm$/);
      if (pgmMatch) {
        if (method !== 'GET') throw new AppError('METHOD_NOT_ALLOWED', 405, '仅支持 GET');
        const id = pgmMatch[1]!;
        const summary = storage.get(id);
        if (!summary) throw new AppError('NOT_FOUND', 404, '配置不存在');
        const cells = storage.getAllCells(id)!;
        const buf = encodePGM(summary, cells);
        res.writeHead(200, {
          'content-type': 'image/x-portable-graymap',
          'content-disposition': `attachment; filename="mandelbrot-${id}.pgm"`,
        });
        return res.end(buf);
      }

      // 单点轨迹（不依赖已保存配置）
      if (method === 'POST' && path === '/trajectory') {
        const body = (await readBody(req)) as Record<string, unknown>;
        const re = Number(body.re);
        const im = Number(body.im ?? 0);
        const maxIterations = Number(body.maxIterations);
        return sendJson(res, 200, { trajectory: trajectory(re, im, maxIterations) });
      }

      // 单点快速逃逸步数（不落库）
      if (method === 'POST' && path === '/escape-time') {
        const body = (await readBody(req)) as Record<string, unknown>;
        const re = Number(body.re);
        const im = Number(body.im ?? 0);
        const maxIterations = Number(body.maxIterations);
        if (![re, im, maxIterations].every(Number.isFinite)) {
          throw new AppError('VALIDATION_ERROR', 400, 're/im/maxIterations 必须是有限数值');
        }
        if (!Number.isInteger(maxIterations) || maxIterations < 1) {
          throw new AppError('VALIDATION_ERROR', 400, 'maxIterations 必须是正整数');
        }
        const step = escapeTime(re, im, maxIterations);
        return sendJson(res, 200, {
          re, im, maxIterations,
          escaped: step !== null,
          escapeStep: step,
          note: step === null ? '本次预算内未逃逸（非集合成员证明）' : undefined,
        });
      }

      throw new AppError('NOT_FOUND', 404, `未知路径 ${path}`);
    } catch (err) {
      if (err instanceof AppError) {
        return sendJson(res, err.status, { error: { code: err.code, message: err.message, details: err.details } });
      }
      const message = err instanceof Error ? err.message : String(err);
      return sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message } });
    }
  });
}

async function main(): Promise<void> {
  const dataDir = process.env.MANDEL_DATA_DIR ?? join(process.cwd(), 'data');
  const requested = process.env.PORT ? Number(process.env.PORT) : 0;
  const port = Number.isInteger(requested) && requested > 0 ? requested : await pickFreePort();
  const storage = new Storage(join(dataDir, 'mandelbrot.db'));
  const server = createApp(storage);
  server.listen(port, '127.0.0.1', () => {
    console.log(`Mandelbrot 服务已启动: http://127.0.0.1:${port}`);
    console.log(`数据目录: ${dataDir}`);
  });
}

// 仅作为入口直接运行时启动服务（供测试导入 createApp 时不自动监听）
const isMain = (() => {
  try {
    return process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
