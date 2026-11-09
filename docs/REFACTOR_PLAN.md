# Apex Dashboard 架构梳理与重构规划

> 目标：把「每种卡片各写一套」收敛成「一套契约 + 若干声明」，让新增/修改卡片时不再四处修补。
> 原则：不追求一次性重写，按可独立发布的切片推进，每个切片都有回归闸门。
>
> **当前进度（2026-11-09）**：**全部 Phase 完成**。两个巨石已拆开——`renderer.ts` 4,557 → **110**，`view.ts` 3,822 → **2,431**；新增 28 个模块，验证脚本 108 → **115**（全绿），`npm run check` 全绿（lint 0 error 0 warning）。
> 架构与「改动该放哪」的结论已沉淀到 [`ARCHITECTURE.md`](./ARCHITECTURE.md)；**收益与前后对比见 [`REFACTOR_REPORT.md`](./REFACTOR_REPORT.md)**；本文件保留逐切片的取舍与历史。

---

## 一、现状速写

> 下表是 **2026-11-09 实测快照**（Phase 4 已完成，Phase 5 进行到切片 G）。「起点」列取自 Phase 4 开工前的 `HEAD`，用来对照。

| 指标 | 起点（Phase 4 前） | 当前 |
| --- | --- | --- |
| src/ 代码量 | 109,588 行 / 316 个 `.ts` | 110,408 行 / 335 个（净增 820 行，全是模块头、导入与转发导出） |
| `renderer.ts` | 4,557（最大巨石） | **110**——只剩 `renderDashboard` + `destroyAllCharts` + 一段转发导出 |
| `view.ts` | 3,822（最后一个巨石） | **2,431**（−36.4%） |
| 拆分出的模块 | — | `src/render/` 17 个 4,759 行 + `src/view/` 11 个 2,408 行（合计 28 个，`view.ts` / `renderer.ts` 本体不计） |
| 最大单文件 | `i18n.ts` 7,127 | `i18n.ts` 7,127 / `library-section.ts` 2,595 / `view.ts` 2,431（已无「巨石」） |
| 卡片（Section）类型 | 15 种（sticky/folder/library/projects/dataview/pm/pipeline/skills/calendar/rss/images/videos/web/weread/ticktick）+ 3 个遗留别名 | 不变 |
| 侧边栏 Widget | 16 种 | 不变 |
| 配置弹窗 | 22 个 `*-config-modal.ts` / `*-settings-modal.ts` | 不变（Phase 3 已统一到 `SectionConfigModal<T>`） |
| 验证脚本 | 107 个 `scripts/verify-*` | **115** 个 verify = 115 个 `test:*` script，`npm test` 统一入口，全绿 |
| 空态样式类 | 约 34 个互不相同的 `dashboard-xxx-empty` | 未动（P4 仍有待收敛） |

已经做得好的部分（**不要动**）：

- 刷新管线：`render-update.ts` 的 `none / sections / full` 三档计划 + `refreshSectionInPlace` + `scroll-preserve.ts`，是全项目最统一的一块。
- 行壳：标题 / 双击重命名 / 折叠 / 拖拽高度 / 并排宽度，全部由 `renderSection` 统一渲染（现位于 `render/section-frame.ts`，Phase 4 切片 I）。
- 悬停预览：`hover-preview.ts` 的 `attachNoteHover` 已被 5 个模块复用。
- 勾选写盘：`alltasks-scan.ts:338 toggleTaskInFile` 已是唯一写盘实现，dataview 的 `commitTaskToggle` 也复用了它。

---

## 二、六个结构性问题

### P1　没有 Section 契约，新增一种卡片要改 7 处

**现象**：`sectionType` 是裸字符串（`types.ts:1398 sectionType?: string`，**无枚举**）；`renderSection` 里是一段 550 行的 if 链（`renderer.ts:2447-2997`）。

**新增一个卡片类型必须同步修改**：

1. `add-section-modal.ts:20` 的 `SECTION_TYPE_OPTIONS`
2. `types.ts` 给 `DashboardColumn` 加 `xxxConfig` 字段
3. `sync.ts` 加 `updateXxxConfig`（现有 9 个）
4. `renderer.ts` 的 `renderSection` 分支
5. `renderer.ts:4416` 的 `getSectionType`
6. `view.ts:760` 的事件路由 + `openXxxConfigModal`（现有 11 个）
7. `view.ts:2132` 的默认配置 + `view.ts:3267` 的刷新 scope 判定

**后果**：漏掉任意一处，卡片就「能渲染但点齿轮没反应」「手动刷新有用但笔记改了不更新」「沉浸模式不刷新」——这类问题在过去几个月反复出现。

### P2　同一个交互行为有 2–4 套实现

**任务勾选（最典型，3 套）**

| 场景 | 乐观更新 | 持久化 | 刷新 |
| --- | --- | --- | --- |
| 待办清单卡片 | `renderer.ts:3504 mirrorTaskToggleInPlace`（含完成行为重排） | `sync.ts:266 toggleTaskQuiet`（读改写队列，镜像到日记） | 不通知，靠签名守卫 |
| dataview 卡片 | `dataview-section.ts:440 patchTaskChecked`（不可变页副本） | `commitTaskToggle` → `toggleTaskInFile` | `makeTaskToggleHandler` 就地重算 + 剪除 |
| 日历 / 日程弹窗 | 直接改 `task.checked` + `row.toggleClass` | `calendar-section.ts:172` → `toggleTaskInFile` | `scheduleGridRefresh` 150ms 去抖 + `requestCalendarRefresh` |
| TickTick 卡片 | 无 | 远端 API `completeTask` | 重跑查询 |

四套实现意味着四套失败处理（`Notice` / 静默 / `console.error` / 无）、四套并发策略（队列 / 无 / 去抖 / 无）、四套「连点两次会怎样」的答案。**「连点后状态错乱」「勾选闪烁」这两个 bug 各自在不同卡片里被独立修过一遍**，就是分散的代价。

**点击打开笔记（5 套）**

- `dataview-section.ts:1615 attachRowOpen`：`is-clickable` + `is-jumpable` + hover + 忽略 `a, .dashboard-wikilink, .dashboard-dataview-task-checkbox`
- `calendar-grid.ts:552 / 602 / 657`：三处几乎相同的 `row.addClass('is-jumpable')` + 点击忽略 `INPUT` / `a`
- `calendar-modal.ts:540`：又一份
- `pipeline-section.ts:610`：600ms 延时打开 popover（拖拽保护）
- `library-section.ts:1382` / `media-*`：只有 hover，没有整行跳转

忽略选择器、光标类、是否带行号、是否延时，每家都不一样。

**弹窗编辑后刷新（3 套 + 大量空白）**

- calendar：`calendar-section.ts:26 sectionReloaders`（WeakMap 存 reload 闭包）
- dataview：`dataview-section.ts:52 registerDataviewSection`（`{el, paths, reload}` + `isConnected` 剪枝）
- 其他卡片：没有专门通道，只能等 vault 变更 500ms 去抖，或者干脆不刷新

dataview 的注册表是**正确解法**，但它是 dataview 私有的，calendar 又另写了一份近似的。

### P3　每个渲染模块各存一份「当前上下文」全局变量

```
renderer.ts:162   activeHoverParent / activeNoteOpener / activeMarkdownComponent
dataview-section.ts:16  dvHoverParent / dvOpener / dvLineOpener / appRef
library-section.ts:20   libHoverParent / libOpener / activeCalendarPopup
```

全项目 35 个模块级 `let`（renderer 8、dataview 4、library 3）。后果：

- 渲染函数靠「先赋值全局再调用」传递上下文，调用顺序错就静默失效；
- 同一份数据（hoverParent、opener）被复制三份，新增卡片就要再复制一份；
- 无法对单个 section 做单元测试（必须先摆好全局）。

### P4　空态 / 加载态 / 错误态各写各的

约 34 个不同类名、不同 DOM 结构、不同文案键。`dataview-section.ts:186-202` 有一组私有实现（`renderEmptyState / renderScanningState / renderErrorState`），其余各卡片手搓 div。样式靠 CSS 逐个对齐，改一次视觉规范要翻十几个文件。

