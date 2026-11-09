# 架构

面向「要改这块代码」的人。它回答三件事：**一个东西该放在哪**、**一次刷新走哪条通道**、**改完怎么知道没坏**。
重构的历史与逐切片取舍见 [`REFACTOR_PLAN.md`](./REFACTOR_PLAN.md)。

---

## 1. 分层与依赖方向

```
main.ts                    插件生命周期、设置、workspace 文件、sync 接线
  └─ view.ts (DashboardView)   一个 leaf 一个实例；持有全部视图状态
       ├─ renderer.ts          看板渲染入口（只剩 renderDashboard + 转发导出）
       │    ├─ render/section-frame.ts   renderSection：头部 -> 齿轮 -> def.render(ctx)
       │    │    └─ section/defs/*.ts    每种卡片的渲染体（注册进 registry）
       │    │         └─ render/card.ts  卡片外壳 + renderCardBody 分派
       │    └─ render/{task-row,memo,project-doc,…}.ts  卡片内部结构
       ├─ view/*.ts            视图里被拆出来的职责（事件表、提醒、写盘、手机壳…）
       └─ section/{registry,state,config-modal}.ts  跨卡片的契约层
```

依赖**只向下**，禁止回指：

| 层 | 可以 import | 不许 import |
| --- | --- | --- |
| `parser.ts`（解析层） | `types` / `immersive-grid` / 纯工具 | `section/` `render/` `view.ts` |
| `render/**` | `types`、其他 `render/**`、`section/registry` | `view.ts` |
| `view/*.ts` | 上面所有，**但不 import `view.ts`** | `view.ts`（会成环） |
| `view.ts` | 全部 | — |

两条推导出来的规矩：

- **解析层不认渲染注册表**。`parser.ts` 的类型表是手抄副本，由 `verify-section-registry` 第 7 组钉住「解析表 == 注册表 types + aliases」。加一种卡片类型时两边都要加，测试会告你漏了哪边。
- **`view/*.ts` 不能 import `view.ts`**。视图那边的东西一律通过**宿主接口**注入（见 §5），这是把类方法搬出去的唯一可行姿势。

---

## 2. 渲染管线

```
DashboardView.render(data)
  ├─ 沉浸布局 → renderImmersiveBoard   （海报 + 置顶区 + 自由网格，返回 grid 当 board host）
  └─ 其它     → renderClassicBoard     （banner → main → 侧栏 + 滚动看板，返回 kanban）
        └─ renderDashboard(kanban, data, callbacks, …)
             └─ 每列一次 renderSection(el, column, …)
                  ├─ resolveSection(sectionType) ?? fallbackSection()   registry 派发，无 if 链
                  ├─ def.headerActions?.(ctx)                          齿轮/刷新/删除/加卡
                  └─ def.render(ctx)                                   卡片渲染体
                       └─ ctx.renderCards() → renderCard() → renderCardBody() 按卡片类型分派
```

**新增一种卡片类型**：在 `section/defs/*.ts` 里 `registerSection({ types, picker, scan, headerActions, render })`，再在 `parser.ts` 的 `SECTION_TYPES` 里补上类型名。其余（选择器、齿轮路由、删除按钮、刷新范围）全部由注册表推出来。

`SectionDefinition` 的关键字段：

| 字段 | 作用 |
| --- | --- |
| `types` / `aliases` | 规范 id 与退役 id（`memo`/`todo` → `sticky`，`notes` → `projects`） |
| `picker` | 出现在「添加分区」托盘里，`order` 决定位置（不靠注册顺序） |
| `scan` | `files` / `media` / `none`：**vault 变更后要不要重扫**。见 §3 |
| `headerActions` / `render` | 头部按钮、渲染体 |
| `fixedHeight` | 渲染前就需要高度的分区（web） |

---

## 3. 刷新：四条通道，别混用

改数据的**来源**决定走哪条路。混用会得到「闪一下」「不刷新」或者「整块重建」。

### 3.1 自己改的数据 → `planDashboardUpdate`（`render-update.ts`）

`'local'`（只重画变化的 section）/ `'external'`（全量）/ `'local-silent'`（已经就地画过，只**采纳**新数据，不重画）。
`local-silent` 不是优化而是正确性要求：不采纳新对象，后续签名比较会拿旧图算 before/after，得出「没变」。

### 3.2 vault 变了 → `vault-watcher` 去抖后 → `change-scope` 判范围

```
VaultWatcher (view/vault-watcher.ts)   五个监听 + 500ms trailing 去抖 + md 缓存滞后守卫
  └─ refreshSectionsFor (view/change-scope.ts)   这次变更落在哪些分区的扫描范围内
       ├─ 经典板：sectionInScope(col, paths, broad)          -> refreshScanningSections（签名守卫）
       ├─ 日历：任何 .md                                       -> refreshCalendarSections（就地换格）
       └─ 媒体：scan === 'media' 且媒体文件变了                -> refreshMediaSections
```

**沉浸板是另一套语义**（`immersiveTileInScope`）：整库扫描的分区**冻结**，只重建配置了范围且命中的 tile。这不是遗漏，是刻意的——每次重建都会换掉 tile 元素，在高频 vault 事件下看起来像频闪。同理，沉浸分支**不看 `broad`**：一次文件夹重命名不该重建所有 tile。

### 3.3 单个分区 → `refreshSectionInPlace`

先算渲染输入签名，未变则不换节点（防闪烁）；变了才换，并保滚动位置、沉浸 tile 定位、DnD 接线。齿轮改配置、手动刷新、`change-scope` 都走它。

### 3.4 就地小修 → 别重渲染

