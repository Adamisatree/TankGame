# 全模块 Bug 排查报告（基线：v1.5.0 工作区，即 PR #18 的内容）

> 本次只做**只读排查**：除这份报告外，代码一行未改。
> 每条都给出：**类别 · 位置 · 触发条件 · 后果 · 严重度**。
>
> 验证方式分两种，报告里都标注了：
> - **实测** —— 用仓库现成的 jsdom 无头环境（`scripts/smoke.ts` 那套 shim）启动**真实的 `GameScene`**，
>   用临时探针脚本跑出来的数字（探针已删除，没有留在仓库里）；
> - **代码** —— 逐行读代码 + 交叉对照，路径确定但未运行。
>
> 目前 A1、A2、A3、A4、A5、B1 六条是**实测**结论，其余为代码结论。需要跑起来才能确认的部分见最后一节。

严重度：**严重** = 每个相关对局都会遇到 / 功能直接失效；**高** = 常见场景明显错；**中** = 特定配置或特定操作触发；**低** = 观感、维护或边角情况。

---

## 一、先看这 5 条（联机模式基本不可用）

| # | 一句话 | 后果 |
|---|--------|------|
| A1 | 客机从不写回 `kills/deaths` | 客机上所有人永远 0 杀 |
| A2 | 对局结束没有同步给客机 | 客机永远看不到"你赢了/你输了" |
| A3 | p3–p10 与房主共用同一个开火冷却 | 排头那台 ~9 倍射速，其余座位按键被吞 |
| A4 | 一次击杀删掉全场炮弹 | 混战里别人的炮弹凭空消失 |
| A6 | 断线重连没有会话恢复 | 一次网络抖动 = 全房间回大厅、本局作废 |

---

## 二、联机与网络

### A1 ·【严重】客机的击杀/死亡数永远是 0
- **类别**：联机 · 同步字段遗漏
- **位置**：`src/game/GameScene.ts:3168-3195`（`updateGuest` 的坦克回写循环）、发送端 `:3112-3113`
- **触发**：任何 LAN 对局，客机侧。
- **原因**：`buildSnapshot()` 把 `kills` / `deaths` 写进了每个坦克快照，但客机的
  `updateGuest()` 只回写 `team/x/y/角度/护盾/加速/狂暴/减速/skillCd/hp/heat/damage/alive`，
  没有 `tank.kills = st.kills`。全仓库除发送端外没有任何一处给客机的 `kills` 赋值。
- **后果**：
  - 客机左侧血条栏每台坦克旁边的击杀数恒为 `0`（`drawHud` `:1326`）；
  - 右上公告栏恒显示 `0 杀`（`refreshNotice` `:1405`）；
  - 客机 `matchResult()` 用的是这些 0，于是**客机永远判不出"打到人头"**（见 A2）。
- **实测**（真实 `GameScene`，快照里 `kills: 7, deaths: 3`）：
  `applySnapshot()` + `updateGuest()` 之后四台坦克全是 `p1:0/0, p2:0/0, p3:0/0, p4:0/0`。
- **修法方向**：在回写循环里补 `tank.kills = st.kills; tank.deaths = st.deaths;`（并让 HUD 标脏）。

### A2 ·【严重】对局结束不通知客机，客机自己算又是错的
- **类别**：联机 · 协议缺失 + 状态机
- **位置**：`src/net/protocol.ts:140-235`（没有任何 `result` / `matchOver` 消息）、
  `src/game/GameScene.ts:3196-3199`（客机只接受 `versusOver | playing` 两个 phase）、
  `:1866`（`checkMatchEnd` 没有"仅房主"判定）
- **触发**：LAN 对局打到结束。
- **原因**：房主 `checkMatchEnd()` → `phase = 'matchOver'` → 只在本机 `emitOverlay`。
  快照里虽然带 `phase`，但客机只处理 `snap.phase === 'versusOver' || 'playing'`，
  `matchOver` 被忽略。客机于是靠自己的 `updateMatch()/checkMatchEnd()` 独立判定。