### P5　header 按钮 + 配置链路靠复制粘贴

- `renderer.ts` 里 38 处 `dashboard-section-add-btn`：每个分支手写「配置齿轮 + 刷新 + 删除 + 该类型私有按钮」。
- 配置链路 5 段同构：`dispatch CustomEvent` → `view.ts:760` if-else 路由 → `openXxxConfigModal` → `modal.open()` → `onSave → sync.updateXxxConfig` → `notify('local')` → 该列就地重建。
- 22 个配置弹窗全部 `extends Modal` 手写 `onOpen`：标题、说明、保存/取消、`applyModalTheme`、脏检查各写一遍。

卡内私有操作（ticktick 视图切换、pipeline 排序、pm 归档、skills pin）走「专用事件 + `suppressNextRender`」的旁路（`view.ts:803-1035`），与主链路并存，两套心智模型。

### P6　没有统一回归闸门

101 个 `test:*` 脚本，原本**没有跑全量的入口**，重构时无法一次性确认「没弄坏别的卡片」，只能靠记忆挑几个跑——这正是重构不敢做的根因。

> **已处理（Phase 0 第一步）**：新增 `scripts/run-all-tests.mjs` + `npm test`（串行跑全部 + 汇总 + `--bail` / 关键词过滤），并补 `npm run check`（build + lint + test）。
> 首次跑出 3 个**长期红着**的用例，均已修：`verify-library-card-size`（S/M/L 已改成下拉，断言停留在旧的三按钮结构）、`verify-material` 与 `verify-material-render`（分组顺序断言写死了某一种 locale 排序，现改为断言成员 + 根组优先 + 按 key 取组）。

---

## 三、目标架构

四个抽象，全部放在新目录 `src/section/` 下（不动现有文件的对外接口，逐卡迁移）。

### 3.1 `SectionDefinition` 注册表 —— 替代散落的 if 链

```ts
// src/section/types.ts
export interface SectionContext<C = unknown> {
  app: App;
  column: DashboardColumn;
  config: C;
  el: HTMLElement;                    // section body 容器（行壳已由 renderSection 提供）
  open: NoteOpeners;                  // 统一打开方式，见 3.3
  hover: HoverParent | null;
  mobile: boolean;
  /** 局部改配置：内部完成「写盘 + 本列就地刷新」 */
  patchConfig(patch: Partial<C>): void;
  /** 注册手动刷新（header 的刷新按钮由注册表统一渲染） */
  registerReload(fn: () => void | Promise<void>): void;
  callbacks: SectionCallbacks;        // 收敛后的最小回调集
}

export interface SectionDefinition<C = unknown> {
  type: SectionType;                        // 联合类型，不再裸字符串
  label(): string;
  icon: string;
  createConfig(): C;
  /** 渲染 body；返回可选的 destroy（替代散落的 destroyXxxSection） */
  render(ctx: SectionContext<C>): void | (() => void);
  /** 声明式 header 按钮：配置/刷新/删除由框架补，这里只写私有按钮 */
  headerActions?(ctx: SectionContext<C>): HeaderAction[];
  /** 该类型关心哪些笔记路径（null = 全量），驱动「编辑后刷新」 */
  paths?(ctx: SectionContext<C>): (() => string[] | null);
  /** 刷新策略：vault 事件 / 手动 / 弹窗编辑后 */
  refresh?: { vault?: 'md' | 'media' | 'none'; onNoteEdited?: boolean; manual?: boolean };
  configModal?(app: App, config: C, save: (next: C) => void): void;
}
```

注册表接管的 7 处 → 1 处（新增文件 + 一行 `registerSection(def)`）。

### 3.2 `SectionRefreshBus` —— 统一「谁该刷新」

```ts
// 从 dataview 私有注册表提升为通用设施
export interface RefreshRegistration {
  el: HTMLElement;
  paths: () => string[] | null;   // null = 关心全部
  reload: (mode: 'quiet' | 'full') => void | Promise<void>;
}
registerSectionRefresh(reg): () => void;
refreshSectionsForPath(path: string): void;   // popover 编辑后
refreshSectionsForVault(kind: 'md' | 'media', paths: string[]): void;
```

现有三条通道（vault 去抖、popover 编辑、手动刷新）全部改为**向 bus 要「该刷谁」**，取代 `view.ts:3267 inScope` 与 `renderer.ts:2053 scanningSectionSignature` 里硬编码的类型判断。dataview 的 `dvSectionHandles` 与 calendar 的 `sectionReloaders` 合并成一个。

### 3.3 行为三件套

**(a) `NoteOpeners`** —— 打开笔记的唯一出口

```ts
interface NoteOpeners {
  file(file: TFile): void;              // 尊重「禁用弹窗」设置
  atLine(file: TFile, line: number): void;  // 弹窗 + revealMarkdownLine
  inPopover(file: TFile, subpath?: string): void;
}
attachNoteJump(el, opts: {
  file: TFile; line?: number | null;
  ignore?: string;          // 默认 'a, .dashboard-wikilink, input[type=checkbox]'
  hoverParent?: HoverParent | null;
  openers: NoteOpeners;
}): void;
```

替换：`attachRowOpen`、`calendar-grid.ts` 三处、`calendar-modal.ts` 一处、`pipeline-section.ts` 的延时打开（延时作为 `delayMs` 选项）、`renderer.ts:4175/4282/4507` 的内联链接。`is-jumpable` / `is-clickable` 成为唯一光标约定。

**(b) `TaskToggleService`** —— 一个写盘底座，三个适配器

```ts
interface TaskToggleRequest {
  notePath: string;
  line: number;            // 源文件行号（唯一定位依据）
  nextChecked: boolean;
  origin: 'card' | 'dataview' | 'calendar' | 'ticktick';
}
class TaskToggleService {
  /** 统一：串行队列（防并发读改写互相覆盖）→ 写盘 → invalidatePath → 广播 */
  toggle(req: TaskToggleRequest): Promise<ToggleOutcome>;
  onSettled(fn: (req, outcome) => void): () => void;
  onFailed(fn: (req, err) => void): () => void;   // 统一 Notice 文案
}
```

各卡片**保留自己的乐观更新**（展示模型不同，这层不该统一），只把「写盘 + 并发 + 失败提示 + 失效通知」收到一处：

| 适配器 | 乐观更新（保留） | 交给 service |
| --- | --- | --- |
| 待办卡片 | `mirrorTaskToggleInPlace` + `sync.applyTaskToggle` | 写盘 + 日记镜像 + 队列 |
| dataview | `patchTaskChecked` + prune | 写盘 + `invalidatePath` |
| 日历 | 行 `is-done` + 重排 | 写盘 + 去抖重扫 |
| TickTick | 无 | 远端 API（同一接口，异步策略） |

**(c) `SectionStateView`** —— 空/加载/错误统一

```ts
renderSectionState(el, { kind: 'loading' | 'empty' | 'error'; text: string; hint?: string; action?: { label, onClick } });
// 统一类名：.dashboard-section-state / --loading / --empty / --error
```

保留旧类名作为附加类（`.dashboard-dataview-empty` 等），避免一次性改 CSS 造成视觉回归。

### 3.4 `SectionConfigModal<T>` 基类

提供：标题/说明布局、`applyModalTheme` 自动调用、保存/取消按钮与脏检查、`close → 清理`。22 个弹窗只写字段区。与 3.1 的 `configModal` 钩子 + 统一 `updateSectionConfig(col, cfg)`（替代 9 个 `updateXxxConfig`）配套。

---

## 四、迁移路线（每个 Phase 可独立发布）

### Phase 0　建闸门 —— 已完成

1. ✅ `npm test`：串行跑全部 115 个 `test:*`，输出通过/失败汇总与耗时（`scripts/run-all-tests.mjs`）。
2. ✅ `npm run check` = `build` + `lint` + `test`。
3. ✅ 修好 3 个长期失败的用例（见 P6）。
4. ✅ `docs/ARCHITECTURE.md` + `src/section/` 骨架。`src/section/` 后来在 Phase 2 长成了真的注册表；文档在 Phase 5 结束后重写，内容以代码现状为准（分层与依赖方向、四条刷新通道、注册表契约、宿主接口、测试约定）。

