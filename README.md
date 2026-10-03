# Mandelbrot 逃逸网格服务（仅后端）

离线 Mandelbrot 集**逃逸时间**计算服务：输入复平面矩形、网格宽高和最大迭代次数，
输出每个网格点的首次逃逸步号，以及“本次预算内尚未逃逸”状态。

技术栈：TypeScript + Node.js（内置 `node:sqlite`，**零第三方运行时依赖**）。
仅提供数值 HTTP API、CLI 和静态数据导出（JSON / 灰度 PGM），
不包含网页、交互式画布、GPU 计算或高精度深度缩放。

## 重要概念：数值观察 ≠ 集合成员证明

- `escaped=true, escapeStep=k`：第 `k` 步首次逃逸，是确定的数值事实。
- `escaped=false`：在本次 `maxIterations` 预算内**未观测到逃逸**，记为“未决（unresolved）”。
  这**不等于**“该点已证明属于 Mandelbrot 集”；提高迭代上限后它可能逃逸。
- “最后一步才逃逸”（`escapeStep = maxIterations`）与“预算内未逃逸”是两种不同状态，
  存储与导出中严格区分，不会混为一谈。
- 本服务只报告有限双精度数值实验结果，不做集合归属的数学证明。

## 算法（固定确定性，无随机着色/平滑迭代）

对每个点 `c = x + yi`，`z0 = 0`，重复 `z = z² + c`：

```
nextReal = zReal² - zImag² + x
nextImag = 2 * zReal * zImag + y
zReal, zImag = nextReal, nextImag      // 两个新值都来自上一轮
若 zReal² + zImag² > 4（严格大于）→ 第 step 步首次逃逸（step 从 1 开始）
```

- 实部与虚部先同时算出再一起更新，不存在“先改实部再拿新实部算虚部”。
- 阈值是严格大于 4：模平方恰好等于 4 时**不算**逃逸（如 c=2 的第 1 步）。
- 手算基准：c=0、c=-1 有限预算内不逃逸；c=1 第 3 步逃逸；c=2 第 2 步逃逸。
- 算法版本标识：`escape-time-z0-v1`，随每份报告持久化。

## 坐标映射（像素中心取样）

```
x(col) = xMin + (col + 0.5) * (xMax - xMin) / width
y(row) = yMax - (row + 0.5) * (yMax - yMin) / height
```

- 列从左到右实部增加；行从上到下虚部减小。
- 矩形边界**不是**边缘像素中心；`width=1` 或 `height=1` 时取该方向中心。
- 子区域按**全图行列索引**取样（`rowStart/colStart/width/height`），
  不重新缩放坐标；子区域放回原位置与整图计算逐点相同。

## 参数上限与错误码

| 项目 | 上限 |
| --- | --- |
| 网格宽 / 高 | 4096 |
| 网格总点数 | 4,000,000 |
| 单点最大迭代 | 100,000 |
| 全局迭代预算 | 500,000,000 |
| 矩形最小跨度 | 1e-15（不做深度缩放） |

错误码（HTTP 响应体 `{ "error": { code, message } }`，CLI 以 `错误 [CODE]` 输出）：

| code | 含义 |
| --- | --- |
| `INVALID_RANGE` | 范围非有限数、xMax≤xMin/yMax≤yMin 或跨度过小 |
| `INVALID_DIMENSIONS` | 宽高非正整数或超上限 |
| `INVALID_BUDGET` | 迭代次数/全局预算非法 |
| `INVALID_REGION` | 行列索引非法或子区域越界 |
| `NOT_FOUND` | 网格/路由不存在 |
| `BAD_REQUEST` | 请求体非法等其他 4xx |

## 状态与持久化

SQLite 数据库（默认 `./data/mandelbrot.sqlite`，可用环境变量 `MANDEL_DATA_DIR` 改目录）：

- `grids`：范围、尺寸、预算、算法版本、状态与结果摘要；
- `cells`：每点逃逸步号（`0` = 预算内未逃逸，`≥1` = 首次逃逸步号，无记录 = 尚未计算）。

状态：

- `complete`：全部格点已计算；
- `budget_exhausted`：设置了全局迭代预算 `totalIterationBudget`，
  继续计算下一个点会超预算而提前停止。**绝不会**把不完整矩阵存成 complete。
  取消预算限制需新建配置；改变任何参数都会生成新的报告 id，旧报告保留可复查。

## 快速开始（Windows / PowerShell，无需 Docker、WSL 或联网服务）

要求 Node.js ≥ 22.5（需要内置 `node:sqlite`，本仓库在 Node 25 上验证）。

```powershell
npm install
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建 + 运行 20 个内置测试
npm run demo       # 端到端演示（CLI 全流程，含重启复查、预算中断、导出）
npm start          # 启动 HTTP 服务（默认自动选择空闲端口）
```

