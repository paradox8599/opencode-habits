# opencode-habits

opencode V2 插件 `habit-profile`：从会话中提炼用户习惯，维护全局 / 项目两份画像，并在模型请求前注入。用户向文档见 `README.md`（安装 / 命令 / 配置 / 原理），开发约定与已知坑看本文件；注释、日志、命令输出、测试名一律中文。

## 命令

- `bun test` — 全部测试（56 个，纯单测，毫秒级）
- `bun test habits.test.ts` / `bun test -t "applyOps"` — 单文件 / 按名字过滤
- 没有 lint、typecheck、构建、CI、tsconfig，也没有任何依赖；别发明这些步骤

## 结构

- `habits.ts` — 纯逻辑：解析 / 序列化 / op 合并 / 注入文本拼装 / 待审批暂存与审批选择，不碰文件系统
- `server.ts` — 插件装配与 I/O：hooks、`/habits` 命令、提炼流程、审批流程、RPC 注册、原子写盘、缓存
- `rpc.ts` — 审批面板的 RPC 契约：普通对象（不用 `Rpc.define`），server 与 TUI 各自 import
- `tui.tsx` — 审批面板的 TUI 入口（`.tsx` 由 opencode 运行时转译，无需构建）；`jsx/` 是它的 JSX 转发层，别删
- `habits.test.ts` — 只测 habits.ts，注入确定性 newId / rand，无磁盘无网络
- 入口是 `server.ts` 的 `export default { id: "habit-profile", async setup(ctx) }`，`ctx` 全为 `any`（无 @opencode-ai/plugin 依赖）
- 能放进 habits.ts 的逻辑别写进 server.ts（server.ts 无法单测）
- 相对导入保留 `.ts` 后缀（`from "./habits.ts"`）
- 官网 /docs/plugins 描述的是旧式插件 API，与这里的 V2 形态不符，别照着它改

## 画像文件格式（契约）

- 分节为 6 个分类 + `## 已抑制`；条目行：`- 描述 <!-- id=a1b2 conf=0.80 seen=3 last=2026-09-14 -->`，id 为 4 位 `[a-z0-9]`
- `parsePortrait` 宽松（静默丢坏行），`lintPortrait` 严格（`/habits check` 用它）——加字段时两处都要处理
- 改格式要同时改 parse / serialize / lint 和测试

## 待审批暂存格式（契约）

- 文件：全局单一 `~/.config/opencode/habits.pending.json`，内容为 `PendingItem[]`：`{ baseDir, summary, op }`
- `summary` 是提炼时用 `describeOp(op, 全局画像, 项目画像)` 算好的人话描述（含目标条目原文），存下来是为了画像变化后列表不失真
- `parsePending` 宽松（坏条目静默丢、整个文件读不动当空列表），`serializePending` 写 2 空格缩进的 JSON
- 提炼只追加、不覆盖；编号是列表位置（1 起算），approve/reject 后重排——`selectPending` 负责解析 `1 3` / `all`
- 弹窗一次性提交走另一条路：`selectDecisions(items, decisions)` 按 `{ index, action }` 分流，未列入 decisions 的条目原样留在 `rest`（支持分几次处理）；同编号重复出现以最后一个动作为准

## 审批面板（RPC 契约）

