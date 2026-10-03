// 端到端演示：创建配置 -> 完整计算 -> 手算点 -> 提高预算 -> 子区域 -> 轨迹 -> 导出 PGM -> 重启复查。
// 仅依赖本项目构建产物（先执行 npm run build）。
import { rmSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist", "cli", "index.js");
const dataDir = mkdtempSync(join(tmpdir(), "mandel-demo-"));
const env = { ...process.env, MANDEL_DATA_DIR: dataDir };

function run(args) {
  const out = execFileSync(process.execPath, ["--experimental-sqlite", cli, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out);
}

function runRaw(args) {
  return execFileSync(process.execPath, ["--experimental-sqlite", cli, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const say = (msg) => console.log(`\n=== ${msg} ===`);

say("1. 创建网格配置 [-2,1] x [-1.5,1.5]，24x18，最大迭代 60");
const created = run([
  "create", "--x-min", "-2", "--x-max", "1", "--y-min", "-1.5", "--y-max", "1.5",
  "--width", "24", "--height", "18", "--max-iter", "60",
]);
const id = created.grid.id;
console.log("gridId =", id, " 初始状态 =", created.grid.status);

say("2. 计算整图");
const done = run(["compute", id]);
console.log(
  `状态=${done.grid.status} 已算=${done.summary.computedCells}/${done.summary.totalCells} ` +
  `逃逸=${done.summary.escapedCells} 预算内未逃逸=${done.summary.unresolvedCells}`,
);

say("3. 手算点核对（直接调用核心函数）");
const core = await import(pathToFileURL(join(root, "dist", "core", "mandelbrot.js")).href);
for (const [re, im, expect] of [[0, 0, null], [-1, 0, null], [1, 0, 3], [2, 0, 2]]) {
  const got = core.escapeTime(re, im, 100);
  console.log(`c=${re}${im >= 0 ? "+" : ""}${im}i -> ${got === null ? "预算内未逃逸" : "第 " + got + " 步逃逸"}（期望 ${expect === null ? "未逃逸" : "第 " + expect + " 步"}）`);
}

say("4. 提高迭代上限（120）生成新报告，对比未决点数");
const high = run([
  "create", "--x-min", "-2", "--x-max", "1", "--y-min", "-1.5", "--y-max", "1.5",
  "--width", "24", "--height", "18", "--max-iter", "120",
]);
const highDone = run(["compute", high.grid.id]);
console.log(`iter<=60 未决=${done.summary.unresolvedCells}；iter<=120 未决=${highDone.summary.unresolvedCells}`);

say("5. 单点轨迹（c 最接近原点的格点）");
const trace = run(["trace", id, "--row", "9", "--col", "12"]);
console.log(`格点(row=9,col=12) c=${trace.x.toFixed(4)}${trace.y >= 0 ? "+" : ""}${trace.y.toFixed(4)}i escaped=${trace.escaped}`);
for (const p of trace.points.slice(0, 6)) {
  console.log(`  z${p.step} = ${p.zReal.toFixed(5)} ${p.zImag >= 0 ? "+" : ""}${p.zImag.toFixed(5)}i  |z|^2=${p.normSquared.toFixed(5)}`);
}

say("6. 提取子区域（全图行列索引，不重新缩放）");
const region = run(["region", id, "--row-start", "4", "--col-start", "6", "--width", "4", "--height", "3"]);
console.log(`子区域 ${region.region.width}x${region.region.height}，坐标映射：${region.coordinateMapping.xFormula}`);

say("7. 导出 JSON 与灰度 PGM");
const pgmPath = join(root, "demo", "out", "mandelbrot.pgm");
rmSync(join(root, "demo", "out"), { recursive: true, force: true });
process.stdout.write(runRaw(["export", id, "--format", "pgm", "--out", pgmPath]));
const jsonPath = join(root, "demo", "out", "mandelbrot.json");
process.stdout.write(runRaw(["export", id, "--format", "json", "--out", jsonPath]));
console.log("PGM:", existsSync(pgmPath) ? pgmPath : "失败");
console.log("JSON:", existsSync(jsonPath) ? jsonPath : "失败");

say("8. 模拟重启：新进程读取历史并复查同一格点");
const historyText = runRaw(["list", "--limit", "5"]);
const cellBefore = run(["cell", id, "--row", "9", "--col", "12"]);
const cellAfter = run(["cell", id, "--row", "9", "--col", "12"]);
const historyCount = historyText.trim().split(/\r?\n/).filter(Boolean).length;
console.log(`历史报告=${historyCount} 份可读取；重启前后格点一致=${JSON.stringify(cellBefore) === JSON.stringify(cellAfter)}`);

say("9. 全局迭代预算演示（预算 2500，状态必须为 budget_exhausted）");
const budgeted = run([
  "create", "--x-min", "-0.2", "--x-max", "0.2", "--y-min", "-0.2", "--y-max", "0.2",
  "--width", "10", "--height", "10", "--max-iter", "1000", "--total-budget", "2500",
]);
const budgetedDone = run(["compute", budgeted.grid.id]);
console.log(`状态=${budgetedDone.grid.status} 已算=${budgetedDone.summary.computedCells}/100 已用迭代=${budgetedDone.summary.iterationsPerformed}（预算2500）`);

console.log("\n演示完成。数据目录（临时）：", dataDir);