- **后果**：
  - 结束条件 `打到人头`：客机 `kills` 全 0（A1）→ **永远不结束**，画面冻结、没有任何结果卡；
  - 结束条件 `时间到 / 两者任一`：客机到时自己判一次，结果是**"平局"**（所有人 0 杀），
    而房主显示真实胜者 —— **两台机器给出两个不同结论**；
  - 结果卡上的 `btn-wait-host`（房主重开时给客机看的等待按钮）在客机上根本走不到。
- **影响**：直接违反"每局决出胜负都必须显示输赢界面（含联机）"。
- **实测**：
  - 收到一份 `phase: 'matchOver'` 的快照后，客机 `phase` 仍然是 `playing`，`emitOverlay` 调用次数 **0**；
  - 客机自己判一次（线上一片 0 杀 + 时间到）：`{"kind":"draw","reason":"time"}` —— 永远是"平局"。
- **修法方向**：加一条房主 → 全房间的 `result` 消息（胜者/原因/比分），客机收到即出卡；
  客机侧把 `checkMatchEnd` 改成房主专属，`updateGuest` 认 `matchOver`。

### A3 ·【严重】p3–p10 和房主共用同一个开火冷却
- **类别**：联机 · 座位映射错误
- **位置**：`src/game/GameScene.ts:2042-2056`
- **原因**：`const seat = tank.id === 'p2' ? 2 : 1;` —— 只有 `p2` 走 `fireCd2`，
  `p1`、`p3`、`p4`…`p10` **全部落到同一个 `fireCd1`**（同一个数值，谁开火都把它重置成 0.75）。
- **触发**：3 人以上房间，房主端模拟。
- **实测**（9 台同组坦克 —— p1、p3…p10 —— 同时按住开火 3 秒，60fps，热量每帧清零以排除干扰）：

  | 场景 | 结果 |
  |------|------|
  | 9 台同组一起按住 3 秒 | **只有 p1 开火，共 36 发**；p3–p10 一发都没有 |
  | p1 按住、p4 每 0.5 秒点一下（独立冷却应为 6 发） | **p4 一发都没有**，p1 8 发 |
  | 只有 p4 自己按住 3 秒 | p4 4 发（设计值 4 发/3 秒，正常） |

- **后果**：
  - 9 台共用时冷却每帧被扣 9 次，`0.75/9 ≈ 0.08 秒`就归零 → **排头那台（p1）射速约 9 倍**（实测 36 发/3 秒）；
  - 同一组里排在后面的座位**按键被完全吞掉**（实测 0 发），玩家看到的是"我按了没反应"；
  - 谁吃到这一发取决于列表顺序和浮点累积，`fireCooldown` 或帧率一变，受益者就可能换成别人 ——
    同一份代码在别人机器上表现为"另一个座位无敌射速"；
  - 附带：被热量锁死（`canShoot()===false`）的坦克照样把冷却重置成 0.75，会连带拖死同组所有人。
- **修法方向**：冷却按坦克实例存（`Map<string, number>`，或者干脆放到 `Tank` 上）。

### A4 ·【高】一次击杀把**全场**子弹删掉
- **类别**：联机/单人 · 判定写反
- **位置**：`src/game/GameScene.ts:2854`
- **代码**：`this.bullets = this.bullets.filter((b) => b.owner === attacker);`
- **触发**：任何人被击毁。
- **后果**：这是"只保留凶手的炮弹"，等于把**其他所有玩家正在飞的炮弹全部销毁**。
  多人混战里刚打出去、正在反弹的炮弹凭空消失；追弹/预判全乱；本该继续的连杀被打断。
  看起来本意是 `b.owner !== victim.id`（清掉死者的残留弹）。
- **实测**：场上先放 4 发弹 `[p2, p2, p3, p1]`，让 p1 打死 p2 → 剩下 `["p1"]`
  （p2 自己的两发、p3 的那发全被删）。