**验收**：`npm test` 全绿；纯新增文件，`main.js` 产物不变。

### Phase 1　行为三件套（1–2 天，收益最高）——已完成

顺序很关键：**先统一行为，再统一结构**。因为用户能感知的 bug 都在行为层，而且改行为的风险边界清楚。

> **进度**：
> - ✅ 切片 A `attachNoteJump` + `NoteOpeners`（`src/note-jump.ts`）：dataview 行、日历网格三处、日程弹窗行已迁移；pipeline 的单击+双击重命名是另一种手势，保持原样。
> - ✅ 切片 B `writeTaskToggle`（`src/task-toggle.ts`）：dataview 与日历系的勾选写盘收敛为一个串行队列（修掉两卡并发写同一笔记的丢更新），失败 Notice 统一；待办卡片保持 `sync.toggleTaskQuiet` 自有通道（写的是看板数据文件+日记镜像，另一种工件）。
> - ✅ 切片 C `SectionRefreshBus`（`src/section-refresh.ts`）：dataview 私有注册表与日历 sectionReloaders 合并为带 channel 的总线。pipeline/library/pm 不需要接 popover 编辑刷新——它们的扫描卡本来就走 vault 去抖（500ms 后必刷，签名守卫防闪烁）。
> - 新增契约测试：`verify-task-toggle-contract`、`verify-section-refresh`；`verify-dataview-task-open` 改为行为断言。
> - ✅ 遗留已清：17 个 `no-base-to-string`（pipeline/pm 模型层）随 Phase 3/4 的搬移消解；两条 `sentence-case` 告警按「技术标识符不套句首大写」处理（pipeline 状态字段直接去掉重复的 placeholder，skill 名占位改句首大写）。**`npm run lint` 现为 0 error 0 warning**，`npm run check` 全绿。

1. `attachNoteJump` + `NoteOpeners` 落地；迁移 dataview → calendar-grid → calendar-modal → pipeline。
2. `TaskToggleService` 落地；先接 dataview 与日历（这两家的写盘路径本来就一致），再接待办卡片（需把 `toggleTaskQuiet` 的日记镜像搬进 service）。TickTick 最后接。
3. `SectionRefreshBus` 落地；把 dataview 的注册表与 calendar 的 `sectionReloaders` 合流，给 pipeline / library / pm 接上「popover 编辑后刷新」。

**验收**：`verify-dataview-task-toggle`、`verify-task-toggle-quiet`、`verify-calendar-*`、`verify-dataview-task-open`、`verify-dataview-edit-refresh` 全绿；新增契约测试 `verify-task-toggle-contract`（四适配器共用一套断言）。

### Phase 2　Section 注册表（2–3 天）——已完成

> **进度**：
> - ✅ `src/section/registry.ts`：`SectionDefinition`（types/aliases/picker/fixedHeight/holdsCards/headerActions/render）+ `SectionContext`（el/header/actions/column/app/data/settings/callbacks/hoverParent/openNoteInPopover/buttons/setReload/renderCards）+ `createSectionButtons`（config/refresh/remove/addCard 统一图标、类名、事件路由）。
> - ✅ 15 个类型按领域拆到 `src/section/defs/{cards,media,data,tasks,boards}.ts`，`src/section/index.ts` 副作用注册。
> - ✅ `renderSection` 的 if 链（原 2447–2997）删掉，改为 `def.headerActions?.(ctx); def.render(ctx);`；`getSectionType` 的 15 行名称表改为 `hasSectionType` + `canonicalSectionType`（memo/todo→sticky、notes→projects 走 alias）。
> - ✅ `SECTION_TYPE_OPTIONS` 由 `sectionPickerOptions()` 生成（顺序由 entry 的 `order` 决定，不再依赖导入顺序）。
> - ✅ 配置齿轮的 `dashboard-library-config` 事件现在带上规范 `sectionType`，`view.ts` 的路由不再自己猜类型。
> - ✅ 契约测试 `verify-section-registry`（选择器顺序、别名、每类 header 按钮组成、空态/回退渲染、重复注册报错、renderer 无残留 if 链）。
> - ✅ 遗留收尾：`SectionDefinition.scan: 'files' | 'media' | 'none'`，`render/section-refresh.ts` 里那两个 `Set`（`SCANNING_SECTION_TYPES` / `MEDIA_SECTION_TYPES`）删掉，改读 `sectionScan(getSectionType(column))`。在此之前「新加一种扫描型分区」要改两处，漏一处就**静默永不刷新**。
> - ✅ `parser.ts` 的 `SECTION_TYPES` **保持手抄**，但加了守卫：parse 层不该 import 渲染注册表（解析先于任何 section 注册，且看板文件里写错类型名不该依赖渲染层），所以 `verify-section-registry` 第 7 组断言「解析表 == 注册表 types + aliases」。手抄可以接受，漂移不行。
> - ✅ 顺手删掉 `SectionDefinition.holdsCards`：注释说「parser 提取卡片别名时会跳过它」，但全仓无人读取——一条会误导人的死字段比没有更糟。
> - ⚠️ `sync.ts` 的 config 合并已在 Phase 3 收成 `updateSectionConfig`；「无卡片类型」列表在 parser 里已经不存在（本轮确认），无需再收。

**验收**：✅ `renderSection` 只剩注册表派发；✅ `SECTION_TYPE_OPTIONS` 由注册表生成；✅ `view.ts` 路由按规范类型走。

### Phase 3　配置与状态视图（1 天）——已完成

1. `SectionConfigModal<T>` 基类，迁移 22 个弹窗（可分批）。
2. `renderSectionState` 统一 34 个空态。
3. `updateSectionConfig` 合并 9 个 sync 方法。

