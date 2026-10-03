import { join } from 'node:path';
import { escapeTime, computeGrid, computeSubgrid, trajectory, cellCoord } from './mandelbrot.js';
import { Storage, configId } from './storage.js';
import { encodePGM } from './pgm.js';
import { mkdirSync, writeFileSync } from 'node:fs';

const line = (s: string) => console.log(`\n=== ${s} ===`);

function main(): void {
  const dataDir = join(process.cwd(), 'data');
  const outDir = join(process.cwd(), 'exports');
  mkdirSync(outDir, { recursive: true });
  const storage = new Storage(join(dataDir, 'mandelbrot.db'));

  line('1. 手算点核对（预算 10）');
  for (const [label, re, im] of [
    ['c=0', 0, 0],
    ['c=-1', -1, 0],
    ['c=1', 1, 0],
    ['c=2', 2, 0],
  ] as const) {
    const step = escapeTime(re, im, 10);
    console.log(`${label.padEnd(6)} -> ${step === null ? '预算内未逃逸' : `第 ${step} 步首次逃逸`}`);
  }

  line('2. c=1 单点轨迹（应在第 3 步逃逸）');
  console.log(JSON.stringify(trajectory(1, 0, 10).points, null, 0));

  line('3. 创建整图并入库');
  const params = {
    reMin: -2.5, reMax: 1, imMin: -1.25, imMax: 1.25,
    width: 160, height: 80, maxIterations: 100,
  };
  const id = configId(params);
  let summary = storage.get(id);
  if (!summary) summary = storage.save(params, computeGrid(params));
  console.log(`ID=${summary.id}  逃逸=${summary.escapedCount}  预算内未逃逸=${summary.boundedCount}`);

  line('4. 子区域拼接一致性（四块拼回应等于整图）');
  const { width, height } = params;
  const halfW = width >> 1;
  const halfH = height >> 1;
  const blocks = [
    { colStart: 0, colEnd: halfW, rowStart: 0, rowEnd: halfH },
    { colStart: halfW, colEnd: width, rowStart: 0, rowEnd: halfH },
    { colStart: 0, colEnd: halfW, rowStart: halfH, rowEnd: height },
    { colStart: halfW, colEnd: width, rowStart: halfH, rowEnd: height },
  ];
  const full = computeGrid(params);
  let mismatch = 0;
  for (const b of blocks) {
    const sub = computeSubgrid(params, b);
    for (const c of sub) {
      const ref = full[c.row * width + c.col]!;
      if (ref.escapeStep !== c.escapeStep) mismatch++;
    }
  }
  console.log(mismatch === 0 ? '四块子区域与整图逐点一致 ✓' : `发现 ${mismatch} 处不一致 ✗`);

  line('5. 提高迭代上限使部分未决点得到逃逸结论');
  const low = { ...params, maxIterations: 20 };
  const high = { ...params, maxIterations: 400 };
  const gLow = computeGrid(low);
  const gHigh = computeGrid(high);
  let resolved = 0;
  const examples: string[] = [];
  for (let i = 0; i < gLow.length; i++) {
    if (gLow[i]!.escapeStep === null && gHigh[i]!.escapeStep !== null) {
      resolved++;
      if (examples.length < 3) examples.push(`(${gHigh[i]!.col},${gHigh[i]!.row}) 第${gHigh[i]!.escapeStep}步逃逸`);
    }
  }
  console.log(`提高上限后新增逃逸点: ${resolved}，例: ${examples.join('; ')}`);

  line('6. 导出 JSON 与灰度 PGM');
  const cells = storage.getAllCells(summary.id)!;
  writeFileSync(join(outDir, `mandelbrot-${summary.id}.json`), JSON.stringify({ summary, cells }));
  writeFileSync(join(outDir, `mandelbrot-${summary.id}.pgm`), encodePGM(summary, cells));
  console.log(`exports/mandelbrot-${summary.id}.json`);
  console.log(`exports/mandelbrot-${summary.id}.pgm`);

  line('7. 重启后复查（重新打开数据库读取同一 ID）');
  storage.close();
  const reopened = new Storage(join(dataDir, 'mandelbrot.db'));
  const again = reopened.get(id);
  console.log(again ? `重启后读回 ID=${again.id} 状态=${again.status} 格点数=${again.cellCount} ✓` : '读回失败 ✗');
  const center = cellCoord(params, 0, 0);
  console.log(`左上角像素中心坐标 = (${center.re.toFixed(4)}, ${center.im.toFixed(4)})`);
  reopened.close();
}

main();