- **说明**：单人模式没人受害（场上只有 p1 和 enemy），所以这个问题只在局域网/多人暴露。

### A5 ·【中】"弱化"技能打错目标
- **类别**：玩法 · 目标选择
- **位置**：`src/game/GameScene.ts:2115-2119`
- **代码**：`const other = this.tanks().find((t) => t !== tank && t.id !== 'enemy');`
- **触发**：任何人使用弱化技能。
- **后果**：
  - **单人模式**：`tanks()` 只有 `[p1, enemy]`，排除自己和 enemy 后没有目标 →
    技能**完全无效**，但冷却照样进（`skillReadyAt` 已经先设了），等于白按；
  - **乱斗/团队**：永远命中 `tanks()` 里的第一个非敌人（通常是 p1 或 p2），
    与"最接近的对手"无关；**团队赛可能弱化自己的队友**。
  - 附带：同一段还会多发一次 `netEvent('skill')`（先用坦克坐标发一次，再用目标坐标发一次），
    客机会看到两次光圈。
- **实测**：
  - 单人：`useSkill(p1)` 返回 `true`、"被减速的目标"为 `[]`、冷却照样进（技能白按）；
  - 四人房（p1/p2/p3 + 敌人）从 p1 用弱化：只有 `p2` 被减速，`p3` 完全没动。

### A6 ·【中】断线重连没有会话恢复，一次抖动就废掉整局
- **类别**：联机 · 会话管理
- **位置**：`src/net/LanClient.ts:287-302`（重连仍是裸 `join`）、
  `server/lan-server.mjs:436-445`（客人每次 `join` 都发新座位号 `p${nextId++}`，并把 `room.started=false`）、
  `:406-422`（房主重连同样 `started=false`，并清掉地图 ack）
- **触发**：任意一端网络抖动 / 唤醒睡眠 / 掉线 1 秒。
- **后果**：
  - 服务端把 `started` 置 false → `announceRoster` 广播 → **全房间（含房主）被踢回大厅**，
    正在进行的对局作废，比分清零；这与"每局必须有结果"的要求冲突。
  - 重连方拿的是**新座位**（p2 → p3 …），团队、颜色、击杀数全部重来。
  - 若网络是静默断开（对端 TCP 还没超时），死 socket 仍占着座位：
    重连会拿到新座位甚至被拒 `房间已满`，同时房主端留着一台永远不动的"幽灵坦克"参与判定。
  - 房主重连还会清空地图 ack，客机需要重新确认地图，否则开始键一直等。

### A7 ·【低】客机看到的开火特效方向/颜色恒定错
- **类别**：联机 · 表现
- **位置**：`src/game/GameScene.ts:3278`
- **代码**：`this.burst(ev.x, ev.y, Math.atan2(0, 1), ev.id === 'p2' ? 'p2' : 'p1');`
- **后果**：客机上所有座位（p1/p3/p4…）的炮口烟都画成 p1 的颜色，方向永远朝右（`atan2(0,1)===0`）。
  纯观感，但 4 人房里一眼能看出不对。

---

## 三、对局规则与判定

### B1 ·【中】结束条件可以配置成"永远不会结束"
- **类别**：规则 · 配置校验缺失
- **位置**：`src/game/rules.ts:110-144`（`evaluateMatch`）、
  `src/main.ts:975-1005`（房间面板的结束方式 / 人头目标 / 时间上限三组按钮，互不校验）
- **触发**：房主选「打到人头」+「不限」，或「时间到」+「不限时」。
- **后果**：`killTarget/timeLimit` 为 0 时 `evaluateMatch` 永远返回 `running` →
  这一局没有任何终局条件，只能靠"投降/退出"结束；不发结果卡。
- **实测**（纯函数 `evaluateMatch`，两方 3 杀 / 2 杀、`elapsed = 99999`）：
  `打到人头 + 不限` → `{"kind":"running"}`；`时间到 + 不限时` → `{"kind":"running"}`。