> **进度**：
> - ✅ 切片 A `renderSectionState` / `configureStateAction`（`src/section/state.ts`）：空/加载/错误态一套标记（`.dashboard-section-state` + `--empty/--loading/--error/--compact`），图标用 `setIcon` 真图标而非 CSS mask；「打开本卡配置」按钮统一 `configureStateAction`，冒泡的事件与 header 齿轮完全相同（含规范 `sectionType`）。
> - ✅ 已迁移：dataview（空/扫描/错误三态）、web、rss 未配置态、pipeline 未配置、pm 未配置、skills 空态（compact 变体，保留 `grid-column: 1 / -1`）、folder 未配置。
> - ✅ 旧根类名作为附加类保留（`.dashboard-dataview-empty`、`.dashboard-skillsec-empty` 等），CSS 里布局类（grid span、flex 增长）继续生效；视觉规则集中到 `styles.css` 末尾一个新块。
> - ✅ 契约测试 `verify-section-state`（形状/顺序/紧凑变体/按钮冒泡/旧类保留/folder 真渲染/旧子类名零残留）。
> - ✅ 切片 B `SectionConfigModal`（`src/section/config-modal.ts`）：弹窗外壳收成一个抽象基类——contentEl/containerEl 类、`applyModalTheme`、`.dashboard-modal` 框架、标题、body、footer（取消/保存）、`onClose` 清理全部由基类完成；子类只写 `title() / renderBody() / submit()`，可覆写 `sizeClass / contentClass / saveLabel / buildFooter`。
> - ✅ footer 在 body **之前**构建、但排在 body **之后**的 DOM 位置：需要拿 `confirmBtn` 做校验禁用的弹窗（rss 的 URL 校验）在首次渲染时就能拿到按钮。
> - ✅ 已迁移 6 个：web / rss / media / dataview / notes / library（覆盖 data + media + 卡片类）。rss 的 `trySave` 收敛为 `submit()` 并复用基类的 `confirmBtn`；library 的透明容器通过 `styleContainer()` 钩子保留。
> - ✅ 契约测试 `verify-section-config-modal`（外壳/重复打开不叠 DOM/保存与取消接线/footer 先于 body/变体与自定义按钮/零残留）。
> - ✅ 切片 C `updateSectionConfig`（`src/sync.ts`）：9 个 `updateXxxConfig` 的读-改-写合并为 `updateSectionConfig(columnName, key, config)` + 私有 `patchColumn()`；key 列表 `SyncEngine.SECTION_CONFIG_KEYS` 成为「哪些字段是卡片配置」的唯一声明。未知列名直接短路（不再写一份一模一样的看板）。`updateNotesSectionConfig` 收敛到同一 helper，仍是「配置 + showCover」一次写盘。
> - ✅ 27 个 `view.ts` 调用点改走 `updateSectionConfig(name, 'xxxConfig', cfg)`；契约测试 `verify-section-config-write`（每键一写/不串列/未知列零写/notes 双字段一次写/旧方法名零残留）。
> - ✅ 弹窗全部迁移（18 个 `*ConfigModal` + 2 个叠在其上的选择器）：folder / pipeline / pm / weread / skill-section / skill-create / skill-widget / task-card / tracker / weather / quick-note，以及 `MultiFolderSelectModal`、`CommandSearchModal`（后者用 `buildFooter` 只放取消）。
> - ✅ 新增 `frameClass()` 钩子：skill 的两个弹窗、quick-note 的 `dashboard-quicknote-config` 要靠框架类做作用域；`sizeClass()` 返回 `''` 即全宽（pipeline）。
> - ✅ quick-note 的「增删行重绘整框」改为 `repaint()`：只清空 `this.body` 重画字段，外壳与用户马上要点的保存按钮不再被重建。
> - ✅ 契约测试覆盖文件清单扩到 18 个，并新增「不得自建 footer」「覆写 onClose 必须 `super.onClose()`」两条规则（weather 的防抖计时器是真需要的清理）。
> - ✅ **刻意不迁移**的剩余空态（`dashboard-library-empty` 19 处、`dashboard-rss-empty`）：它们是**列表内的单行占位**（12px、10–40px 内边距、无图标），和 `renderSectionState` 的「区块级空态」（居中列、图标、按钮）是两种视觉角色；强行统一会把列表占位撑成一大块。这与 dataview 刻意不接 vault 去抖是同一类决定——共享的是行为，不是外观。
> - Phase 3 完成。顺带记下一条经验：把「长得像」的 UI 合并前先确认它们**承担同样的职责**；只有标记结构一致、职责不同的合并，反而会制造下一轮「为什么列表空态这么大」的 bug 报告。

**验收**：视觉零回归（截图对比关键卡片空态）；`verify-*-config` 全绿。

### Phase 4　拆分巨石（持续，按需）——已完成

`renderer.ts` 按职责切成 `card/render-card.ts`、`widget/render-widgets.ts`、`task/render-task-list.ts`；`view.ts` 切成 `view/lifecycle.ts`、`view/events.ts`、`view/refresh.ts`。**只搬不改**，每搬一块跑全量测试。

> 实际落地的命名与这份设想不同（`render/{card,task-row,section-frame,widget-mount,…}.ts`、`view/{board-events,config-modals,reminders,vault-watcher,…}.ts`）：切分顺序最终按**依赖方向**排，而不是按「看起来该在一块」排——`section-refresh` 依赖 `section-frame`，`task-row` 依赖 `note-index`/`text-links`，DAG 决定目录结构。逐切片的取舍见下方进度条目与产物清单。

> **进度**：
> - ✅ 切片 A：`src/render/sidebar-reading.ts`（715 行）——阅读追踪侧栏组件 + 它的四个弹窗（结束计时、编辑书籍、搜书、阅读统计）。整块几乎零耦合（只用 `ReadingService` / 书籍搜索 / `setIcon` / `t`），原位置是 `renderer.ts` 中最大的一块无关职责。`renderer.ts` 4557 → 3847 行。
> - ✅ 顺手抽出 `src/render/time-format.ts` 的 `formatTime`：番茄钟与阅读都在用它显示计时，原来只存在于 renderer 里、跨模块只能重复实现。
> - ✅ 移动方式：整段剪切 → 改相对导入 → `renderer.ts` 保留 `export { … } from './render/sidebar-reading'`，外部调用点（`reading-mini-timer`、`view.ts`）零改动。
> - ✅ 经验：抽出去的副作用是「原文件留下的 import 变成 unused」——eslint 会一次性列出，照着删即可；但 `export … from` 不会让本地 import 变成"已使用"，只 import 真正在本文件调用的名字。
> - ✅ 切片 B：`src/render/reminder-popup.ts`（272 行）——任务行上的提醒芯片 + 弹窗（设置/清除/逾期样式）。整簇只用 `setIcon` / `t` / 行元素与回调，`renderer.ts` 只保留 `createReminderButton` 的 import。`renderer.ts` 3847 → 3586 行。
> - ✅ 连带修了一处测试耦合：`verify-task-toggle-quiet` 原来 grep `renderer.ts` 找 `pathOf: () => number[],`，现在改为读新模块——**搬代码时要同步搬「源码断言」**，否则测试会以"契约被破坏"的形式误报。
> - ✅ 切片 C：`src/render/tracker-chart.ts`（181 行）+ `src/render/color.ts`（50 行）。图表簇必须整簇移动——`chartInstances` / `destroyChart` / Chart.js 的注册都跟着走，`destroyAllCharts` 改为调用 `destroyAllChartInstances()`，行为不变。`getCSSVar` / `isAccentLight` / `isLightColor` / `relativeLuminance` 因为图表和强调色文字都要用，独占成 `color.ts`。`renderer.ts` 3586 → 3380 行。
> - ✅ 切片 D（为 D2 铺路）：`note-index.ts`（102 行）+ `link-context.ts`（29 行）+ `text-links.ts`（92 行）。`renderWikilink` 簇原本离不开 renderer，因为它要读 `activeHoverParent` / `activeNoteOpener` / `activeMarkdownComponent` 和 `resolveNoteFile`；不先拆出去，任务行模块就得反向 import `renderer.ts` 形成环。做法：basename 索引整簇搬进 `note-index.ts`，三个环境变量收进 `linkContext` 对象（**可变字段，不做 setter**——调用点仍是直接赋值，跟搬迁前一致），`renderTextWithLinks` 落在 `text-links.ts`。`renderer.ts` 保留 `export { renderTextWithLinks } from` / `export { teardownBasenameIndex } from`，`calendar-*.ts` 与 `main.ts` 零改动。
> - ✅ 切片 D2：`src/render/task-row.ts`（555 行）——`renderTaskBody` / `renderTaskItem`（递归行、移动端手势、拖拽、双击编辑）/ `mirrorTaskToggleInPlace` / `readTaskPath` + `taskDragSource`、`pendingTaskAddFocus` 这两个模块级状态一起走。折叠那一组（`isDescendantPath` / `readPathAttr` / `toggleCollapseInPlace`）**不是任务专属**：项目文档行也用同一套（`data-doc-path`），所以单独成 `collapse.ts`（108 行），两边共用。
> - ✅ 切片 D3：`src/render/memo.ts`（206 行）——便签卡的视图/编辑切换、同步纯文本绘制、markdown 渲染与链接接线，连 `memoMarkdownSource` 一起搬（view 侧也要用）。
> - 📉 累计：`renderer.ts` 4557 → 2391 行（−48%），`src/render/` 现有 11 个模块共 2327 行。
> - ✅ 一条测试经验：源码断言里「不得出现 X」这类负向检查，文件搬迁后**会静默通过**（因为 X 已不在旧文件里）。`verify-task-toggle-quiet` 改为对 `rendererSrc + taskRowSrc` 拼接文本做负向断言，正向断言才指向新模块。
> - ✅ 切片 E：`src/render/project-doc.ts`（254 行）——项目卡的递归文档树（折叠/拖拽重排/嵌套/删除/打开）+ 添加文档搜索行。`renderDocItem` 原本是 `renderProjectBody` 里的闭包，整块搬即可；顺手把历史遗留的**整段多一级缩进**规范掉（纯空白改动）。唯一的行为等价改写：卡片级「跨卡投放文档」的落点监听留在 renderer（它属于卡片外壳），改为调用 `currentDocDragSource()` 只读访问器，拖拽状态仍由模块自己持有。
> - ✅ 切片 F：`src/render/sidebar-widgets.ts`（489 行）——侧栏天气 / 番茄钟（含活动选择器）/ 倒计时三件套。它们的共同点不是外观而是**跨渲染持有状态**（天气缓存与请求、番茄钟跳动、按内容元素索引的 interval），所以 `countdownTimers` 跟着搬走，`destroyAllCharts` 改为 `destroyAllChartInstances()` + `destroyIdleCountdownTimers(preserveWidgets)` 两步，preserve-scope 语义不变。
> - ✅ 切片 G：`src/render/card.ts`（559 行）——卡片外壳（封面 / 头部 / 动作按钮 / 宽度拖拽）+ `renderCardBody` 分派 + 天气卡体 + 追踪器卡体。**`getSectionType` 刻意留在 renderer**：它被扫描刷新、媒体刷新、section 构建三处共用，属于「看板级」判断而非「卡片级」渲染。
> - 📉 累计：`renderer.ts` 4557 → 1169 行（−74%），`src/render/` 15 个模块共 3629 行。
> - ✅ 又一处测试耦合：`verify-task-complete-behavior` / `verify-task-daily-source` 都在 grep `renderer.ts` 找「齿轮打开配置弹窗」。卡片外壳搬走后这两条必然失败——**这是好事**，说明断言确实钉在真实代码位置上，比静默通过强。已改为读 `src/render/card.ts`。
> - ✅ 切片 H：`src/render/widget-mount.ts`（594 行）——widget 目录表（`buildWidgetEntries`）、挂载（`mountWidgetCard`）、条带签名（`sidebarWidgetSignature`，决定能否复用 DOM 而不是重建）、条带内拖拽排序，以及 `resolveEffectiveLayout` / `isImmersiveLayout` / `isStackedLayout` 三个布局判定与 `renderSidebarWeekCalendar`。
> - ✅ 切片 I：`src/render/section-frame.ts`（373 行）——折叠状态持久化、两种宽度拖拽（整节宽度 / 配对列分栏）、`getSectionType`、`renderSection`（头部 + 齿轮 + 卡片列表），`renderSectionCards` 直接把每张卡交给 `render/card.ts`。
> - ✅ 切片 J：`src/render/section-refresh.ts`（163 行）——扫描型 section（library / folder / pipeline / pm，靠渲染输入签名守卫）与媒体 section（images / videos）的就地换节点刷新。两者放在一起是因为回答同一个问题「这一节渲染用到的东西真的变了吗」，且都只替换单个 section 节点而非重绘看板。
> - ✅ 收尾：`renderer.ts` 现在只剩 110 行——`renderDashboard` 入口、`destroyAllCharts` 前置清理、以及一整段「转发导出」。转发导出不是惰性：它把这次拆分变成可 review 的「纯移动」，`view.ts` / `calendar-*.ts` / `main.ts` 与 9 个 verify 脚本一行都没改。
> - 📉 **Phase 4 完成**：`renderer.ts` 4557 → 110 行（−97.6%），`src/render/` 17 个模块共 4759 行。单文件最大 715 行（sidebar-reading），已不存在「巨石」。
> - ✅ 一条切片方法论（本轮最有用）：搬迁顺序要按**依赖方向**排，不是按行号。`section-refresh` 依赖 `section-frame` 的 `renderSection` / `getSectionType`，所以先搬 frame 再搬 refresh，DAG 自然成立；反过来就得在两边来回改导入。
> - ✅ 下一阶段（Phase 5）已按其预言完成：`view.ts` 确实是最后一个巨石（3822 行），确实不能照 `renderer.ts` 的办法切——**类方法不是模块函数**，每次外移都先把 `this` 的依赖窄化成宿主接口。这条方法论后来在 11 个模块里重复验证了 11 次。