- `rpc.ts` 的 `HABITS_RPC` 是**普通对象**，不是 `Rpc.define` 的返回值：RPC 按 `definition.id` 字符串路由，与对象身份无关，所以 server / TUI 各自 import 同一个 `rpc.ts` 即可，不需要 `node_modules`（本插件目录没有依赖）
- `methods` 里的两个方法必须同时给 `input` 与 `output`（普通 JSON Schema），`events` 字段不可省（写 `{}`）
- server 端 `ctx.rpc.register(HABITS_RPC, { list, review })`：`list` 返回已渲染好的 `{ items, revision }`；`review` 收 `{ revision, decisions }`，返回 `{ approved, rejected, remaining, errors }`
- `revision` 是 `pendingRevision(items)`（habits.ts，FNV-1a 指纹）算出的列表指纹：`list` 时下发、`review` 时回传，server 在串行块里核对，不匹配则整批拒绝（`errors` 带「列表已变化」），避免面板打开后列表被其它窗口改动导致位置编号错位
- 两条 RPC 方法都复用 `resolvePending`（内部走 `serialized()`），读改写在一个串行块里完成，避免读两次文件导致编号错位
- TUI 侧 `context.client.rpc(HABITS_RPC)`，返回对象是按 `definition.id` 从 HTTP 路由回 server 的（不依赖对象身份）
- `tui.tsx` 用 `session.panel` 承载面板（不是自定义 dialog）：宿主负责尺寸/焦点/全屏，插件只画内容；命令用 `context.ui.panel.open("habit-profile.review")` 打开，`session.panel` 的 render 收 `panel.name` 匹配
- 面板命令挂在常驻的 `append:"app"` 槽上（`keymap.layer` 必须在组件渲染上下文里调用）；`slash: { name: "habits-panel" }` 且必须带 `id`
- 待审批列表必须放进 `<scrollbox>`（`flexGrow={1} minHeight={0}`）：可能有几百条，直接 `<For>` 进普通 `<box>` 会把面板撑爆、画面错位；每行给 `id={`habit-profile.item.${index()}`}`，光标变化时 `scrollChildIntoView(id)`，且要等一帧（`requestAnimationFrame`）布局才更新
- 普通 `<box>` 里多个 `<text>` 直接子节点会重叠在同一行（真机与 `@opentui/core/testing` 都能复现），每个 `<text>` 外面包一层 `<box>` 才会上下排列
- `tui.tsx` 第 1 行必须是 `/** @jsxImportSource ./jsx */`，**不能写 `@opentui/solid`**——这是按 GitHub 包装进 `node_modules` 后唯一的可用形态：
  - opencode 的 `bun-plugin-opentui-runtime-modules` 只改写源码里写死的 import，Bun 按 pragma 事后注入的那句改写不到；而 `@opentui/solid` 的 Solid 变换插件 filter 明确排除 `node_modules`，`node_modules` 内的 `.tsx` 走的是 Bun 原生 JSX
  - 于是注入的 `@opentui/solid/jsx-dev-runtime` 走原生解析去插件自己目录找，而本仓库不声明依赖、npm 什么都不装 → `Cannot find package '@opentui/solid'`（server 半边不受影响，只有 tui 入口报错）
  - 指向 `./jsx` 后注入的是相对路径（可解析），`jsx/*.ts` 里 re-export 的那句 `@opentui/solid/jsx-*` 是源码里的 import，会被改写到 opencode 自带的运行时模块，拿到宿主那份 `@opentui/solid`
  - `tui.tsx` 顶部还必须显式 `import "./jsx/jsx-runtime.ts"` 与 `import "./jsx/jsx-dev-runtime.ts"`（prescan 种子，别当死代码删掉）：opencode 只给「从入口递归扫源码 import 图扫得到的文件」登记精确路径的改写 loader，而 Bun 注入的 jsx 导入是编译期产物、扫不到，少了这两行 shim 就不会被登记，装载时走原生解析 → 仍然报 `Cannot find package '@opentui/solid'`（报错位置会显示 `jsx/jsx-dev-runtime.ts`）
  - 别改成「补 package.json 的 exports + peerDependencies」：那会让 npm 把 `@opentui/*` 装进插件自己的 `node_modules`，Bun 注入的 import 不走改写、用上插件自己那份 OpenTUI，与宿主是两个 renderer 实例，面板会静默不显示（上游 issue #33884）
  - 本地路径安装（插件在 `node_modules` 之外）本来就走 Solid 变换，shim 不参与，两种形态都无需预编译 / exports / 改 tui.jsonc
- 子会话（子代理，有 `parentID`）不参与提炼

## 数值语义

- 置信度：explicit 新增 0.8 / correction 0.2 / ambient 0.1；强化 +0.2（ambient +0.1）；contradict -0.2，低于 0.15 移入已抑制；clamp 后保留 2 位小数
- 重复 add（文本归一化后相同）自动转 reinforce；已抑制文本不会被重新 add
- 单条描述 160 字上限；一次提炼最多 30 个 op

## 容易踩的坑（server.ts）

- 写画像必须走 `serialized()` 串行队列 + `writePortraitFile`（临时文件 + rename），缓存按 mtime+size 失效；新增写路径别绕开
- 待审批暂存同理：`readPendingFile` / `writePendingFile`（同样是临时文件 + rename），读改写必须在 `serialized()` 里做，否则 approve 与提炼并发会互相覆盖
- 提炼（`refresh`）现在只写 pending，不写画像；真正落盘在 `review`（approve 分支）里按 scope 分组调 `applyOps`
- 提炼必须用 `ctx.session.generate` 在每项目一个的后台会话里跑（`ensureRefineSession`，storage key `refine-session:<baseDir>`，会话标题「习惯画像 · 后台提炼（插件自动创建）」）：provider `o` 的网关要求会话路由头，无会话的 `ctx.generate.text` 会被拒
- `/habits` 输出走「只显示、不进模型」通道：`ctx.session.synthetic({ ..., description: text, resume: false, metadata: OUTPUT_METADATA })`；漏传 `description` 在 TUI 里看不见，漏传 `resume: false` 会白跑一次模型回复
- 上面这条通道靠 context 钩子里的 `isOutputMessage` 过滤把输出消息从 `event.messages` 剥掉，否则它会进入后续请求的上下文
- 子会话（子代理，有 `parentID`）不参与提炼
- 「add 只接受 explicit/correction」只写在提炼提示词里，代码不拦（`parseOp` 缺省 `ambient`，`applyOps` 照收）——别以为代码保证了它

## 运行与生效

- 插件 options：`model`（`"provider/model"` 或对象）、`maxInjectedItems`（默认 40）、`autoEveryNMessages`（默认 10，0 关闭自动提炼）
- 画像文件：全局 `~/.config/opencode/habits.md`，项目 `<项目>/.opencode/habits.md`，待审批暂存 `~/.config/opencode/habits.pending.json`；用户入口是 `/habits view|refresh|check|forget <关键词|id>` 与 `/habits approve|reject <编号…|all>`，forget 把命中条目移入已抑制；TUI 侧另有 `/habits-panel` 斜杠命令打开审批面板
- 本机 `~/.config/opencode/opencode.jsonc` 的 plugins 指向 GitHub 包 `github:paradox8599/opencode-habits`，加载的是 npm 缓存副本（`~/.cache/opencode/npm/git-opencode-habits-*/<时间戳>/node_modules/opencode-habits/`）；改本地代码要在本仓库 commit + push 后重启 opencode，或在配置里临时改回本地目录路径 `/Users/para/Repos/opencode-habits`（本地路径形态下改代码重启即生效）
