# 二期优化计划

> 一期（`REFACTOR_PLAN.md` / `REFACTOR_REPORT.md`）解决的是「巨石能不能拆」。二期不再按行数定优先级，判据换成三条：
>
> 1. **会丢数据 / 出错数据**——哪怕只有一行代码的窗口
> 2. **用户能看见**——体积、启动、显示不一致、交互层级
> 3. **每次改动要多绕几圈**——同一件事的实现份数
>
> 下面每条都带实测证据，基线日期 **2026-11-10**。

---

## 0. 基线

| 指标 | 实测 | 取法 |
|---|---|---|
| `src/` 非语言包行数 | 85,372 行 | `wc -l`（排除 `locales/`、`i18n.ts`） |
| 最大非 i18n 文件 | `library-section.ts` 2,595 | 同上 |
| `i18n.ts` | 7,137 行（en 2,345 / zh 2,342 / zh-TW 2,364） | 字典起点 80 / 2,428 / 4,773 |
| 单函数 > 120 行 | **38 个**，其中 7 个 > 300 行 | 花括号配对扫描 |
| 最长函数 | `showPomodoroStats` 779、`serialize` 763、`showExpenseLedger` 585 | 同上 |
| 同名重复函数 | **31 组** | 全库函数名分组 |
| 内联 base64 资产 | 899,023 B（4 个文件） | `ls -la src/assets/` |
| `main.js` | 5,118,345 B（4.88 MiB） | 生产构建 |
| `styles.css` | 896,298 B / 31,473 行 | 未压缩，构建直拷 |
| 用例 | 117 个，全量 164 s，假时钟审计 269 s | `npm run check` / `audit:clock` |

---

## 1. P0：正确性（先做，且都要「先测后改」）

### P0-1 四个数据服务的合并契约

**证据**：`mergeData` 在 `expense-service.ts:140`、`habit-service.ts:37`、`pomodoro-service.ts`、`reading-service.ts` 各一份，`normalizeData` 三份、`emptyData` 三份。四份实现各自处理「盘上优先、会话补充」，但枝节不同（分类顺序、按日去重的 id 过滤、阅读进度取 max）。现有用例是功能用例（expense 1 / habit 3 / pomodoro 2 / reading 2），**没有一份断言四者对同一输入的合并规则同形**。

**为什么排第一**：这类错误不报错——盘上的数据被会话数据覆盖错，用户只看到「记录少了几条」，且不可回滚。

**做法**：
1. 新增 `verify-service-merge-contract`：对四个服务输入同一组三元组（仅盘上有 / 仅会话有 / 同 id 冲突），断言四条规则——**会话赢**、**只剩一方时另一方保留**、**顺序稳定**、**缺失字段回落盘上**。
2. 抽出 `src/store/merge.ts` 的 `mergeById(disk, session, key)` 作为内核；域内特有策略留在各服务（分类排序、按日去重、进度取 max）。

**验收**：四组用例同形通过；变异「会话赢」改成「盘上赢」→ 四组全红。
**风险**：低（用例先行，抽取不改语义）。**批次**：B2。

### P0-2 树操作的两套实现

**证据**：`locate` / `replaceSiblings` / `isSelfOrDescendant` / `adjustPathAfterRemoval` 在 `doc-tree.ts` 与 `task-tree.ts` **各一份**，共 8 个函数、同一套路径逻辑。

**为什么**：这两套走拖拽与「删除父节点后子路径修正」。一处修了另一处没修，结果就是**移动完成后文件找不到**——不可逆。

**做法**：抽 `src/tree-ops.ts`，以「路径数组」为唯一表示；两侧只保留各自的节点形状适配（doc 树是文件、task 树是任务行）。

**验收**：用例覆盖「删父后子路径下移」「移入自身子树被拒」「同级重排后序号连续」；变异 `isSelfOrDescendant` 为相等判断 → 红。
**风险**：中。**批次**：B3。

### P0-3 覆盖层的 Escape 优先级

**证据**：四个统计/账本覆盖层各自实现 `mountOverlay`（4 份，只差类名）与 Escape 处理：`expense-stats:113`、`expense-ledger:84`、`habit-stats:62` 都写了「让上层先消费」的判断，`pomodoro-stats:76` 是裸的 `if (e.key === 'Escape') close()`。

**为什么**：层叠场景（统计 → 账本 → 确认框）按一次 Esc 可能关掉两层或关错层。四处注释都在各自解释这件事，说明规则存在但没被写下来。