### Phase 5　拆分 `view.ts` —— 已完成

> - ✅ 切片 A：`src/view/reminders.ts`（243 行）——提醒扫描五趟：任务行、pipeline 笔记 `due`、PM `keyDate`、倒计时、纪念日。扫描是 `(data, settings, fired 集合)` 的纯函数，视图只留 `setInterval` 与 key 集合，写回通过 `editTaskReminder` 回调注入。
> - 🐞 **搬迁中发现并修掉一处结构缺陷**：倒计时那一趟被嵌在 PM 列循环**里面**（编辑时多缩进了一级），于是①在没有 PM 分区的看板上倒计时提醒**从不触发**；②pipeline / PM / 纪念日三趟各自按列数重复执行。修法是每趟自己开循环。`scripts/verify-view-reminders.ts` 第 1 例就是「只有 library 列 + 一个到期倒计时」，旧代码必挂。
> - ✅ 切片 B：`src/view/config-modals.ts`（251 行）——15 个弹窗启动器（widget 类型 / 便利贴类型 / 天气 / 追踪器 / 模板 / library / dataview / web / rss / skills / pipeline / pm / media / weread / skill-create 派发）。它们本来就是同一个形状（取列配置 → 交给弹窗 → 经 sync 写回），并排放在一起才看得清。视图保留 15 个一行转发 + 一个 `modalHost()`，**调用点零改动**。
> - ✅ 切片 C：`src/view/watchdogs.ts`（80 行）+ `src/view/scroll-top.ts`（77 行）——三个周期看门狗（提醒扫描 / 天气 TTL / 跨日检查）只搬计时管道，各自的「要不要干活」判断留在原地；回到顶部按钮独立成文件，因为它要按布局猜「哪个元素在滚」，那段判断值得单独有位置。
> - 📉 累计：`view.ts` 3822 → 3415 行（−11%），`src/view/` 4 个模块 651 行。全量 108/108 通过。
> - ✅ 切片 D：`src/view/vault-watcher.ts`（230 行）——`VaultWatcher` 类接管 create/modify/delete/rename + metadataCache `changed` 五个监听、跨事件的一次性 trailing debounce（500ms）、`changedMd` / `changedMedia` 分类、以及 md 缓存滞后守卫（每个 path 最多再补跑一次）。视图侧只剩 `registerVaultListeners()` / `unregisterVaultListeners()` 两行委托，6 个私有字段一起消失。
> - 🔑 **这一块是先改形状、再搬代码**：上一轮判断「10 个回调 = 换个文件写耦合」是对的，但结论不是「不可拆」，而是「先收窄」。最终 `VaultRefreshTargets` 是 7 个具名回调（recent / sidebarCalendar / openDayAgendas / dailyLinked / album / bannerStats / sections），watcher 自己拥有「哪种变更唤醒哪些表面」这条策略，其余全是视图的活。
> - 🔑 另一个关键决定：`invalidateScanningSectionSignatures()` 从直接 import renderer 改成宿主回调 `invalidateSectionSignatures()`。这样 `vault-watcher.ts` 的依赖只剩 `obsidian` + `file-types`——**没有渲染栈的导入副作用，才写得出 `verify-vault-watcher` 这种纯逻辑测试**（手动 `window.setTimeout` 队列驱动 500ms 防抖）。
> - 📉 累计：`view.ts` 3822 → 3280 行（−14.2%），`src/view/` 5 个模块 881 行。全量 109/109 通过。
> - ✅ 一条测试经验（第三次复现）：`verify-calendar-add-refresh` 的源码断言钉在 `view.ts` 的 `record()` 上，搬走后失败。**正向断言失败是安全的**——它逼你去看一眼；真正危险的是上一轮那种「文件里已经没有这段代码所以负向断言恒真」。凡搬一块，先跑一遍 `readFileSync('src/view.ts')` 的那 13 个脚本。
> - ✅ 切片 E：`src/view/widget-refresh.ts`（181 行）——五个「别处改了数据，就地重绘这一个 widget」的处理器（音乐 / 习惯 / 开销 / 番茄钟 / 阅读）+ 迟到的农历数据，共用 `refreshDataWidget`（原位换挂载点）与 `refreshMobileWidgetPanel`（移动端面板同步）。视图侧只剩 6 个一行转发 + 一个一次构建的宿主适配器。
> - 🔑 **宿主用 getter 而不是快照**：宿主对象只建一次（`widgetHost ??=`），所以 `settings` / `data` / `holiday` / `expandedMobileWidget` 全是 `() => …`。若把 `this.plugin.settings` 在构建时抓成字段，番茄钟换背景后再刷新读到的就是旧设置。
> - 🔑 桌面 widget 与移动端面板是**两棵独立的挂载树**，面板只在「正好是展开的那一个」时才重绘，且必须先 `empty()`——否则会嵌出第二个 `.dashboard-sidebar-widget`，把 tab 条的枚举和拖拽弄乱。这一条写成了 `verify-widget-refresh` 的第 5 例。
> - 🧪 `scripts/verify-widget-refresh.ts`（新增，110 个测试）用 `mini-dom` 覆盖搬移时最容易踩坏的四件事：挂载点落在旧节点的**原位置**（前后兄弟不挪）、`data-widget-key` / `--db-widget-span` / `data-imm-id` + grid 内联定位的**身份继承**、被换掉的节点内部**滚动位置回放**、以及「widget 不在树上就什么都不做」（旧 bug 形状是把 mount 追加到侧栏末尾）。
> - 📉 累计：`view.ts` 3822 → 3214 行（−15.9%），`src/view/` 6 个模块 1062 行。全量 110/110 通过。
> - ⚠️ 本切片净增约 50 行（接口 + 宿主适配器 + import），换来的是「六种数据源、一套语义」。衡量这类切片的尺子应该是「新增一种 widget 要改几处」，不是行数。
> - ✅ 切片 F：`render()` 就地拆成三个私有方法——`renderImmersiveBoard`（37 行）、`renderClassicBoard`（91 行）、`applyPendingScrolls`（26 行），`render()` 本体 252 → 101 行。**这一块不外移**：它跟 25 个 `this.` 成员（immWidgetEls / immItems / bannerStatsEl / dndCleanupFns / createCallbacks …）纠缠，硬抽出来只会换来一个 25 成员的宿主接口。拆之后 `render()` 的读法是「快照滚动 → 拆 widget → 清场 → 建容器 → 交给一条管线 → 重新接线 → 还原滚动」，而两条管线各自独立可读。
> - 🔑 **切分两份 if 分支时最容易摔的坑**：原文里 `boardHost = imm.grid;` / `boardHost = kanban;` 是**赋值**，改成 `return` 时必须挪到分支末尾——第一次机械替换把 `return` 留在了赋值原位，于是沉浸态的 `setupImmersiveDnD` / tile 菜单 / 缩放条变成了不可达代码、经典态的分区导航轨整段不渲染。两种都编译通过、测试全绿（没有测试盯这两条）。修完后补了一个「`return` 后紧跟非 `}` 行」的静态检查，扫全文件 0 处。
> - 🔑 另一次同类失误：`applyPendingScrolls` 的 body 多减了一级缩进（这段本来就在方法体内层）。**搬移脚本里每处 dedent/indent 都要配一条断言**，否则缩进错了 TS 也不一定报错。
> - ✅ 切片 G：`src/view/board-events.ts`（342 行）——整个 `attachBoardEventDelegation`（283 行、20 个 `dashboard-*` 监听）外移。视图只剩 3 行转发 + 一个 17 成员宿主适配器。
> - 🔑 **20 个监听器现在能当表格读**：每个都是「按事件 detail 找列 → 合并部分配置 → `sync.updateSectionConfig` → `refreshSectionInPlace`」同一形状，例外处（PM 直写笔记、TickTick 吞一次 render）都有行内注释。
> - 🔑 设计取舍：17 个弹窗启动器放在**宿主**上而不是在模块里 import，理由是可测——`verify-board-events` 用假宿主 dispatch 事件就能断言整张路由表（哪个 gear 事件开哪个弹窗、写哪个 config key、刷哪一列），若模块直接 import 启动器就只能断言到「函数被调用」为止。
> - 🧪 `scripts/verify-board-events.ts`（新增，111 个测试）钉住 7 组行为：gear 的 13 条路由（含 `images`/`videos` 共用媒体弹窗、未知类型回落 library、**事件自带的 sectionType 压过列自身类型**）、rss 页大小（非数字则什么都不写）、skills prefs 的「`undefined` 丢键」序列化安全、pipeline 列宽只改被拖那一列、手动排序的槽位替换语义（`['a','b','c','d']` + 拖成 `['d','a']` → `['d','b','c','a']`）、PM 广播只刷 pm 分区、TickTick 吞 render。变异验证：把 `images || videos` 改成只判 `images`，测试立刻红。
> - 📉 累计：`view.ts` 3822 → 2984 行（−21.9%），`src/view/` **7** 个模块 1404 行。全量 111/111 通过，build 干净。
> - ✅ 切片 H：`src/view/mobile-panel.ts`（318 行）——手机那一半外壳：widget 条（细条 → 标签行 → 面板）、banner 上两个圆钮、两个抽屉（快捷操作 / 最近文档），连同「点 banner 右半露出编辑按钮」的触摸手势。视图只剩两个调用点（`renderMobileActions(this.mobilePanelHost(), bannerEl)` / `renderMobileWidgetBar(…)`）+ 一个 14 成员宿主适配器，`mobileWidgetTabsOpen` / `mobileWidgetExpanded` 两个字段合并成一个 `mobilePanelState` 对象。
> - 🔑 **这条切片边界的依据是「桌面从不调用」**，不是「长得像手机」：`renderSidebar`（桌面侧栏）和沉浸网格都不碰它。上一轮把 `renderSidebar` 也算进这一簇是错的，它是 `renderClassicBoard` 的搭档，留在视图。
> - 🔑 **顺手消掉一处同名歧义**：视图私有的 `refreshMobileWidgetPanel`（重刷整条栏的 chrome + 面板）与 `widget-refresh.ts` 导出的 `refreshMobileWidgetPanel`（只重刷面板，且必须正好是展开的那个）同名而射程不同。前者改名 `syncMobileWidgetPanel`，名字里带「sync」表示它按状态同步 chrome；后者的职责写进了两者的注释。这正是「同一名字、不同射程」最容易养出的 bug：在习惯勾选时重建标签行。
> - 🔑 **状态仍归视图、只交出容器**：`mobilePanelState` 是视图字段（一个 leaf 一份），模块只负责读写它。若做成模块级 `let`，同一个 vault 里两个 dashboard leaf 会互相开关面板。窗口尺寸无关——是 leaf 数量。
> - 🧪 `scripts/verify-mobile-panel.ts`（新增，112 个测试）钉住 6 组状态规则（不是布局）：① 每次整渲染都从「关闭」开始，不残留展开的面板；② 收起细条要把展开项一起丢掉；③ 面板先 `empty()` 再渲染（切标签不得嵌进第二个 widget）；④ 设置门控标签列表且顺序固定（lunar 首、reading 末）；⑤ 抽屉是单例、按第一个分区行定位、点背景关闭、关两次无副作用、没有 root 时静默；⑥ banner 右半点击露出编辑按钮、左半不露。变异验证两次：删掉「收起时清空」→ ②挂；删掉 `panel.empty()` → ③挂。
> - ✅ 顺带清掉 11 个切片 G 遗留的死导入（`PmNewModal` / `SkillCreateConfigModal` / `mergeManualStageOrder` … 都已随事件表搬走），并修掉一个 `no-misused-promises`：`openTickTickFilterModal` 是 `async`，适配器里直接返回 Promise 会被 lint 判错。
> - 📉 累计：`view.ts` 3822 → **2781** 行（−27.2%），`src/view/` 8 个模块 1722 行。全量 112/112 通过，build 干净，`eslint src/view.ts src/view/mobile-panel.ts` 零告警。
> - ✅ 切片 I：`src/view/new-note.ts`（251 行）——两个新建笔记入口（分区工具栏 / 卡片加号）合一。它们的四步流程其实完全一样（定文件夹 → 模板选择器 → 标题输入 → 建 → 打开），真正的差异只有三处，且都在表里写清了：文件夹来源、是否挂到卡片的文档树、**打开方式默认值相反**。视图只剩两个调用点 + 一个 6 成员宿主适配器 + 一个 `newNoteState`（两个 in-flight 布尔）。
> - 🔑 **「默认值相反」是刻意的，不是 bug**：library/folder 分区历史上一律开真标签页，卡片历史上开看板内浮窗。两个 `newNoteOpenMode` 的判据因此是镜像的（`=== 'popover'` vs `=== 'tab'`）。这正是最容易被后人「统一」掉的地方，所以测试用例 3/4/13/14 把四个组合都钉住了。
> - 🔑 **两个 in-flight 布尔合并成一个视图持有的状态对象**，理由与切片 H 的 `mobilePanelState` 相同：同一 vault 两个 leaf 必须能各自弹自己的标题框；放模块级 `let` 会让第二个 leaf 的点击被第一个 leaf 的对话框吞掉。但它们**彼此独立**（卡片框开着不影响分区按钮），用例 17 钉住这点。
> - 🔑 **搬移时唯一的结构性改动**是把两段一模一样的「模板缺失 → 退化成裸笔记 + 提示」抽成 `createWithTemplateFallback`。这是全文件唯一的重复块，两处参数不同（卡片传 `{}`，分区传 `props`），抽出来后差异显式化。等价性用 `git show HEAD:src/view.ts` 逐行 diff 验证过，除这些改名外一致。
> - 🧪 `scripts/verify-new-note.ts`（新增，113 个测试）17 组用例，几乎全是**分支决策**而不是 DOM 形状：无文件夹的 folder 分区只提示不建、pipeline 分区不弹框、settings 路径去斜杠、菜单选文件夹 / 取消 / **没有点击坐标就不猜**、模板菜单「首项带默认标记」、模板缺失退化成裸笔记（且只建一次）、属性过滤器预填 frontmatter 且不可满足的键进第二条提示、取消后 guard 释放且按钮立刻可用、重入只弹一个框只建一篇、卡片流挂 doc 且默认浮窗、`tab` 配置反转、无文件夹时落到 vault 根（路径无前导斜杠）、未知 cardId 不弹框、两个 guard 互不干扰。
> - 🧪 测试里的两个坑：① `showPromptDialog` 是 body 级悬浮层，`mini-dom` 的 `activeDocument` 必须自己造（`querySelector` 返回 null 让 `applyModalTheme` 短路）；② 模板解析走 `instanceof TFile`，假文件必须用 stub 的 `new TFile()` 再挂 `path`/`basename`，plain object 会被当成「模板不存在」——第一版正是在这里静默走了 fallback 分支。
> - 🔧 顺带修正两处因搬移而失效的**正向源码断言**（`verify-card-open-mode` / `verify-library-new-note` 原本 grep `view.ts`）：改读 `src/view/new-note.ts`，其中 `carryImmersivePlacement` 那条仍属 `view.ts`，于是两份源码都读。这类失败是良性的（正向断言搬走后必然红），比负向断言静默通过安全。
> - 📉 累计：`view.ts` 3822 → **2628** 行（−31.2%），`src/view/` 9 个模块 1975 行。全量 113/113 通过，build 干净。
> - ✅ 切片 J：`src/view/change-scope.ts`（210 行）——`refreshSectionsFor`（122 行）整体外移并拆成「判定 + 驱动」两层：三个纯函数 `sectionInScope` / `scanningSectionNeedsRefresh` / `immersiveTileInScope` 定策略，`refreshSectionsFor` 只负责接线。视图侧剩一个调用点 + 一个 9 成员宿主适配器，DnD 重接抽成 `rewireAfterSwap`（机制留视图，时机归模块）。
> - 🔑 **两条范围规则是故意不合并的**，这是本切片唯一真正的设计判断：整库扫描的 library 分区在**经典**板上必须刷新（否则它永远不刷新），在**沉浸**板上必须冻结（冻结本身就是这个布局存在的理由）。所以是 `sectionInScope`（无文件夹 = 全库 = 在范围内）与 `immersiveTileInScope`（无文件夹 = 冻结）两个函数，注释与用例 11 都把这个不对称钉住了。当年把两段判定分别写在两个分支里，看着像复制粘贴，其实是两种刷新哲学。
> - 🔑 **另一个不对称**：沉浸分支不看 `broad`。经典板上「文件夹级事件」保守地刷新一切；沉浸板上若照做，一次文件夹重命名就会重建所有固定 tile——正是要防的抖动。上一轮我差点把 `inScope` 直接复用进沉浸分支（省 15 行），那会同时引入这两处行为变化。
> - 🔑 **顺带把 `swapped > 0` 这道闸显式化**：没换过节点就不重接 DnD（否则每次空跑都拆掉重装整块看板的所有监听）。原来这行埋在 122 行方法的最底部，任何提前 `return` 都会静默跳过；现在它在模块末尾且只有一个出口，用例 7/8 钉住「空跑不重接」。
> - 🧪 `scripts/verify-change-scope.ts`（新增，114 个测试）11 组：无数据的静默、无 DOM → 全量渲染、沉浸态整库冻结（含「日历仍走就地通道」）、分区命中 / 落空 / **兄弟目录不是前缀**（`docs2` ≠ `docs`）、pipeline 空白根 = 全库、PM Gantt 源是**文件精确匹配**而非目录前缀、媒体变更不碰 tile、《空跑不重接》、三条纯函数各自的边界。三次变异（`swapped >= 0`、取消冻结、日历不再跟随 `.md`）全部按预期挂。
> - 📉 累计：`view.ts` 3822 → **2535** 行（−33.7%），`src/view/` 10 个模块 2185 行。全量 114/114 通过，build 干净，eslint 零告警。
> - ✅ 切片 K：`src/view/task-writes.ts`（223 行）——两条写进**用户笔记**的路径（而非看板数据文件）：卡片工具栏「保存待办到日记」与分区菜单「归档已完成」。视图只剩两个触发点 + 一个 4 成员宿主适配器，两个只被它们使用的模块级 helper（`getDailyNotesPlugin` / `prependAfterFrontmatter`）一起搬走。
> - 🔑 这两条放在一起不是为了省文件，是因为共享同一套**失败纪律**：日志先写、看板后清。写失败（只读库、磁盘满）时任务还在板上，可以重试、不会丢；反过来「先清板再写日志」失败就是静默删数据。这一条既写进模块头，也是用例 11 的核心（让 `modify` 抛错，断言 `sync.archiveTasks` 从未被调用）。
> - 🔑 「合并而非覆盖」同样是有意的：`saveTasksToDaily` 把卡片任务折进已有 heading 块——卡片条目更新、新条目追加、**只在笔记里存在的行原样保留**。没有 heading 时才在 frontmatter 之后插入新块。
> - 🧪 `scripts/verify-task-writes.ts`（新增，115 个测试）12 组，几乎全是**拒绝与顺序**而非 happy path：无任务 / 日记插件未开 / 用户取消 / 未知列 / 日记不可用 → 一律零写入且看板不动；新建 vs 合并 vs 缺 heading 三分支；归档目标文件缺失时连文件夹一起建；写失败时看板不清。两次变异（先清板后写日志、取消合并分支）都按预期挂。
> - ⚠️ 记录一处**既有行为**（未改，属于行为改动不该混进搬移）：`taskArchivePath` 若没写 `.md`，日志会写进一个无扩展名的文件——在 Obsidian 里看不见。默认值与设置页提示都是带 `.md` 的，只有手输漏了后缀才会踩到。
> - ✅ 切片 L：`createCallbacks`（139 行对象字面量）拆成四组——`cardCallbacks`（卡片内容：任务/文档/便签/封面/标题）、`layoutCallbacks`（看板几何，全部经同一个 `isLayoutLocked` 闸）、`sectionCallbacks`（模板/归档/两处就地配置写）、`chromeCallbacks`（banner / 快捷操作 / 置顶笔记 / 命令）。`createCallbacks(): RenderCallbacks` 显式标注返回类型后，`{ ...a, ...b }` 的组装结果会被编译器按 `RenderCallbacks` 检查——某个组漏一个键会**在这里**报错，而不是在六个建看板的地方之一。
> - 🔑 分组的依据是「写什么」而不是「长什么样」：`layoutCallbacks` 那 14 个全部被同一个布局锁挡住，「锁住时不能移动卡片」这条规则现在只出现在一处。
> - ✅ 收尾：`docs/ARCHITECTURE.md`（166 行）成文——分层与依赖方向（含「`view/*.ts` 不许 import `view.ts`」这条硬规矩）、四条刷新通道、注册表契约与 `scan`、行为三件套、宿主接口三条约定、测试体系（含正向/负向源码断言的区别与变异验证）。
> - 📉 **Phase 5 完成**：`view.ts` 3822 → **2431** 行（−36.4%），`src/view/` 11 个模块 2408 行。最大方法 101 行（`render`，且已拆成三条管线），第二 91（`renderClassicBoard`）。全量 115/115 通过，`npm run check` 全绿（build + lint 零告警 + 全量测试）。
>
> ### Phase 4 / 5 产物清单（截至 2026-11-09）
>
> | 模块 | 行数 | 职责 |
> | --- | --- | --- |
> | `render/sidebar-reading.ts` | 715 | 阅读追踪侧栏 + 四个弹窗（结束计时 / 编辑书籍 / 搜书 / 统计） |
> | `render/widget-mount.ts` | 594 | widget 目录表、挂载、条带签名、条带内拖拽、三个布局判定 |
> | `render/card.ts` | 559 | 卡片外壳（封面 / 头部 / 动作按钮 / 宽度拖拽）+ `renderCardBody` 分派 |
> | `render/task-row.ts` | 555 | 任务行递归渲染、勾选镜像、双击编辑、拖拽 |
> | `render/sidebar-widgets.ts` | 489 | 天气 / 番茄钟 / 倒计时（跨渲染持有状态） |
> | `render/section-frame.ts` | 373 | 折叠持久化、两种宽度拖拽、`getSectionType`、`renderSection` |
> | `render/reminder-popup.ts` | 272 | 提醒芯片 + 设置/清除/逾期样式 |
> | `render/project-doc.ts` | 254 | 项目卡递归文档树 + 添加文档搜索行 |
> | `render/memo.ts` | 206 | 便签卡视图/编辑切换、纯文本绘制、markdown 接线 |
> | `render/tracker-chart.ts` | 181 | 图表实例表 + 销毁 + Chart.js 注册 |
> | `render/section-refresh.ts` | 163 | 扫描型 section 签名刷新 + 媒体 section 刷新 |
> | `render/collapse.ts` | 108 | 折叠判定（任务行与文档行共用） |
> | `render/note-index.ts` | 102 | basename 索引 + vault 失效钩子 |
> | `render/text-links.ts` | 92 | wikilink / 外链渲染 |
> | `render/color.ts` | 50 | 主题色取值与亮度判断 |
> | `render/link-context.ts` | 29 | 链接渲染的三个环境变量（可变更） |
> | `render/time-format.ts` | 17 | 计时显示 |
> | `view/board-events.ts` | 344 | 20 个 `dashboard-*` 事件的整张路由表 |
> | `view/mobile-panel.ts` | 318 | 手机外壳：widget 条 / banner 圆钮 / 两个抽屉 + 状态对象 |
> | `view/new-note.ts` | 251 | 两个新建笔记入口的判定表（文件夹 / 模板 / frontmatter / 打开方式） |
> | `view/config-modals.ts` | 251 | 15 个弹窗启动器 |
> | `view/reminders.ts` | 243 | 提醒扫描五趟（纯函数） |
> | `view/vault-watcher.ts` | 230 | 五个 vault 监听 + 500ms 去抖 + 缓存滞后守卫 |
> | `view/task-writes.ts` | 223 | 两条写进用户笔记的路径（保存到日记 / 归档已完成）+ 失败顺序 |
> | `view/change-scope.ts` | 210 | 「这次 vault 变更该重建哪些分区」的判定 + 沉浸态冻结规则 |
> | `view/widget-refresh.ts` | 181 | 六种数据源的 widget 就地重绘 |
> | `view/watchdogs.ts` | 80 | 三个周期计时器管道 |
> | `view/scroll-top.ts` | 77 | 回到顶部按钮（按布局猜滚动容器） |
>
> ### `view.ts` 剩余工作