- **修法方向**：UI 层直接禁用矛盾组合，或 `startRoomMatch` 里兜底成默认值。

### B2 ·【中】难度的 `lives` / `enemyLives` 是死配置
- **类别**：玩法 · 配置失效
- **位置**：`src/game/settings.ts:15,40,55,70`（定义与三档取值）→ 全仓库无任何读取
  （`grep` 只有定义处；`src/game/Tank.ts:88` 甚至写明"`lives` is gone"）
- **后果**：难度对血量**完全没有影响**（现在只有 `reload/telegraph/dodgeSkill/speed/grace/leadTarget` 生效），
  改这三档的血量不会有任何效果，也会误导以后调平衡的人。

### B3 ·【低】贴墙干射也消耗一次开火冷却
- **类别**：手感
- **位置**：`src/game/GameScene.ts:2455-2460`（`fire()` 在 `len < 6` 时 `return`）、`:2044-2056`（`applyInput` 无条件重置冷却）
- **后果**：炮口顶进墙里时只响一声 ping，但这一发的冷却照扣，玩家会以为"点了没反应"。

### B4 ·【低】过热提示只对 p1 显示
- **类别**：联机 · 提示
- **位置**：`src/game/GameScene.ts:2395,2449`
- **后果**：`if (tank === this.p1)` —— 房主在 p3+ 座位上过热时没有任何横幅提示，只有 ping 声。

---

## 四、地图与编辑器

### C1 ·【中】镜像展开时"木箱与墙共用去重表"，完全重合的箱子被丢掉
- **类别**：地图 · 几何
- **位置**：`src/maps/format.ts:267-281`
- **原因**：`applyMirror` 里 `walls` 和 `crates` 共用同一个 `seen` Set，
  只要有木箱与某块墙**坐标完全相同**，该木箱在展开时就被当成"重复项"丢弃。
- **触发**：把木箱正好画在同一格墙上（编辑器允许，`validateMap` 只给一条 warn
  "木箱 N 和墙重叠了"，不阻止保存），且地图开了任意镜像。
- **后果**：编辑器主画布上看得见这个木箱，虚影里没有，进局后这张图里也没有它 ——
  存档、预览、实机三处不一致；覆盖面变小这种"手感问题"最难查。

### C2 ·【中】竖图（宽 ≤ 1400、高 > 1400）没有摄像机世界，整张图被压扁
- **类别**：地图 · 坐标
- **位置**：`src/maps/format.ts:406`（`...(map.size.w > 1400 ? { world } : {})`）、
  `src/game/GameScene.ts:1112-1117`（没有 `world` 就用固定 `PLAY_RECT`）
- **触发**：导入一张窄高图（编辑器下拉框只有 4 个横版预设，所以只能靠导入/手改 JSON 造出来）。
- **后果**：`world` 缺失 → 归一化坐标被投影到 16:9 的 `PLAY_RECT` 上，
  竖图被横向拉扁：编辑器里画的样子和对局里的样子不是一回事（墙变宽、间距全变）。

### C3 ·【低】`minAppVersion` 是个没人执行的契约
- **类别**：地图格式 · 契约漂移
- **位置**：`src/maps/format.ts:11`（注释承诺"让游戏拒绝需要更新版本的图"）、`:57`、`:223`
- **后果**：全仓库除赋值外没有任何读取。一张标注"需要 1.6+"的图在 1.5 里照常加载，
  只有 `schemaVersion` 会给一条 warn；注释描述的防护实际不存在。

### C4 ·【低】地图库 200 张上限静默淘汰
- **类别**：存储
- **位置**：`src/maps/store.ts:60-64`（`writeStore` 直接 `slice(0, MAX_MAPS)`）
- **后果**：存第 201 张时，最旧的一张**无声消失**，`saveMap` 依然返回成功、UI 提示"已保存"；
  没有任何"库满"提示（`countMaps()` / `libraryBytes()` 都没人调用）。

