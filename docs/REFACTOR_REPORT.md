# 重构总结：从两块巨石到一套契约

> 一句话：把「每种卡片各写一套」收敛成「一套契约 + 若干声明」，同时把 `renderer.ts`（5,080 行）和 `view.ts`（3,818 行）拆成 40 个各回答一个问题的模块。
>
> 起点 `ec4294a`（重构准备前）→ 当前工作区（2026-11-09）。逐切片取舍见 [`REFACTOR_PLAN.md`](./REFACTOR_PLAN.md)，日常改动该放哪见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

---

## 一、做了什么

按「先统一行为、再统一结构、最后才动文件」的顺序推进，每一步都可独立发布。

| 阶段 | 内容 | 产出 |
| --- | --- | --- |
| Phase 0 闸门 | 101 个 verify 散落各处、没有全量入口，重构时只能靠记忆挑几个跑 | `npm test`（串行 + 汇总 + 关键词过滤）、`npm run check`（build + lint + test） |
| Phase 1 行为三件套 | 同一种交互在 2–5 个地方各写一遍 | `note-jump.ts` / `task-toggle.ts` / `section-refresh.ts` |
| Phase 2 注册表 | `renderSection` 里 550 行 if 链 | `section/registry.ts` + `section/defs/*.ts`（5 个领域文件） |
| Phase 3 配置与状态 | 空态、弹窗外壳、`updateXxxConfig` 各写各的 | `section/state.ts` / `section/config-modal.ts` / `sync.updateSectionConfig` |
| Phase 4 拆 `renderer.ts` | 一块 5,080 行的渲染入口 | 12 个切片 → `src/render/` 17 个模块 |
| Phase 5 拆 `view.ts` | 最后一个巨石，类方法不能照搬函数 | 12 个切片 → `src/view/` 11 个模块 |

两个巨石的拆分纪律是同一条：**只搬不改**。新模块对外用「转发导出 + 宿主接口」接回原调用点，`view.ts` / `calendar-*.ts` / `main.ts` 与验证脚本的调用行一行未改——这样每次提交可以当纯移动来 review。

---

## 二、对比清单

### 2.1 规模

| 指标 | 重构前 | 重构后 | 变化 |
| --- | --- | --- | --- |
| `src/` 代码量 | 109,391 行 / 298 文件 | 110,880 行 / 339 文件 | +1,489 行（+1.4%）/ +41 文件 |
| `renderer.ts` | 5,080 | **110** | −97.8% |
| `view.ts` | 3,818 | **2,431** | −36.3% |
| 两者合计 | 8,898 | 2,541 | **−71.4%** |
| 最大非 i18n 单文件 | 5,080（`renderer.ts`） | 2,595（`library-section.ts`） | −48.9% |
| 拆分/抽出的模块 | 0 | 40（`render` 17 / `view` 11 / `section` 9 / 行为契约 3） | — |
| 最大方法 | `renderSection` 550 行 if 链 | `render` 101 行（且已拆成三条管线） | — |

净增的 1,489 行不是新功能，全部是模块头、导入、转发导出、宿主接口。**衡量拆分的尺子不是行数，是「改一处要动几个文件」**——见 2.2。

### 2.2 同一件事的实现份数

| 你要改的东西 | 重构前 | 重构后 | 收敛比 |
| --- | --- | --- | --- |
| 新增一种卡片类型 | 改 **7 处**（选择器 / types / sync / if 链 / getSectionType / 事件路由 / 默认配置 + 刷新范围） | 改 **2 处**（`registerSection()` + `parser.ts` 的类型表，后者有测试钉住一致性） | 7 → 2 |
| 任务勾选写盘 | **3–4 套**（待办 / dataview / 日历 / TickTick 各有失败处理与并发策略） | **1 个串行队列** + 4 个只管乐观更新的适配器 | 4 → 1 |
| 点击行打开笔记 | **5 套**（忽略选择器、光标类、是否带行号、是否延时各不相同） | **1 个 `attachNoteJump`**（`file` / `atLine` / `inPopover` 三种粒度） | 5 → 1 |
| 弹窗编辑后刷新 | **2 套私有注册表** + 多数卡片干脆不刷新 | **1 条总线**，2 个 channel（`note-edited` 精确 / `vault` 容器级） | 2 → 1 |
| 卡片配置弹窗外壳 | 21 个 `*-config-modal.ts` 各自 `extends Modal` 手写标题 / 按钮 / 主题 / 脏检查 | 18 个继承 **106 行基类**，只写 `title()` / `renderBody()` / `submit()` | 21 → 1 |
| 区块级空 / 加载 / 错误态 | 约 **34 个**互不相同的类名与 DOM 结构 | **1 套 `renderSectionState`**（旧类名作为附加类保留，CSS 不回归） | 34 → 1 |
| 配置写回 | 9 个 `updateXxxConfig` 各写一遍读-改-写 | 1 个 `updateSectionConfig` + 1 份 `SECTION_CONFIG_KEYS` 声明 | 9 → 1 |
| 「vault 变了刷什么」判定 | 硬编码在两个 Set + 两处分支里 | `SectionDefinition.scan` 一个字段 + `change-scope.ts` 一处判定 | 3 → 1 |
| 链接渲染的全局上下文 | 3 组模块级 `let`（renderer 8 / dataview 4 / library 3） | 1 个 `linkContext` 对象 | 3 → 1 |