> 已清空。`view.ts` 现在 2,431 行，最大的三个方法是 `render`（101，已拆成三条管线）、`renderClassicBoard`（91）、`onOpen`（87，生命周期），其余全部 ≤62。
> 剩下的都是**视图**：它们读写 `this` 上的 leaf 状态，抽出去只会换来一个几十成员的宿主接口——那是把耦合换个文件放，不是降低耦合。

> **结论**：巨石问题已经解决，且 `view.ts` 的可拆部分已经拆完。`renderer.ts` −97.6%、`view.ts` −36.4%，28 个新模块各自只回答一个问题。后续如果还要动，该动的是**行为**（比如上面记录的归档路径缺后缀）或 **`library-section.ts`（2,595 行，现在是最大的非 i18n 文件）**，而不是继续从视图里搬方法。



---

## 五、行为契约矩阵（迁移时的对照表）

| 卡片 | 勾选任务 | 整行打开笔记 | 定位到行 | 弹窗编辑后刷新 | 手动刷新 | vault 自动刷新 |
| --- | --- | --- | --- | --- | --- | --- |
| 待办清单（sticky task） | ✅ quiet + 重排 | 仅内联链接 | 链接锚点 | ❌ 靠签名守卫 | — | md |
| dataview | ✅ 就地 patch + 剪除 | ✅ | ✅ | ✅ 注册表 | ✅ | ❌（刻意） |
| calendar 卡片/widget | ✅ 写盘 + 去抖重扫 | ✅ | ✅ | ✅ 私有 reloaders | ✅ | md |
| pipeline | — | 标题延时 popover | ❌ | ❌ | ✅ | scan 签名 |
| pm / pm 甘特 | — | board 内 popover | ❌ | ❌ | ✅ | scan 签名 |
| library / folder | — | 卡片点击 | ❌ | ❌ | ✅ | scan 签名 |
| media | — | 灯箱 | ❌ | ❌ | ✅ | media |
| ticktick | ✅ 远端 API | ❌ | ❌ | ❌ | ✅ | 服务订阅 |
| rss / weread / skills / web | — | 条目打开 | ❌ | ❌ | ✅ | ❌ |