### C5 ·【低】`levelById` 有两份、行为不同
- **类别**：维护
- **位置**：`src/engine/level.ts:441`（只查内置 `LEVELS`，找不到回退 `LEVELS[0]`）与
  `src/maps/registry.ts:46`（查全部含自定义图）
- **后果**：目前 `src/` 只用到 registry 那份，engine 那份是死导出；
  以后谁 `import` 错一个，"选中的自定义图"会静默变成第一张内置图。

### C6 ·【低】`normalizeMapFile` 里的死代码
- **类别**：维护
- **位置**：`src/maps/format.ts:186-199`
- **内容**：`const sizeId = ...; void sizeId;`（算完丢掉）、
  `pickups` 的三元表达式两个分支完全相同（`Array.isArray(input.pickups) ? ... : []`）。
- **后果**：无功能影响，纯噪音。

---

## 五、更新与安装（桌面端）

### D1 ·【高】装完一版，本地版本库就少了这一版
- **类别**：更新 · 与"可回退"承诺冲突
- **位置**：`electron/updater.cjs:233-247`（`installDownloaded`）
- **原因**：安装时先 `rename(path, downloads/<name>)`（失败则读+写+删），**把安装包搬出** `userData/versions/`。
- **后果**：
  - 面板上"本机已下载的版本（换回来不用重新下）"里这一版**立刻消失**——而 `localVersions()`
    只扫 `versions/`。于是"降级"必须重新下 75–160 MB，正好违反当初的设计意图
    （`ensureDownloaded` 的注释："Keeps every version the player has fetched"）；
  - 搬运前先 `rm` 了 Downloads 里的同名文件：用户自己留着的同一个安装包会被删掉。

### D2 ·【高】完整性校验可以整体跳过
- **类别**：更新 · 安全
- **位置**：`electron/updater.cjs:173-190`（`if (!asset.sha256 || sha256 === asset.sha256)`）、
  `shared/download.mjs:108`（`if (expectedSha && ...)`）、`:119`（`if (total > 1024 && ...)`）
- **触发**：清单里某个资产没有 sha256（`scripts/gen-update-manifest.mjs:63` 正为这种情况打警告），
  或镜像不返回 `content-length`。
- **后果**：三条校验同时失效 ——
  1. 没有摘要的缓存文件被当成"完好"直接用；
  2. 下载时 `expectedSha` 为空 → 不做哈希校验；
  3. 镜像不给 `content-length` → `total = 0` → 截断检查整段跳过。
  最后损坏/被替换的安装包会被**静默安装**（Windows 上还是 `/S` 静默安装）。

### D3 ·【高 / 安全】清单里的 URL 被完全信任，下完立刻静默安装
- **类别**：更新 · 信任边界
- **位置**：`electron/main.cjs:188-196`（`const url = givenUrl || …`，没有 `isGithubUrl` 之类的白名单）、
  `src/update/UpdaterPanel.ts:367-380`（下载成功后 `api.install()` 无条件执行）
- **原因**：渲染进程传来的 `url`、以及 manifest 里 `asset.url` 都可能指向任意主机
  （`normalizeManifest` 原样保留 `url`，`urlCandidates` 只是给它加镜像前缀，最后一个候选是原始 URL）。
- **后果**：一个被污染/被劫持的镜像（或任何能改 manifest 的环节）就能让桌面端
  **下载并静默执行任意 exe**；摘要也来自同一份 manifest，等于自证清白。

### D4 ·【中 / 安全】`update:install-file` 的路径白名单少了分隔符
- **类别**：更新 · 路径校验
- **位置**：`electron/main.cjs:236-240`
- **代码**：`if (!filePath.startsWith(updater.versionsDir()))`
- **后果**：`…/versions-x/evil.exe` 也能通过校验并被安装/启动。
  当前只能由自家渲染进程调用，但和 D3 串起来就是"任意 exe 执行"的第二步。

