# Apex Dashboard 架构梳理与重构规划

> 目标：把「每种卡片各写一套」收敛成「一套契约 + 若干声明」，让新增/修改卡片时不再四处修补。
> 原则：不追求一次性重写，按可独立发布的切片推进，每个切片都有回归闸门。

---

## 一、现状速写

| 指标 | 数值 |
| --- | --- |
| src/ 代码量 | 约 84,100 行 TS，约 180 个文件 |
| 最大单文件 | `renderer.ts` 5,080 / `view.ts` 3,818 / `i18n.ts` 7,127 / `library-section.ts` 2,595 |
| 卡片（Section）类型 | 15 种（sticky/folder/library/projects/dataview/pm/pipeline/skills/calendar/rss/images/videos/web/weread/ticktick）+ 3 个遗留别名 |
| 侧边栏 Widget | 16 种 |
| 配置弹窗 | 22 个 `*-config-modal.ts` / `*-settings-modal.ts` |
| 验证脚本 | 108 个 `scripts/verify-*`（101 个 test:* npm script，已补 `npm test` 统一入口） |
| 空态样式类 | 约 34 个互不相同的 `dashboard-xxx-empty` |
| `dashboard-section-add-btn` 重复 | 38 处（都在 `renderer.ts` 内） |

已经做得好的部分（**不要动**）：

- 刷新管线：`render-update.ts` 的 `none / sections / full` 三档计划 + `refreshSectionInPlace` + `scroll-preserve.ts`，是全项目最统一的一块。
- 行壳：标题 / 双击重命名 / 折叠 / 拖拽高度 / 并排宽度，全部由 `renderSection` 统一渲染（`renderer.ts:2322`）。
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

### Phase 0　建闸门（已完成一半）

1. ✅ `npm test`：串行跑全部 101 个 `test:*`，输出通过/失败汇总与耗时（`scripts/run-all-tests.mjs`）。
2. ✅ `npm run check` = `build` + `lint` + `test`。
3. ✅ 修好 3 个长期失败的用例（见 P6）。
4. ⬜ 建 `docs/ARCHITECTURE.md`（本文件的「现状」与「契约」两节）+ `src/section/` 骨架（只放类型，不接线）。

**验收**：`npm test` 全绿；纯新增文件，`main.js` 产物不变。

### Phase 1　行为三件套（1–2 天，收益最高）——进行中

顺序很关键：**先统一行为，再统一结构**。因为用户能感知的 bug 都在行为层，而且改行为的风险边界清楚。

> **进度**：
> - ✅ 切片 A `attachNoteJump` + `NoteOpeners`（`src/note-jump.ts`）：dataview 行、日历网格三处、日程弹窗行已迁移；pipeline 的单击+双击重命名是另一种手势，保持原样。
> - ✅ 切片 B `writeTaskToggle`（`src/task-toggle.ts`）：dataview 与日历系的勾选写盘收敛为一个串行队列（修掉两卡并发写同一笔记的丢更新），失败 Notice 统一；待办卡片保持 `sync.toggleTaskQuiet` 自有通道（写的是看板数据文件+日记镜像，另一种工件）。
> - ✅ 切片 C `SectionRefreshBus`（`src/section-refresh.ts`）：dataview 私有注册表与日历 sectionReloaders 合并为带 channel 的总线。pipeline/library/pm 不需要接 popover 编辑刷新——它们的扫描卡本来就走 vault 去抖（500ms 后必刷，签名守卫防闪烁）。
> - 新增契约测试：`verify-task-toggle-contract`、`verify-section-refresh`；`verify-dataview-task-open` 改为行为断言。
> - ⬜ 遗留：17 个存量 `no-base-to-string` lint 错误（pipeline/pm 模型层）待清，清完 `npm run check` 才全绿。

1. `attachNoteJump` + `NoteOpeners` 落地；迁移 dataview → calendar-grid → calendar-modal → pipeline。
2. `TaskToggleService` 落地；先接 dataview 与日历（这两家的写盘路径本来就一致），再接待办卡片（需把 `toggleTaskQuiet` 的日记镜像搬进 service）。TickTick 最后接。
3. `SectionRefreshBus` 落地；把 dataview 的注册表与 calendar 的 `sectionReloaders` 合流，给 pipeline / library / pm 接上「popover 编辑后刷新」。

**验收**：`verify-dataview-task-toggle`、`verify-task-toggle-quiet`、`verify-calendar-*`、`verify-dataview-task-open`、`verify-dataview-edit-refresh` 全绿；新增契约测试 `verify-task-toggle-contract`（四适配器共用一套断言）。

### Phase 2　Section 注册表（2–3 天）——已完成主体

> **进度**：
> - ✅ `src/section/registry.ts`：`SectionDefinition`（types/aliases/picker/fixedHeight/holdsCards/headerActions/render）+ `SectionContext`（el/header/actions/column/app/data/settings/callbacks/hoverParent/openNoteInPopover/buttons/setReload/renderCards）+ `createSectionButtons`（config/refresh/remove/addCard 统一图标、类名、事件路由）。
> - ✅ 15 个类型按领域拆到 `src/section/defs/{cards,media,data,tasks,boards}.ts`，`src/section/index.ts` 副作用注册。
> - ✅ `renderSection` 的 if 链（原 2447–2997）删掉，改为 `def.headerActions?.(ctx); def.render(ctx);`；`getSectionType` 的 15 行名称表改为 `hasSectionType` + `canonicalSectionType`（memo/todo→sticky、notes→projects 走 alias）。
> - ✅ `SECTION_TYPE_OPTIONS` 由 `sectionPickerOptions()` 生成（顺序由 entry 的 `order` 决定，不再依赖导入顺序）。
> - ✅ 配置齿轮的 `dashboard-library-config` 事件现在带上规范 `sectionType`，`view.ts` 的路由不再自己猜类型。
> - ✅ 契约测试 `verify-section-registry`（选择器顺序、别名、每类 header 按钮组成、空态/回退渲染、重复注册报错、renderer 无残留 if 链）。
> - ⬜ 遗留：`parser.ts` 的 `SECTION_TYPES` 与「无卡片类型」两个列表仍是手写的（parse 层不该依赖渲染注册表，另议）；`sync.ts` 的 config 合并与 `renderer` 的 `SCANNING_SECTION_TYPES`/`MEDIA_SECTION_TYPES` 可在 Phase 3 一并收进定义（`scan: 'files' | 'media' | 'none'`）。

**验收**：✅ `renderSection` 只剩注册表派发；✅ `SECTION_TYPE_OPTIONS` 由注册表生成；✅ `view.ts` 路由按规范类型走。

### Phase 3　配置与状态视图（1 天）——进行中

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
> - ⬜ 遗留：`dashboard-library-empty` 这类纯文本空态（约 19 处，含弹窗内的列表空态）与 `dashboard-rss-empty` 尚未迁移。

**验收**：视觉零回归（截图对比关键卡片空态）；`verify-*-config` 全绿。

### Phase 4　拆分巨石（持续，按需）

`renderer.ts` 按职责切成 `card/render-card.ts`、`widget/render-widgets.ts`、`task/render-task-list.ts`；`view.ts` 切成 `view/lifecycle.ts`、`view/events.ts`、`view/refresh.ts`。**只搬不改**，每搬一块跑全量测试。

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
