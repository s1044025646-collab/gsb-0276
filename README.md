# Mandelbrot 逃逸网格与复数迭代后端

离线 Mandelbrot 集**逃逸时间**计算服务，只提供数值 API、CLI 和可导出的静态数据。
使用 TypeScript + Node.js + 内置 SQLite（`node:sqlite`，无需编译原生模块），
在 Windows 本地直接运行，不依赖 Docker、WSL、付费服务或任何在线 API。

> 不包含网页、交互式画布、GPU 计算或高精度深缩放。
> PGM 图像只是结果的可选展示，**原始计算矩阵（每个格点的首次逃逸步数）才是主数据**。

## 数值观察 ≠ 集合成员证明

本服务只做有限预算下的数值递推：

- 格点结果 `escapeStep` 为正整数，表示**首次逃逸步号（从 1 起）**。
- `escapeStep = null` 仅表示「在本次 `maxIterations` 预算内**尚未逃逸**」，
  是一次**数值观察**；它**不等于**「该点已被证明属于 Mandelbrot 集」。
  提高迭代上限后，这类点可能在下一次计算中得到逃逸结论。
- 「恰好在最后一步（第 `maxIterations` 步）逃逸」属于**已逃逸**，
  与「达到上限仍未逃逸」是两种不同状态，不会混为一谈。

## 算法（算法版本号：`mandelbrot-escape-v1`）

对每个取样复数 `c`，从 `z0 = 0` 开始迭代：

```
z_{n+1} = z_n^2 + c
```

关键实现约定（见 `src/mandelbrot.ts`）：

1. 每轮先用**两个局部变量**同时算出实部、虚部新值，再一起回写：
   - `nextRe = zRe*zRe - zIm*zIm + cRe`
   - `nextIm = 2*zRe*zIm + cIm`

   两者都只来自**上一轮**的 `(zRe, zIm)`，
   绝不会「先改实部、再用新实部算虚部」。
2. 更新后计算模平方 `mod2 = zRe*zRe + zIm*zIm`，
   当且仅当 `mod2 > 4`（模**严格大于 2**）时判定逃逸，记录当前步号。
   `mod2` 恰好等于 4 时**不逃逸**。
3. 结果确定：无随机数、无平滑（normalized iteration count）着色。

## 坐标映射（像素中心取样）

列 `col` 从左到右实部增大，行 `row` 从上到下虚部减小。
矩形边界**不**作为边缘像素中心，宽/高为 1 时中心即矩形中点：

```
re(col) = reMin + (col + 0.5) * (reMax - reMin) / width
im(row) = imMax - (row + 0.5) * (imMax - imMin) / height
```

子区域（subgrid）仍使用**全图行列索引**取样：每个子格点先按全局
`(col, row)` 用同一公式映射到原坐标再迭代，**不重新缩放**。
因此把任意子区域结果放回原位置，与整图计算逐点相同（有测试覆盖）。

## 参数与上限（普通双精度，合理预算）

| 参数 | 约束 |
| --- | --- |
| `reMin/reMax/imMin/imMax` | 有限数，`reMax>reMin`、`imMax>imMin`，坐标绝对值 ≤ 1e6，跨度 ≥ 1e-9 |
| `width` / `height` | 1 ～ 4096 的整数 |
| `maxIterations` | 1 ～ 100000 的整数 |
| 格点总数 | `width*height ≤ 2,000,000` |
| 总迭代预算 | `width*height*maxIterations ≤ 100,000,000` |

超限请求直接返回 `400` 且**不落库**，因此数据库中只会保存完整生成的矩阵。

## 快速开始

需要 Node.js ≥ 22.5（内置 `node:sqlite`；开发环境为 Node 25）。

```powershell
npm install
npm run build
npm test          # 构建并运行全部测试
npm start         # 启动 HTTP 服务（默认自动选择空闲端口）
npm run demo      # 运行端到端演示（手算点、轨迹、拼接、导出、重启复查）
```

指定端口或数据目录：

```powershell
$env:PORT="8080"; npm start
$env:MANDEL_DATA_DIR="E:\mandel-data"; npm start
```

默认数据目录为项目内 `./data`（SQLite 文件 `data/mandelbrot.db`），
导出文件默认写入 `./exports`。

## HTTP API

所有错误返回形如：

```json
{ "error": { "code": "INVALID_RANGE", "message": "reMax 必须严格大于 reMin" } }
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/configs` | 创建配置并同步计算、保存完整网格（幂等：同参数返回同一 ID） |
| GET | `/configs` | 历史配置摘要列表（`?limit=`） |
| GET | `/configs/:id` | 查看单个配置摘要 |
| GET | `/configs/:id/cells` | 读取完整计算矩阵（行优先） |
| GET | `/configs/:id/cell?col=&row=` | 查询指定格点 |
| POST | `/configs/:id/subgrid` | 按全图索引取矩形子区域 |
| GET | `/configs/:id/export/json` | 导出原始矩阵 JSON |
| GET | `/configs/:id/export/pgm` | 导出灰度 PGM（P5） |
| POST | `/trajectory` | 单点完整迭代轨迹 |
| POST | `/escape-time` | 单点逃逸步数（不落库） |

