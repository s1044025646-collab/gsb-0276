#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../db/store.js";
import { MandelbrotService } from "../core/service.js";
import { exportJson, exportPgm } from "../core/exporter.js";
import { AppError } from "../core/errors.js";
import { ALGORITHM_VERSION } from "../core/types.js";

const DATA_DIR = process.env["MANDEL_DATA_DIR"] ?? join(process.cwd(), "data");

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags.set(key, "true");
      } else {
        flags.set(key, next);
        i++;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function num(flags: Map<string, string>, key: string): number {
  const v = flags.get(key);
  if (v === undefined) {
    throw new AppError("BAD_REQUEST", `缺少参数 --${key}`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new AppError("BAD_REQUEST", `参数 --${key} 必须是数值`);
  }
  return n;
}

const HELP = `mandel — 离线 Mandelbrot 逃逸时间网格 CLI（算法 ${ALGORITHM_VERSION}）

用法:
  mandel create  --x-min --x-max --y-min --y-max --width --height --max-iter [--total-budget]
  mandel compute <gridId>
  mandel show    <gridId>
  mandel list    [--limit 50]
  mandel cell    <gridId> --row --col
  mandel trace   <gridId> --row --col
  mandel region  <gridId> --row-start --col-start --width --height
  mandel export  <gridId> --format json|pgm --out <文件路径>
  mandel serve   [--port 0]

坐标映射（像素中心取样）:
  x(col) = xMin + (col + 0.5) * (xMax - xMin) / width
  y(row) = yMax - (row + 0.5) * (yMax - yMin) / height

说明:
  escaped=false 仅表示在本次迭代预算内未观测到逃逸，并非集合成员证明。
  数据目录由环境变量 MANDEL_DATA_DIR 指定，默认 ./data。
`;

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }

  if (command === "serve") {
    process.env["PORT"] = flags.get("port") ?? process.env["PORT"];
    await import("../server/index.js");
    return;
  }

  const store = new Store(join(DATA_DIR, "mandelbrot.sqlite"));
  try {
    const service = new MandelbrotService(store);
    switch (command) {
      case "create": {
        const grid = service.createConfig({
          xMin: num(flags, "x-min"),
          xMax: num(flags, "x-max"),
          yMin: num(flags, "y-min"),
          yMax: num(flags, "y-max"),
          width: num(flags, "width"),
          height: num(flags, "height"),
          maxIterations: num(flags, "max-iter"),
          totalIterationBudget: flags.has("total-budget") ? num(flags, "total-budget") : null,
        });
        printGrid(service, grid.id);
        break;
      }
      case "compute": {
        const grid = service.compute(requireId(positional[1]));
        printGrid(service, grid.id);
        break;
      }
      case "show":
        printGrid(service, requireId(positional[1]));
        break;
      case "list": {
        const limit = flags.has("limit") ? num(flags, "limit") : 50;
        for (const g of service.listGrids(limit)) {
          process.stdout.write(
            `${g.id}  ${g.width}x${g.height}  iter<=${g.maxIterations}  ${g.status}  ` +
              `${g.computedCells}/${g.width * g.height}  escaped=${g.escapedCells}  unresolved=${g.unresolvedCells}\n`,
          );
        }
        break;
      }
      case "cell":
        console.log(JSON.stringify(service.getCell(requireId(positional[1]), num(flags, "row"), num(flags, "col")), null, 2));
        break;
      case "trace":
        console.log(JSON.stringify(service.getTrajectory(requireId(positional[1]), num(flags, "row"), num(flags, "col")), null, 2));
        break;
      case "region":
        console.log(
          JSON.stringify(
            service.getRegion(requireId(positional[1]), {
              rowStart: num(flags, "row-start"),
              colStart: num(flags, "col-start"),
              width: num(flags, "width"),
              height: num(flags, "height"),
            }),
            null,
            2,
          ),
        );
        break;
      case "export": {
        const id = requireId(positional[1]);
        const format = flags.get("format") ?? "json";
        const out = flags.get("out");
        const grid = service.getGrid(id);
        if (format === "json") {
          const body = JSON.stringify(exportJson(store, grid), null, 2);
          if (out) {
            writeOutput(out, Buffer.from(body, "utf8"));
            process.stdout.write(`已写入 ${resolve(out)}\n`);
          } else {
            process.stdout.write(body + "\n");
          }
        } else if (format === "pgm") {
          const pgm = exportPgm(store, grid);
          if (out) {
            writeOutput(out, pgm);
            process.stdout.write(`已写入 ${resolve(out)}\n`);
          } else {
            process.stdout.write("PGM 为二进制格式，请使用 --out <文件路径> 指定输出文件\n");
            process.exitCode = 1;
          }
        } else {
          throw new AppError("BAD_REQUEST", `不支持的导出格式：${format}（支持 json、pgm）`);
        }
        break;
      }
      default:
        throw new AppError("BAD_REQUEST", `未知命令：${command}\n\n${HELP}`);
    }
  } finally {
    store.close();
  }
}

function writeOutput(outPath: string, data: Buffer): void {
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  writeFileSync(resolve(outPath), data);
}

function requireId(id: string | undefined): string {
  if (!id) {
    throw new AppError("BAD_REQUEST", "缺少 gridId 参数");
  }
  return id;
}

function printGrid(service: MandelbrotService, id: string): void {
  console.log(JSON.stringify({ grid: service.getGrid(id), summary: service.summary(service.getGrid(id)) }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    if (err instanceof AppError) {
      process.stderr.write(`错误 [${err.code}] ${err.message}\n`);
    } else if (err instanceof Error) {
      process.stderr.write(`错误 ${err.message}\n`);
    }
    process.exit(1);
  });
}