**做法**：`src/overlay.ts` 统一 mount / 关闭 / Escape —— 栈式：后开者先关，确认层拦截，关闭时注销监听。四个弹窗只传类名与内容。
**验收**：用例「stats 上开 ledger，按 Esc 只关 ledger」；变异「每层自行关闭」→ 红。
**风险**：中（交互细节多，但用例可钉）。**批次**：B3。

### P0-4 `formatDate` 七份

**证据**：`dql/values:183`、`expense-service:444`、`habit-service:108`、`library-section:302`、`media-views:89`、`pomodoro-service:1136`、`reading-service:614`。其中五处逻辑**逐字相同**（`y-m-d` 补零），另两处差异仅在入参（`ts` / DQL 的 DATE 类型）。

**为什么**：`ts` 与 `Date` 混淆会差一个时区（8 小时 → 跨日），症状是「今天的记录跑到昨天」。
**做法**：统一到 `locale-format.ts`：`formatDate(d: Date)` + `formatDateFromTs(ts: number)`；DQL 那处保留（它有自己的日期类型）。
**验收**：快照用例含单数字月/日、跨月、本地 23:59。
**风险**：低。**批次**：B1。

---

## 2. P1：体量与构建（用户可感知）

### P1-1 内联资产瘦身（878 KB → <150 KB）

**证据**：

| 文件 | 字节 | 用途 | 引用点 |
|---|---|---|---|
| `assets/wechat-group-qr.ts` | 437,319 | 微信群二维码（PNG） | `dataview-guide-modal.ts:3` |
| `assets/announce-banner.ts` | 257,741 | 公告横幅（JPEG） | `dataview-guide-modal.ts:4` |
| `assets/support-image.ts` | 124,219 | 设置页赞赏图 | `settings.ts:23` |
| `assets/gallery-cover-placeholder.ts` | 79,744 | 封面占位图 | `library-section.ts:14` |

合计 **899,023 B = `main.js` 的 17.6%**，其中二维码与公告图只在引导弹窗打开时用一次。

**做法**：照片类转 WebP（q80），二维码转 PNG8（必须保持可扫）。不改任何代码路径——只替换 base64 载荷。
**验收**：`main.js` ≤ 4.4 MB；引导弹窗肉眼验收，**二维码当场扫码确认**。
**风险**：低。**批次**：B1。
**不做**：改成随包外部文件 + 打开时读盘——收益有限，却要塞进发布流程与手动安装说明。

### P1-2 `styles.css` 构建期压缩

**证据**：896,298 B / 31,473 行，`esbuild.config.mjs` 直接拷贝源码。
**做法**：加一个 CSS 入口走 esbuild minify，产物仍名 `styles.css`。
**验收**：≤ 700 KB；三类页面肉眼抽查（看板 / 设置 / 覆盖层）。
**风险**：低（不改选择器语义）。**批次**：B1。

### P1-3 `i18n.ts` 外置 zh / zh-TW

**证据**：7,137 行 = en 2,345 + zh 2,342 + zh-TW 2,364 + 基础设施约 86；其余 8 种语言早在 `locales/`（72 文件 / 18,216 行），结构完全同构。
**做法**：纯移动 zh 与 zh-TW 到 `locales/`，en 留在原处当兜底基准。
**验收**：7,137 → 约 2,430 行；`verify-source-hygiene` 第 4 组（键集一致）+ 切换语言手测。
**风险**：低。**批次**：B1。
**注意**：本仓库是 CRLF，脚本化搬移后必须做一次行尾归一（一期踩过）。

### P1-4 `settings.ts` 拆分

**证据**：2,109 行；`renderWidgetSettings` 327、`renderGeneralSettings` 295、`renderCalendarSettings` 246，三个方法占 868 行。
**做法**：`src/settings/{general,widgets,calendar,integrations}.ts`，`SettingsTab` 只留骨架与保存。
**验收**：单文件 ≤ 500 行；新增一个设置项仍只改一处。
**风险**：低-中（与 `types.ts` 耦合紧，搬的时候手别抖）。**批次**：B4。

---

## 3. P2：结构性（需排期，收益是「下次改动」）

### P2-1 `library-section.ts` 2,595 行