### 2.3 工程保障

| 指标 | 重构前 | 重构后 |
| --- | --- | --- |
| 验证脚本 | 101 个，**无全量入口** | **115 个**，`npm test` 串行跑完并汇总（172 秒） |
| 一键检查 | 不存在 | `npm run check` = build + lint + 全量测试 |
| lint | 20+ 存量错误/告警（`no-base-to-string`、`sentence-case`） | **0 error 0 warning** |
| 长期红着的用例 | 3 个（`verify-library-card-size` / `verify-material` / `verify-material-render`） | 0，且已修 |
| 契约测试 | 0 | 5 个（注册表 / 空态 / 弹窗基类 / 配置写回 / 勾选契约） |
| 变异验证 | 无此概念 | 每个新用例都改坏一次被测代码，确认会红 |

---

## 三、收益：按「改一次要动几处」算

1. **加卡片从「七处补丁」变成「两个文件」。** 漏一处的老症状是「能渲染但点齿轮没反应」「手动刷新有用但笔记改了不更新」「沉浸模式不刷新」——这三类 bug 在过去几个月反复出现，根因就是七处里漏了一处。现在选择器、齿轮路由、删除按钮、刷新范围全部由注册表推出来。
2. **行为 bug 只有一处可修。** 四套勾选实现意味着四套失败提示、四套并发策略、四个「连点两次会怎样」的答案。上一轮重构里，「两卡并发写同一笔记丢更新」正是分散的直接代价，收成一个串行队列后从结构上消失。
3. **新模块可单独测试。** `vault-watcher.ts` 的依赖只剩 `obsidian` + `file-types`——没有渲染栈的导入副作用，才写得出用假计时器驱动 500ms 去抖的纯逻辑测试。同理 `reminders.ts` 的扫描是 `(data, settings, fired) → 提醒[]` 的纯函数。
4. **导航成本下降。** 以前「任务行怎么画的」要在 5,080 行里搜；现在文件名就是答案（`task-row.ts` / `project-doc.ts` / `memo.ts`）。`ARCHITECTURE.md` §8 给了一张「我要加的东西放哪」的速查表。
5. **重构本身变得可做。** Phase 0 的闸门是前置条件：没有它，任何一次搬移都只能靠记忆挑几个用例跑，这正是此前「不敢动」的根因。现在每搬一块跑 115/115，红的地方就是断言真的钉在代码位置上。

---

## 四、前后架构对比

### 4.1 重构前

```
main.ts
  └─ view.ts（3,818）      生命周期 / 事件路由 / 刷新 / 弹窗启动 / 提醒 / 写盘 …全在一个类里
       └─ renderer.ts（5,080）
            ├─ renderSection：550 行 if 链，每个分支手写「齿轮 + 刷新 + 删除 + 私有按钮」
            ├─ renderCard / 任务行 / 文档树 / 便签 / 图表 / 侧栏阅读 / widget 挂载 …
            └─ 三组模块级 let 传递 hoverParent / opener / component
```

同一种行为在多个文件里各有一份：

```
勾选任务   renderer.ts(待办)  dataview-section.ts  calendar-section.ts  ticktick
打开笔记   dataview-section   calendar-grid ×3     calendar-modal       pipeline(延时)
编辑后刷新 dataview 私有注册表 calendar 私有 reloaders  其余：等 vault 500ms 去抖
```

### 4.2 重构后

```
main.ts
  └─ view.ts（2,431）              一个 leaf 一个实例；唯一的视图状态持有者
       ├─ renderer.ts（110）        只剩 renderDashboard + 销毁前置 + 转发导出
       │    └─ render/section-frame.ts        renderSection：头部 → 齿轮 → def.render(ctx)
       │         ├─ section/defs/*.ts         每种卡片的渲染体（14 个注册项，覆盖 15 类型 + 3 别名）
       │         │    └─ render/card.ts       卡片外壳 + renderCardBody 分派
       │         └─ render/{task-row,memo,project-doc,tracker-chart,…}.ts   卡片内部结构
       ├─ view/*.ts                 事件表 / 提醒 / 写盘 / 手机壳 / 变更范围 / 看门狗
       └─ section/{registry,state,config-modal}.ts   跨卡片的契约层
```