### D5 ·【中】"镜像测速"的结果完全不影响下载
- **类别**：更新 · 功能未接线
- **位置**：`electron/updater.cjs:105-131`（`probeMirrors` 只返回排名，`readSettings()` 里没有排名字段）、
  `src/update/UpdaterPanel.ts:388-402`（只把排名塞进 `state.probe` 和一句提示）
- **后果**：点「镜像测速」→ 面板告诉你"最快线路：ghfast（120ms）"，
  但真正的下载走 `downloadWithMirrors()` → `urlCandidates(url, mirrors, settings.mirrorId)`，
  没选镜像时按 `mirrors.json` 的**固定顺序**试；测出来的排名只用来画 ★。
  注释里写的"排名缓存一小时"在代码里根本不存在。

### D6 ·【中】测速测的不是下载路径
- **类别**：更新 · 逻辑
- **位置**：`electron/updater.cjs:109,115`
- **原因**：`probeUrl = OFFICIAL.manifestRaw`（`raw.githubusercontent.com`），
  真实下载走 `github.com/…/releases/download/…`。两者的镜像行为/缓存策略并不相同。
- **后果**：排名与实际下载速度无关；"自动（选最快）"可能反而更慢。

### D7 ·【低】清单候选 URL 靠字符串拼接，隐含前提没校验
- **类别**：更新 · 配置耦合
- **位置**：`electron/updater.cjs:69-85`、`src/update/UpdaterPanel.ts:120-129`
- **内容**：`\`${raw.prefix}main/updates.json\`` —— 只有"前缀以 `@` 结尾（jsDelivr）"
  或"以 `…/TankGame/` 结尾（gh 代理 raw）"时才拼得对。现有 3 个配置刚好都满足。
- **后果**：以后往 `mirrors.json` 的 `rawMirrors` 加一个普通前缀，就会静默生成坏 URL
  （`raceManifestFetch` 只会把它记成一条 error，用户看到的是"镜像都没连上"）。

---

## 六、输入 / 设置 / UI

### E1 ·【中】按键冲突只在单个作用域内部检测
- **类别**：设置 · 校验缺失
- **位置**：`src/game/keybinds.ts:252-269`
- **原因**：`scan()` 分别扫 solo / versus.p1 / versus.p2 / lan.host / lan.guest / global，互不比较。
- **后果**：把「前进」和「暂停」设成同一个键，冲突检测显示"没问题"，
  实际按一下既前进又暂停（Phaser 的 `addKey` 对同一键返回同一个 Key 对象，两个动作都会触发）。
  同理：静音/自动躲弹与任何驾驶键相撞都不会被发现。

### E2 ·【低】`findConflicts` 的 `shared` 参数没有调用方
- **类别**：维护 · `src/game/keybinds.ts:254`
- **后果**：死参数（原本大概是想表达"这些键允许共用"）。

### E3 ·【低】菜单「复制局域网地址」用的是主机名
- **类别**：桌面端 · 联机
- **位置**：`electron/main.cjs:29`
- **代码**：`http://${os.hostname()}:${port}`
- **后果**：不少家庭网络/DHCP 环境下别的主机解析不了这个主机名，复制给朋友的地址打不开；
  而游戏内横幅（`announceRoom()`）用的是探测到的 IPv4，两处地址不一致。

### E4 ·【低】非 Windows/macOS 平台每一行都没有下载按钮，也没有解释
- **类别**：更新 · UI
- **位置**：`src/update/UpdaterPanel.ts:154-186`
- **后果**：`pickForThisMachine()` 对 `linux`（以及所有 `guessPlatform()` 兜底值）一律打 -1 分，
  于是版本列表里只剩「网页版」和「发布页」两个链接，用户不知道是"没有安装包"还是"坏了"。

---

## 七、死代码 / 契约漂移（维护性，无直接用户影响）