三类常见「只改一处」：任务勾选镜像（`render/task-row.ts` 的 `mirrorTaskToggleInPlace`）、折叠（`render/collapse.ts`）、widget 数据到达（`view/widget-refresh.ts`）。它们都**原位改 DOM**、不回渲染管线，因为重建会吃掉焦点、滚动、正在编辑的输入框。

### 3.5 谁该被通知：`section-refresh.ts` 的总线

分区渲染时 `registerSectionRefresh({ el, channels, paths, reload })` 注册一次；`refreshSectionsIn(container, channel)` 按 channel 触发（浮窗编辑那条还有 `refreshSectionsForPath(path)` 的便捷入口）。两个 channel 保留刻意的策略差异：

- `note-edited` — 看板内浮窗编辑器关闭后，**路径精确**、立即触发（dataview 卡只吃这个）。
- `vault` — vault 去抖后，容器级（日历只吃这个）。

---

## 4. 行为三件套（跨卡片，必须共用）

| 行为 | 入口 | 规则 |
| --- | --- | --- |
| 打开笔记 | `note-jump.ts` 的 `NoteOpeners` | 三种粒度（`file` / `atLine` / `inPopover`），都经 `DashboardView.openNote` 决定浮窗 vs 标签页 |
| 勾选任务写盘 | `task-toggle.ts` | 串行队列，失败 Notice 统一。乐观的 DOM 半边各卡片自己做 |
| 分区重载 | `section-refresh.ts` | 见 §3.5 |

新增一个「显示 vault 任务」的表面时，这三件都要接（参照 dataview 卡 / 日历网格的接法）。

---

## 5. 视图状态的归属

`DashboardView` 是**唯一**的视图状态持有者。搬到 `view/*.ts` 的代码遵守三条：

1. **状态留在视图**，模块只读写它。`mobilePanelState` / `newNoteState` 就是视图字段——做成模块级 `let` 的话，同一 vault 两个 leaf 会互相开关面板。窗口尺寸无关，leaf 数量才是原因。
2. **宿主接口用 getter，不用快照**。宿主对象只建一次（`xxx ??=`），所以 `settings()` / `data()` / `sync()` 都是函数。抓成字段的话，番茄钟换完背景再刷新读到的还是旧 `settings`。
3. **机制留视图，时机归模块**。`rewireAfterSwap`（重接 DnD）、`fullRender`（回退全量渲染）这类动作是视图的能力；模块只决定「什么时候叫」。

现有的宿主接口：`WidgetRefreshHost`、`MobilePanelHost`、`NewNoteHost`、`ChangeScopeHost`、`TaskWriteHost`、`BoardEventHost`、`ConfigModalHost`。

---

## 6. 明确不做

- 不引入状态管理库 / 虚拟 DOM。就地更新（prune / mirror）的收益是真实的，重写会丢掉焦点、滚动、输入中状态。
- 不做「一个通用 Card 组件渲染所有卡片」。各卡片的展示差异是产品需求。
- 不改 `render-update.ts` 的三档模型。
- 不把「长得像」的 UI 合并。`renderSectionState`（区块级空态：居中、图标、按钮）与列表内单行占位（`dashboard-library-empty`）刻意不统一——职责不同，合并会把列表撑成一大块。
- 不在同一次改动里同时改行为和结构。

---

## 7. 测试：改完怎么知道没坏

```bash
npm test                 # 串行跑全部 verify-*（每个都有自己的 test:* 脚本）
npm test -- <关键词>      # 只跑匹配的，如 `npm test widget`
npm run check            # build（tsc + esbuild）+ lint + 全量测试
```

- 每个 `scripts/verify-*.ts` 用 esbuild 打包到 `node_modules/.tmp/`，`obsidian` 用 `scripts/obsidian-stub.ts` 顶替，DOM 用 `scripts/mini-dom.ts`。
- **契约测试**（`verify-section-registry` / `verify-section-state` / `verify-section-config-modal` / `verify-section-config-write` / `verify-task-toggle-contract`）钉的是「一张表的多行是否仍同形」，不是单个功能。
- **源码断言**（`readFileSync` + `includes`）是必要的恶：它钉「这段逻辑还在这个文件里」。两条经验：
  - **正向断言**（「必须包含 X」）在代码搬走后**必然红**，这是好事——顺着红的地方把断言指向新文件即可。
  - **负向断言**（「不得包含 X」）在代码搬走后**静默恒真**，比不写还危险。跨文件搬迁时要对「新旧文件拼接文本」断言，或同时对旧文件断言「没有第二份实现」。
- **变异验证**：写完用例后改坏被测代码，确认测试真的会红。只写了没验证的断言，很可能一直在测一个恒真的东西。
- 搬代码时**同一条提交里同步搬源码断言**，否则下一个人会以为契约被破坏了。

---

## 8. 一处新增功能该放哪：速查

| 你要加的东西 | 放哪 |
| --- | --- |
| 一种新卡片类型 | `section/defs/*.ts` + `parser.ts` 的 `SECTION_TYPES` |
| 卡片内部的新结构 | 对应 `render/*.ts`（任务行 → `task-row.ts`，文档树 → `project-doc.ts`） |
| 一个新的 `dashboard-*` 事件 | 派发处 + `view/board-events.ts` 的路由表 |
| 一个新的配置弹窗 | `section/config-modal.ts` 的子类 + `view/config-modals.ts` 的启动器 |
| 一个新的侧栏 widget | `render/widget-mount.ts` 的目录表 + `render/widget-refresh.ts` 的刷新分支 |
| 一条新的写盘路径 | `view/task-writes.ts`（写进用户笔记）或 `sync.ts`（写看板数据文件） |
| 一次新的「vault 变了该刷什么」 | `view/change-scope.ts` 的判定 + `scan` 字段 |
