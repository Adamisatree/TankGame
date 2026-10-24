# 坦克大作战 · Sketch Tank Ricochet

一个**简笔画 / 几何风格**的坦克对战小游戏。你开着一台铅笔涂出来的小坦克，在纸上的方厅里转向、前进、开火——**子弹打到任何墙壁都会反弹，包括你自己的炮弹**（站在自己的弹道上一样会被自己打到）。

支持**单人闯关**（三档难度，AI 会打反弹球、会躲你的炮弹）、**本地双人**（同一台电脑，两人对轰）和**局域网联机**（同一个 Wi-Fi 下两台电脑对打，不用联网、不用注册、不用服务器）。还有一个**自动躲弹**模式：车身自己躲炮弹，你只管瞄准和开火。

用主流游戏引擎 **[Phaser 3](https://phaser.io/)**（3.90）构建，Vite + TypeScript 打包，`npm run dev` 即可开玩。

![游戏截图](docs/preview.jpg)

![tech](https://img.shields.io/badge/Phaser-3.90-8a4b9c) ![tech](https://img.shields.io/badge/TypeScript-5.9-3178c6) ![tech](https://img.shields.io/badge/Vite-5-646cff)

## 三种打开方式

### 1. 什么都不装：双击一个文件

[`TankGame-1.0.0-portable.html`](https://github.com/Adamisatree/TankGame/releases/download/v1.0.0/TankGame-1.0.0-portable.html)（仓库里也有一份：`release/坦克大作战.html`）是一个**完全自包含**的网页（1.5 MB，脚本、样式、素材全在里面，没有任何外部依赖）。

- Windows / macOS / Linux：双击它，用浏览器打开就能玩**单人闯关**和**本地双人**；
- 想发给朋友，直接把这一个文件发过去即可，不需要联网、不需要装任何东西。

> 局域网联机需要下面两种方式之一（浏览器不能当服务器用）。

### 2. 联机客户端：.exe / .dmg（推荐）

从 [Releases](https://github.com/Adamisatree/TankGame/releases) 下载对应安装包：

| 你的电脑 | 下载 |
| --- | --- |
| Windows（Intel / AMD） | [TankGame-1.0.0-x64-setup.exe](https://github.com/Adamisatree/TankGame/releases/download/v1.0.0/TankGame-1.0.0-x64-setup.exe) |
| Windows（ARM 笔记本） | [TankGame-1.0.0-arm64-setup.exe](https://github.com/Adamisatree/TankGame/releases/download/v1.0.0/TankGame-1.0.0-arm64-setup.exe) |
| Windows 免安装（解压即用） | [TankGame-1.0.0-portable.exe](https://github.com/Adamisatree/TankGame/releases/download/v1.0.0/TankGame-1.0.0-portable.exe) |
| Mac（M1/M2/M3/M4，`.app` 打包） | [TankGame-1.0.0-arm64.dmg](https://github.com/Adamisatree/TankGame/releases/download/v1.0.0/TankGame-1.0.0-arm64.dmg) |
| Mac（Intel） | [TankGame-1.0.0-x64.dmg](https://github.com/Adamisatree/TankGame/releases/download/v1.0.0/TankGame-1.0.0-x64.dmg) |

装好之后桌面上就有「坦克大作战」图标，**双击即玩**：客户端自己会起局域网服务，切到「局域网联机」直接建房/加入，不需要命令行、不需要 npm。

> 安装包没有做代码签名（个人项目拿不到证书），所以：
> - Windows：首次运行 SmartScreen 会拦一下 → 点「更多信息」→「仍要运行」；
> - macOS：首次打开提示「无法验证开发者」→ 右键点图标选「打开」，或执行 `xattr -dr com.apple.quarantine /Applications/TankGame.app`。

### 3. 开发模式

```bash
npm install
npm run dev        # http://localhost:5173
```

其他命令：

```bash
npm run build        # 类型检查 + 生产构建（输出到 dist/）
npm run lan          # 构建并启动局域网服务：http://<你的IP>:8787
npm run build:single # 生成 release/坦克大作战.html 单文件版
npm run test:desktop # 检查桌面端打包后能否正常起服务
```

## 局域网联机（不用联网）

1. 两台电脑连同一个 Wi-Fi / 路由器（同一个网段）；
2. 房主：打开客户端 → 模式选「局域网联机」→ 角色「我是房主」→ 开始，屏幕上会显示 `http://<局域网IP>:8787`；
3. 对方：在同一 Wi-Fi 下用浏览器打开这个地址（或在自己客户端的「加入房间」里填这个 IP），进入游戏后选「加入房间」；
4. 两人到齐自动开局。

技术上是**房主权威**：房主的机器跑物理、判命中，每秒 30 次把状态推给对方，对方只上传操作意图。所以两边看到的结果一定一致，也不怕对方改内存。

- 一台电脑能同时开两个窗口做本地测试（一个当房主、一个当房客）；
- 端口默认 `8787`，被占用时会自动顺延；
- 防火墙第一次会弹窗询问，允许「专用网络」即可。

## 模式

开局菜单里可以自由切换，随时改随时生效：

| 模式 | 说明 |
| --- | --- |
| **单人闯关** | 你 vs AI，3 张地图。难度分「轻松 / 标准 / 困难」 |
| **本地双人** | P1 vs P2，同一台电脑，每人 3 条命，先被打光的一方输 |
| **局域网联机** | 两台电脑，各自 3 条命，房主当裁判（权威同步） |

### 难度（单人）

| 难度 | 你的命 | AI 开火间隔 | AI 反弹次数 | AI 躲弹 |
| --- | --- | --- | --- | --- |
| 轻松（默认） | 5 | 3.6s | 1 | 偶尔躲 |
| 标准 | 4 | 2.6s | 2 | 会躲 |
| 困难 | 3 | 1.9s | 3 | 很会躲 |

> 第一版太难了，所以默认改成「轻松」：命更多、AI 更慢、出手更慢，而且 AI 的炮弹（500px/s）明显比你慢（830px/s）。

### 自动躲弹（单人）

菜单里打开，或游戏中按 <kbd>G</kbd> 随时切换。开启后**车体会自己躲避所有飞来的炮弹**（包括会反弹回来的），自动贴墙、找安全角度；你只负责用鼠标瞄准 + 开火。按一下 WASD 会立刻接管手动驾驶，松手后自动躲弹恢复。

## 怎么玩

| 操作 | 键位 |
| --- | --- |
| 前进 / 后退 | `W` `S` 或 `↑` `↓` |
| 转向（原地也可转） | `A` `D` 或 `←` `→` |
| 炮塔瞄准 | 鼠标 |
| 开火 | 鼠标左键 / `空格`（可按住连发） |
| 慢速微调（精细走位） | 鼠标右键 / `Shift` |
| 暂停 | `P` / `Esc` |
| 静音 | `M` |
| 自动躲弹开关 | `G` |

双人模式键位：

| | P1（青绿） | P2（紫） |
| --- | --- | --- |
| 驾驶 / 转向 | `W` `A` `S` `D` | `↑` `←` `↓` `→` |
| 微调炮口 | `Q` / `E` | `,` / `.` |
| 开火 | `空格` | `Enter` |

局域网联机时：房主用单人那套键位（`WASD` + 鼠标），房客用 `WASD` / 方向键 + 鼠标 + 左键/空格开火，两队都是 3 条命。

规则：

- **自己的炮弹也能打到自己**：所有炮弹对所有坦克都生效，包括开火者本人。
- 中弹后有 1.1 秒无敌闪烁，避免一颗余弹连续打掉好几条命。
- 敌方坦克要 **命中 3 次**才会被击毁；反弹次数用尽后炮弹会自动消失。
- 屏幕上出现**红色闪烁圆圈**说明有炮弹正在逼近你。
- 木箱会**挡住**炮弹（打碎它 +25 分）同时也挡住坦克。
- 干掉敌人 +1000 分，命中 +150 分。共 3 关，全清即通关。
- 瞄准时那条**虚线就是真实的反弹路径**（含反弹点标记），照着它打就行。

![本地双人](docs/versus.jpg)

> 绿色 / 紫色虚线分别是 P1 / P2 的真实反弹路径（拐角上的小圈就是反弹点）。双人模式两人共用一块键盘，各自有独立的瞄准线与生命值。

## 你会看到什么

- **手绘画风**：所有墙、坦克、准星、准星虚线和 HUD 都由 `Sketch` 绘制——同一条路径重复描 2～3 遍，并叠加低频抖动，看起来像铅笔描了两次；线条还会以 8fps 轻微“呼吸”。纸纹、纤维、暗角在运行时用 Canvas 生成，项目里没有任何图片素材。
- **战术慢速**：按住右键/Shift，车体会慢下来，方便贴着墙找反弹角度。
- **AI 银行射术**：敌人开火前会做反弹射线搜索，找一条能穿过你的路径（困难难度还会预判你的走位提前量）；开火前用虚线预告，给你反应时间。
- **AI 会躲你的炮弹**：它每 0.12～0.3 秒评估一次“我这块地方危不危险”，会横移、后退、贴墙绕开你自己的反弹线。
- **自动躲弹**：同一套躲弹算法也给你用——开启后车身自己走位。
- **反馈**：命中闪白、镜头震动、铅笔屑粒子、弹壳拖尾、合成音效（WebAudio 现场合成，无音频文件）。

## 技术要点

### 1. 反弹不用物理引擎，而是解析求交

坦克和墙壁的判定是「圆 vs AABB」，炮弹用**扫掠**求交，而不是逐帧采样位置：

- `circleBox` —— 圆与矩形精确相交 + 推出向量，用来把坦克从墙里挤出来；
- `rayBox` —— slab 法，返回进入/离开两个面及各自法线（射线起点在扩展盒内部时，接触面是“离开面”，这正是刚反弹完一帧会踩到的坑）；
- `sweepCircleBox` —— 把墙按半径扩张成 AABB 再做 slab 求交，得到**第一个接触点、法线与剩余行程**，所以 2000px/s 的炮弹也不会穿墙；
- `reflect` —— 沿法线反射速度，墙面还可带 `bounce` 阻尼。

`advanceBullet()` 在剩余时间预算内循环处理“撞墙 → 反射 → 继续飞”，并在同一段上按距离排序墙、木箱、敌方坦克三种接触，命中谁就是谁。

### 2. 敌人怎么“算”反弹

`planRicochetShot()`：以 64 个方向为初值做粗扫，对每个方向模拟最多 3 次反弹并记录与玩家的最近距离（`closestOnSegment`）；随后在最优方向附近做 4 轮二分细化，最终只接受最近距离小于坦克命中半径的解。这样它能打出真正会命中的**银行球**，而不是乱射。

### 3. 结构

```
src/
  engine/            # 纯逻辑，零 Phaser 依赖（可直接在 Node 里测）
    physics.ts       # 圆/AABB、slab、扫掠、反射
    bullet.ts        # 炮弹推进与接触事件
    ai.ts            # 反弹瞄准求解、线段/圆相交
    steer.ts         # 躲弹：炮弹轨迹预测 + 候选方向评分 + 坦克转向控制
    level.ts         # 关卡数据（归一化坐标 → 自适应投影）
  game/
    GameScene.ts     # 战斗循环、双人/单人模式、AI 行为、特效、HUD
    settings.ts      # 模式 / 难度预设 / 自动躲弹开关
    MenuScene.ts     # 标题页背景动画
    Tank.ts          # 坦克手绘贴图（车体 + 炮塔两层）
    Sketch.ts        # 手绘绘图工具（描边、抖动、排线、纸张质感）
    art.ts           # 运行时生成纸纹/颗粒纹理
    Sound.ts         # WebAudio 合成音效
  main.ts            # Phaser 启动 + DOM 覆盖层（开始 / 暂停 / 结束）
  net/
    protocol.ts      # 局域网报文格式（快照 / 输入 / 事件）
    LanClient.ts     # WebSocket 客户端（自动重连、状态回调）
server/
  lan-server.mjs     # 静态站点 + WebSocket 中继（一个进程，无外部服务）
electron/
  main.cjs           # 桌面窗口，启动时自带局域网服务
  lan-boot.cjs       # 服务引导（可脱离 Electron 单独测试）
scripts/
  selftest.ts        # 53 项纯逻辑检查
  smoke.ts           # jsdom + 软件 Canvas 里跑真游戏的冒烟测试（31 项，含真 WebSocket 联机）
  lantest.ts         # 20 项局域网中继检查（配对 / 转发 / 断线 / 重开）
  desktop-test.ts    # 7 项打包后服务检查
  verify-singlefile.ts # 在 jsdom 里真的打开单文件版，确认能起
  render.ts          # 离线渲染 PNG 截图（npx tsx scripts/render.ts 输出目录）
```

渲染分辨率固定 1280×720，`Phaser.Scale.FIT` 等比缩放适配任意窗口。

## 可调参数

`src/game/config.ts`：

- `TANK.driveSpeed` / `turnRate` —— 手感；
- `BULLET.speedPlayer` / `speedEnemy` / `maxBounces` / `lifetime` —— 弹速与弹跳上限；
- `COLORS` —— 纸、墨、我方青绿、敌方砖红。

`src/engine/level.ts` 里三个关卡都是 0～1 归一化坐标，加一个 `LEVELS` 条目就能加关；`enemyGrace`（开局呼吸时间）和 `enemyReload`（开火间隔）控制难度。

## 后续可以做的

- 手机端虚拟摇杆（目前建议键盘）；
- 更多模式：时间赛、占点、道具；
- 多敌人 / 波次、道具、可破坏墙；
- 关卡编辑器与最佳成绩本地存档；
- 更精细的笔触（同一笔画内变宽、墨点堆积）。