| # | 位置 | 内容 |
|---|------|------|
| F1 | `src/net/protocol.ts:59` + `GameScene.ts:3125` | 快照里每台坦克都带 `skill`，客机从不读（技能靠 roster），纯冗余带宽 |
| F2 | `src/maps/store.ts:78,199` | `countMaps()` / `libraryBytes()` 无人调用，地图库没有容量 UI（见 C4） |
| F3 | `src/engine/level.ts:441` | `levelById` 死导出，且与 registry 版本语义不同（见 C5） |
| F4 | `electron/updater.cjs:104-107` | 注释承诺"排名缓存一小时"，无实现（见 D5） |

---

## 八、逐模块覆盖清单（本次真的逐行看过）

| 模块 | 文件 | 结果 |
|------|------|------|
| 物理/数学 | `src/engine/physics.ts` | 未见缺陷 |
| 弹道 | `src/engine/bullet.ts` | 未见缺陷（反弹计数与瞄准线一致） |
| AI | `src/engine/ai.ts`、`src/engine/steer.ts` | 未见缺陷（只影响手感，不做 bug 计） |
| 地图数据 | `src/engine/level.ts` | C5 / F3 |
| 地图格式 | `src/maps/format.ts` | C1 / C2 / C3 / C6 |
| 地图库 | `src/maps/store.ts` | C4 / F2 |
| 地图注册 | `src/maps/registry.ts` | 未见缺陷（C5 的另一半） |
| 编辑器 | `src/ui/mapEditor.ts` | 未见新缺陷（笔刷/撤销/导入导出逻辑自洽；C1 的表现面） |
| 场景主循环 | `src/game/GameScene.ts` | A1–A5、A7、B3、B4、C2 |
| 坦克 | `src/game/Tank.ts` | 未见缺陷（B2 的注释证据） |
| 热量 | `src/game/heat.ts` | 未见缺陷 |
| 规则 | `src/game/rules.ts` | B1 |
| 技能 | `src/game/skills.ts` | A5 |
| 设置/难度 | `src/game/settings.ts` | B2 |
| 按键 | `src/game/keybinds.ts` | E1 / E2 |
| 绘制 | `src/game/Sketch.ts`、`art.ts` | 未见缺陷 |
| 音效 | `src/game/Sound.ts` | 未见缺陷 |
| 网络层 | `src/net/LanClient.ts`、`protocol.ts` | A2 / A6 / F1 |
| 局域网服务 | `server/lan-server.mjs` | A6（座位/`started`/地图 ack） |
| 菜单与覆盖层 | `src/main.ts` | B1（缺校验）、未见其他回归 |
| 更新面板 | `src/update/UpdaterPanel.ts` | D3 / D5 / D7 / E4 |
| 更新核心 | `shared/update-core.mjs`、`fetch-manifest.mjs` | 未见缺陷（`generatedAt` 回填使"最新者胜"成立） |
| 下载 | `shared/download.mjs` | D2 |
| Electron 主进程 | `electron/main.cjs`、`updater.cjs`、`lan-boot.cjs`、`discovery.cjs` | D1–D7、E3 |
| 构建脚本/测试 | `scripts/*` | 不在本次范围（不影响玩家） |

---

## 九、我没能确认的（需要跑起来才能定）

1. **UI 像素级问题**：房间面板 / 结果卡在窄窗口下的换行、小地图遮挡、编辑器在手机尺寸下的排版 ——
   需要截图确认，本次没有无头浏览器（jsdom 只能跑逻辑，不能出图）。
2. **真实网络下的更新链路**：镜像超时、镜像不返回 `content-length`、被污染清单的实际表现 ——
   只用代码推演过（D2/D3/D6），没有在真机 + 真镜像上跑。
3. **10 人房间的真实手感**：A3 的冷却问题已用无头场景量出来了，但"9 倍射速 + 其余座位哑火"在
   真人操作下具体是什么观感，还要打一局才知道。

> 以上**任何一条都还没有动手修**，等你点名要修哪几条（按编号点就行）。
