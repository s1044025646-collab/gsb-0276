#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { encodePGM } from './pgm.js';
import { computeGrid, computeSubgrid, trajectory, validateParams } from './mandelbrot.js';
import { Storage, configId } from './storage.js';
import { AppError } from './errors.js';

const usage = `
Mandelbrot 逃逸时间计算 CLI

用法:
  mandel create  --reMin --reMax --imMin --imMax --width --height --maxIterations
                 [--dataDir <目录>]
  mandel list    [--dataDir <目录>]
  mandel get     --id <配置ID> [--dataDir <目录>]
  mandel cell    --id <配置ID> --col <n> --row <n> [--dataDir <目录>]
  mandel subgrid --id <配置ID> --colStart --colEnd --rowStart --rowEnd [--dataDir <目录>]
  mandel trace   --re <实部> --im <虚部> --maxIterations <n>
  mandel export  --id <配置ID> --format json|pgm --out <文件> [--dataDir <目录>]

示例:
  mandel create --reMin -2.5 --reMax 1 --imMin -1.25 --imMax 1.25 --width 80 --height 40 --maxIterations 200
  mandel trace --re 1 --im 0 --maxIterations 10
`;

function parseArgs(argv: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        m.set(a.slice(2), next);
        i++;
      } else {
        m.set(a.slice(2), 'true');
      }
    }
  }
  return m;
}

const num = (args: Map<string, string>, key: string): number => {
  const v = Number(args.get(key));
  if (!Number.isFinite(v)) throw new AppError('VALIDATION_ERROR', 400, `缺少或非法参数 --${key}`);
  return v;
};

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const dataDir = args.get('dataDir') ? resolve(args.get('dataDir')!) : join(process.cwd(), 'data');

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(usage + '\n');
    return;
  }

  if (cmd === 'trace') {
    const result = trajectory(num(args, 're'), num(args, 'im'), num(args, 'maxIterations'));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  const storage = new Storage(join(dataDir, 'mandelbrot.db'));
  try {
    if (cmd === 'create') {
      const params = validateParams({
        reMin: num(args, 'reMin'),
        reMax: num(args, 'reMax'),
        imMin: num(args, 'imMin'),
        imMax: num(args, 'imMax'),
        width: num(args, 'width'),
        height: num(args, 'height'),
        maxIterations: num(args, 'maxIterations'),
      });
      const id = configId(params);
      let summary = storage.get(id);
      if (!summary) {
        summary = storage.save(params, computeGrid(params));
      }
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      return;
    }

    if (cmd === 'list') {
      process.stdout.write(JSON.stringify({ configs: storage.list() }, null, 2) + '\n');
      return;
    }

    const id = args.get('id');
    if (!id) throw new AppError('VALIDATION_ERROR', 400, '需要 --id <配置ID>');

    if (cmd === 'get') {
      const summary = storage.get(id);
      if (!summary) throw new AppError('NOT_FOUND', 404, '配置不存在');
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      return;
    }

    if (cmd === 'cell') {
      const summary = storage.get(id);
      if (!summary) throw new AppError('NOT_FOUND', 404, '配置不存在');
      const col = num(args, 'col');
      const row = num(args, 'row');
      if (col < 0 || row < 0 || col >= summary.params.width || row >= summary.params.height) {
        throw new AppError('VALIDATION_ERROR', 400, '格点坐标超出范围');
      }
      process.stdout.write(JSON.stringify(storage.getCell(id, col, row), null, 2) + '\n');
      return;
    }

    if (cmd === 'subgrid') {
      const summary = storage.get(id);
      if (!summary) throw new AppError('NOT_FOUND', 404, '配置不存在');
      const cells = computeSubgrid(summary.params, {
        colStart: num(args, 'colStart'),
        colEnd: num(args, 'colEnd'),
        rowStart: num(args, 'rowStart'),
        rowEnd: num(args, 'rowEnd'),
      });
      process.stdout.write(JSON.stringify({ cells }, null, 2) + '\n');
      return;
    }

    if (cmd === 'export') {
      const summary = storage.get(id);
      if (!summary) throw new AppError('NOT_FOUND', 404, '配置不存在');
      const cells = storage.getAllCells(id)!;
      const format = args.get('format') ?? 'json';
      const out = args.get('out');
      if (!out) throw new AppError('VALIDATION_ERROR', 400, '需要 --out <文件>');
      mkdirSync(dirname(resolve(out)), { recursive: true });
      if (format === 'json') {
        writeFileSync(resolve(out), JSON.stringify({
          note: 'escapeStep=null 表示本次预算内未逃逸，是数值观察而非集合成员证明',
          summary,
          cells,
        }, null, 2));
      } else if (format === 'pgm') {
        writeFileSync(resolve(out), encodePGM(summary, cells));
      } else {
        throw new AppError('VALIDATION_ERROR', 400, '--format 只能是 json 或 pgm');
      }
      process.stdout.write(`已导出 ${format}: ${resolve(out)}\n`);
      return;
    }

    process.stderr.write(usage + '\n');
    process.exitCode = 1;
  } finally {
    storage.close();
  }
}

try {
  main();
} catch (err) {
  if (err instanceof AppError) {
    process.stderr.write(`错误 [${err.code}] ${err.message}\n`);
    process.exit(err.status === 404 ? 2 : 1);
  }
  throw err;
}