**目标**：第三列起全部由框架提供，卡片只需声明 `paths()` 与 `refresh`。

---

## 六、明确不做（避免过度设计）

- 不引入状态管理库 / 虚拟 DOM —— 现有 DOM 就地更新（prune / mirror）的收益已经验证，重写会丢掉这些来之不易的细节。
- 不做「一个通用 Card 组件渲染所有卡片」——15 种卡片的展示差异是产品需求，不是重复代码。
- 不改 `render-update.ts` 的三档刷新模型 —— 它是这块最成熟的部分。
- 不在同一份 PR 里同时改行为和结构。

---

## 七、风险与回归策略

| 风险 | 缓解 |
| --- | --- |
| 改行为层弄坏未覆盖的卡片 | Phase 0 先建 `npm test` 全量闸门；每个适配器迁移前先补该卡片的 verify |
| 注册表迁移导致某卡片静默不渲染 | 注册表 `resolve` 未命中时抛错并回落到旧 if 链（一次性开关），灰度一个版本后删除 |
| 视觉回归 | Phase 3 保留旧类名作为附加类；关键卡片做截图对比 |
| 沉浸模式被遗漏 | 每次改刷新路径都跑 `verify-immersive-*`（已有 5 个脚本） |
| 一次改动过大难 review | 每个 Phase 独立 commit；Phase 2 按卡片类型一卡一 commit |