`POST /configs` 请求体：

```json
{ "reMin": -2.5, "reMax": 1, "imMin": -1.25, "imMax": 1.25,
  "width": 160, "height": 80, "maxIterations": 200 }
```

`POST /configs/:id/subgrid` 请求体（索引区间左闭右开 `[start,end)`）：

```json
{ "colStart": 10, "colEnd": 90, "rowStart": 5, "rowEnd": 60 }
```

### 错误码

| HTTP | code | 触发场景 |
| --- | --- | --- |
| 400 | `INVALID_JSON` | 请求体不是合法 JSON |
| 400 | `VALIDATION_ERROR` | 通用参数非法 |
| 400 | `INVALID_RANGE` | 坐标非有限数、方向颠倒、跨度过小/过大 |
| 400 | `INVALID_DIMENSIONS` | 宽高/迭代次数不是允许范围内整数 |
| 400 | `BUDGET_EXCEEDED` | 格点数或总迭代预算超上限 |
| 404 | `NOT_FOUND` | 配置或路径不存在 |
| 405 | `METHOD_NOT_ALLOWED` | 方法不支持 |

## CLI

构建后可用 `node dist/cli.js <命令>`（或 `npm link` 后使用 `mandel`）：

```powershell
# 手算点轨迹：c=1 应在第 3 步逃逸
node dist/cli.js trace --re 1 --im 0 --maxIterations 10

# 创建并保存网格
node dist/cli.js create --reMin -2.5 --reMax 1 --imMin -1.25 --imMax 1.25 `
  --width 80 --height 40 --maxIterations 200

node dist/cli.js list
node dist/cli.js get --id <配置ID>
node dist/cli.js cell --id <配置ID> --col 0 --row 0
node dist/cli.js subgrid --id <配置ID> --colStart 10 --colEnd 40 --rowStart 0 --rowEnd 20
node dist/cli.js export --id <配置ID> --format json --out exports/out.json
node dist/cli.js export --id <配置ID> --format pgm  --out exports/out.pgm
```

CLI 退出码：成功 0；参数/预算错误 1；未找到 2。

## PGM 灰度规则（公开，仅影响展示）

导出为二进制 PGM（P5，每像素 1 字节，最大灰度 255），行列与网格一致：

- 本次预算内**未逃逸**：灰度 `0`（纯黑）
- **已逃逸**：`gray = 255 - round(254 * (escapeStep - 1) / (maxIterations - 1))`
  - 第 1 步逃逸近白（255），越晚逃逸越暗；已逃逸灰度恒 ≥ 1，与黑色未决点始终可区分。

着色不改变、也不反推任何 `escapeStep`；原始数据请以 JSON/矩阵为准。

## 持久化

SQLite 保存：范围、尺寸、迭代预算、算法版本、结果摘要
（格点数、逃逸/未决计数、逃逸步数极值）以及每格点结果。
配置 ID 由「算法版本 + 全部参数」规范化后取 SHA-256 前 16 位，
**固定输入结果确定、改变参数产生新报告、重启后可用同一 ID 读回同一网格**。
仅完整计算成功的网格入库；超预算在计算前即被拒绝，不存在「不完整却标记为完整」的记录。

## 手算核对

| c | 预算 | 结论 |
| --- | --- | --- |
| 0 | 任意 | 预算内不逃逸（z 恒为 0） |
| -1 | 有限 | 预算内不逃逸（在 0 与 -1 间循环） |
| 1 | ≥3 | 第 **3** 步首次逃逸（z1=1，z2=2，模平方恰为 4 不逃逸；z3=5） |
| 2 | ≥2 | 第 **2** 步首次逃逸（z1=2 模平方恰为 4 不逃逸；z2=6） |

## 目录结构

```
src/
  constants.ts   算法版本、上限、逃逸阈值
  types.ts       类型定义
  errors.ts      错误码与 AppError
  mandelbrot.ts  复数递推、坐标映射、整图/子区域、轨迹、参数校验
  storage.ts     SQLite 持久化与确定性配置 ID
  pgm.ts         灰度 PGM 编码
  server.ts      HTTP API 与空闲端口选择
  cli.ts         命令行入口
  demo.ts        端到端演示
test/            核心算法 / 持久化 / HTTP API 测试（node:test）
```

## 已知限制

- 普通 IEEE-754 双精度，跨度下限 1e-9，不支持高精度深度缩放。
- 同步 CPU 计算（无 GPU/多进程），预算上限内的网格可在本地快速完成。
- `node:sqlite` 在当前 Node 版本仍带 Experimental 标记，启动脚本已静默其警告。