依赖**只向下**：

| 层 | 可以 import | 不许 import |
| --- | --- | --- |
| `parser.ts` | `types` / 纯工具 | `section/` `render/` `view.ts` |
| `render/**` | `types`、其他 `render/**`、`section/registry` | `view.ts` |
| `view/*.ts` | 上面所有 | **`view.ts`**（会成环，一律走宿主接口） |
| `view.ts` | 全部 | — |

### 4.3 拆分前后的对照

| 维度 | 前 | 后 |
| --- | --- | --- |
| 职责边界 | 由行号决定（「大概在 3000 行附近」） | 由文件名决定（一个模块一个问题） |
| 依赖方向 | 双向、成环风险靠自觉 | 单向 DAG，`view/*` 靠 10 个宿主接口回调 |
| 状态归属 | 模块级 `let` 散落 35 处 | 视图唯一持有；宿主接口用 getter 不用快照 |
| 新增卡片 | 7 处补丁 | 1 个 `registerSection()` + 解析表 1 行 |
| 刷新路径 | 三条通道各自 if 判断 | 四条通道，来源决定路线（见 `ARCHITECTURE.md` §3） |
| 回归保障 | 101 个脚本，手动挑 | 115 个，一条命令 |

---

## 五、顺带修掉的真实缺陷

搬移不是纯机械动作，把纠缠的代码摊平之后，有几处结构缺陷自己露了出来：

| 缺陷 | 症状 | 根因 |
| --- | --- | --- |
| 倒计时提醒 | 没有 PM 分区的看板上**从不触发** | 那一趟扫描被误嵌在 PM 列循环内部，多缩进了一级 |
| 重复执行 | pipeline / PM / 纪念日三趟按列数重复跑 | 同上 |
| 并发丢更新 | 两卡同时勾选同一笔记，后者覆盖前者 | 3–4 套写盘各自为政，无串行队列 |
| 静默不刷新 | 新加一种扫描型分区，「笔记改了它永远不动」 | 类型硬编码在两个 Set 里，漏改一处就失效 |
| 同名不同射程 | 勾习惯时整条标签行被重建 | `refreshMobileWidgetPanel` 两个同名函数，一个刷整栏、一个只刷面板 |
| 死字段 | 注释说「parser 会跳过它」，实际无人读取 | `SectionDefinition.holdsCards` 误导后人，已删 |

---

## 六、代价与遗留

**代价（明账）**

- **+1,489 行（+1.4%）**：接口声明、宿主适配器、转发导出、模块头。这是「可 review 的纯移动」必须付的税——省掉转发，`view.ts` 与 9 个 verify 脚本就要同时改，改动就不再是「纯移动」。
- **+41 个文件**：找代码靠文件名和 `ARCHITECTURE.md` §8，不再靠滚动。
- **10 个宿主接口是新的耦合点**：它们把「视图能提供什么」写成了显式契约，比隐式 `this` 好，但改视图能力时要同步改接口。
- **`view.ts` 还剩 2,431 行**：剩下的全是读写 `this` 上 leaf 状态的视图逻辑，抽出去只会换来一个几十成员的宿主接口——那是把耦合换个文件放，不是降低耦合。

**遗留（未做，且刻意未做）**

| 项 | 为什么不在这轮做 |
| --- | --- |
| `taskArchivePath` 漏写 `.md` 时日志落到无扩展名文件 | 属于**行为**改动，不该混进「只搬不改」的提交 |
| `library-section.ts` 2,595 行（现最大非 i18n 文件） | 下一个该拆的目标，不是视图 |
| 列表内单行占位（`dashboard-library-empty`）未并进 `renderSectionState` | 与区块级空态职责不同，合并会把列表撑成一大块 |
| `parser.ts` 的 `SECTION_TYPES` 仍是手抄 | 解析层不该 import 渲染层；改为测试钉住「解析表 == 注册表 types + aliases」 |

---

## 七、结论

- **巨石问题已解决**：`renderer.ts` −97.8%，`view.ts` −36.3%，最大非 i18n 单文件从 5,080 降到 2,595，已不存在「一块文件读完才能改」的地方。
- **可拆的视图已拆净**：继续从 `view.ts` 搬方法，收益是负的。
- **下一轮该动的是行为与 `library-section.ts`**，而不是结构。

验证口径：`npm run check` 全绿——build 干净、lint 0 error 0 warning、115/115 测试通过（172 秒）。