指定端口与数据目录：

```powershell
$env:PORT="8080"; $env:MANDEL_DATA_DIR="$PWD\data"; npm start
# 或：node --experimental-sqlite dist/server/index.js 8080
```

## CLI

```powershell
node --experimental-sqlite dist/cli/index.js help

# 1) 创建配置
node --experimental-sqlite dist/cli/index.js create `
  --x-min -2 --x-max 1 --y-min -1.5 --y-max 1.5 `
  --width 800 --height 600 --max-iter 200

# 2) 计算（可重复调用，断点续算；全局预算不足时返回 budget_exhausted）
node --experimental-sqlite dist/cli/index.js compute <gridId>

# 3) 查询格点 / 单点轨迹 / 子区域 / 历史
node --experimental-sqlite dist/cli/index.js show   <gridId>
node --experimental-sqlite dist/cli/index.js list
node --experimental-sqlite dist/cli/index.js cell   <gridId> --row 10 --col 20
node --experimental-sqlite dist/cli/index.js trace  <gridId> --row 10 --col 20
node --experimental-sqlite dist/cli/index.js region <gridId> --row-start 0 --col-start 0 --width 16 --height 8

# 4) 导出
node --experimental-sqlite dist/cli/index.js export <gridId> --format json --out out.json
node --experimental-sqlite dist/cli/index.js export <gridId> --format pgm  --out out.pgm
```

## HTTP API（前缀 `/api/v1`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查、算法版本与上限 |
| POST | `/grids` | 创建配置（JSON 同 CLI 参数：`xMin,xMax,yMin,yMax,width,height,maxIterations,totalIterationBudget?`） |
| GET | `/grids?limit=50` | 历史报告列表 |
| GET | `/grids/:id` | 配置与结果摘要 |
| POST | `/grids/:id/compute` | 继续计算整图 |
| GET | `/grids/:id/cell?row=&col=` | 查询单个格点 |
| GET | `/grids/:id/trajectory?row=&col=` | 单点迭代轨迹（z₁..zₖ） |
| POST | `/grids/:id/region` | 子区域，请求体 `{rowStart,colStart,width,height}` |
| GET | `/grids/:id/export/json` | 导出原始计算矩阵 JSON |
| GET | `/grids/:id/export/pgm` | 下载灰度 PGM |

PowerShell 调用示例：

```powershell
$base = "http://127.0.0.1:8080/api/v1"
$g = Invoke-RestMethod -Method Post "$base/grids" -ContentType 'application/json' `
  -Body '{"xMin":-2,"xMax":1,"yMin":-1.5,"yMax":1.5,"width":800,"height":600,"maxIterations":200}'
Invoke-RestMethod -Method Post "$base/grids/$($g.grid.id)/compute"
Invoke-RestMethod "$base/grids/$($g.grid.id)/cell?row=300&col=400"
Invoke-RestMethod -Method Post "$base/grids/$($g.grid.id)/region" -ContentType 'application/json' `
  -Body '{"rowStart":0,"colStart":0,"width":64,"height":64}'
```

## JSON 导出与 PGM 灰度规则

JSON 每个格点：

- `escaped:true,  escapeStep:k`：第 k 步逃逸；
- `escaped:false, escapeStep:null`：本次预算内未逃逸（未决，非成员证明）；
- `escaped:null,  escapeStep:null`：尚未计算（仅不完整网格出现）。

PGM 为二进制 `P5`、8-bit 灰度，规则公开且固定：

| 类别 | 灰度 |
| --- | --- |
| 尚未计算 | `0`（纯黑） |
| 预算内未逃逸 | `255`（纯白） |
| 第 `step` 步逃逸（1..maxIterations） | `ceil(254 * (1 - step / maxIterations))`，取值 1..254，越早逃逸颜色越深 |

PGM 只是可选的展示形式，**不改变原始步号**；精确数据以 JSON / 查询接口为准。

## 项目结构

```
src/core/mandelbrot.ts  递推、校验、坐标映射、网格/预算计算
src/core/service.ts     配置、计算、格点、轨迹、子区域用例
src/core/exporter.ts    JSON / PGM 导出
src/db/store.ts         SQLite 持久化
src/server/index.ts     HTTP API（默认空闲端口，可用 PORT 指定）
src/cli/index.ts        命令行
src/test/               node:test 内置测试
demo/run-demo.mjs       端到端演示
```

## 限制

- 仅普通双精度浮点，最小矩形跨度 1e-15，不支持高精度深度缩放。
- 同步 CPU 计算（无 GPU/多线程）；超大网格请用较小尺寸或全局预算分批。
- `node:sqlite` 当前仍带实验性警告，需要 `--experimental-sqlite` 启动参数（脚本已内置）。