**证据**：57 个函数；`renderLibrarySection` 单函数 **810 行**（502–1311），一个函数里同时做工具栏、5 种视图模式（grid/gallery/list/table/kanban）、分组、翻页。已有 **12 个** 用例覆盖（`library-*` / `table-columns` / `group-render-cap` / `card-delete` 等）。
**做法**：按「工具栏 → 视图分派 → 各自渲染」切：`library/toolbar.ts`、`library/body.ts`（按 `viewMode` 分派）、`library/kanban.ts`；卡片渲染沿用已有的 `renderFileCards` 等。
**验收**：单文件 ≤ 1,200；12 个用例全绿 + 5 种视图手测（含拖拽、就地编辑、删除）。
**风险**：中——这是用户主界面，DND 与就地编辑都在里面。**批次**：B5（最后做）。

### P2-2 `parser.serialize` 763 行

**证据**：`serialize` 763 行（`parser.ts:133`），`generateDefaultMarkdown` 301 行。序列化与 `section/defs` 注册表已由 `SECTION_TYPES` 漂移守卫对齐。
**做法**：`serializeCard()` 分派表 + 每类一个函数，与注册表 type 一一对应；`verify-section-registry` 增一组「序列化表覆盖全部 type」。
**前置**：先加 round-trip 用例（`parse(serialize(x))` 与原数据等值）——写盘路径出错会污染用户看板文件。
**验收**：加一种卡片类型只改两处（defs + 序列化表），漏一处有用例报警。
**风险**：中。**批次**：B4。

### P2-3 两处缓存卫生（小修）

**证据（含一处更正）**：
- `netease-client.ts:79` 的 `songUrlCache` 有 18 分钟 TTL，但**条目从不删除**——TTL 只决定「是否重取」。同文件 `lyricCache` / `coverCache` 已有 50 / 500 的 FIFO 上限，**不是问题**（此前审查把三个都算作无界，实测后更正）。
- `pipeline-section.ts:81` 的 `stageRenderLimits`（`列名::阶段` → 显示上限）**只增不减**：把阶段清空再填满，仍按旧上限渲染，「显示更多」不再出现。

**做法**：`songUrlCache` 加与 cover 同款 FIFO（500）；`stageRenderLimits` 在 `items.length <= PAGE_SIZE` 时删键。
**验收**：用例断言 map 有界、上限被重置。**风险**：低。**批次**：B1。

---

## 4. 批次

| 批次 | 内容 | 特点 |
|---|---|---|
| **B1** | P0-4、P1-1、P1-2、P1-3、P2-3 | 全是低风险高确定性，可合并成一次发布 |
| **B2** | P0-1 | 先写契约用例，再抽内核 |
| **B3** | P0-2、P0-3 | 都是「交互 + 路径」，用例必须先行 |
| **B4** | P1-4、P2-2 | 都是搬移，P2-2 需先补 round-trip |
| **B5** | P2-1 | 周期最长，放最后 |

每批独立可发布；`main.js` 体积变化只在 B1、B4 出现。

---

## 5. 闸门与度量

每批合并前必须：

1. `npm run check` 全绿（build + lint 0/0 + 全量用例）
2. 动到日期/时间 → 追加 `npm run audit:clock`
3. **每个新断言至少做一次变异验证**（改坏被测代码确认变红）；负向断言要扫全树，不要只查单文件

二期结束时的目标：

| 指标 | 现在 | 目标 |
|---|---|---|
| 单函数 > 120 行 | 38 | ≤ 20 |
| 同名重复函数组 | 31 | ≤ 20（formatDate / tree-ops / mergeData 三类清零） |
| `main.js` | 4.88 MB | ≤ 4.3 MB |
| `styles.css` | 896 KB | ≤ 700 KB |
| `i18n.ts` | 7,137 行 | ≤ 2,500 行 |
| 最大非 i18n 文件 | 2,595 | ≤ 1,200 |
| 用例 | 117 | ≥ 135 |

---

## 6. 明确不做

- **继续从 `view.ts` 搬方法**。剩下 2,431 行全是「读写 `this` 上的 leaf 状态」，搬出去换来的是几十成员的宿主接口——一期已经验证过这笔账不划算。
- **按选择器重组 `styles.css`**。31k 行，收益只是可读性，风险是视觉回归，且没有自动化的视觉回归用例。
- **把 en 字典也外置**。en 是兜底基准，留在 `i18n.ts` 里更好读。
- **引入运行时依赖**（UI 框架、CSS 框架、状态库）。插件启动要解析 `main.js`，任何依赖都直接变成启动成本。
- **为相似函数做「统一抽象」**。`str` / `clampByte` / `renderList` 这些同名函数多数只是重名，语义不同——合并会制造耦合。只处理本文列出的三组（merge、tree、formatDate），因为它们**逻辑确实相同**。
