# opencode-habits

opencode V2 插件 `habit-profile`：从会话中提炼用户习惯，维护全局 / 项目两份画像，并在模型请求前注入。用户向文档见 `README.md`（安装 / 命令 / 配置 / 原理），开发约定与已知坑看本文件；注释、日志、命令输出、测试名一律中文。

## 命令

- `bun test` — 全部测试（37 个，纯单测，毫秒级）
- `bun test habits.test.ts` / `bun test -t "applyOps"` — 单文件 / 按名字过滤
- 没有 lint、typecheck、构建、CI、tsconfig，也没有任何依赖；别发明这些步骤

## 结构

- `habits.ts` — 纯逻辑：解析 / 序列化 / op 合并 / 注入文本拼装，不碰文件系统
- `server.ts` — 插件装配与 I/O：hooks、`/habits` 命令、提炼流程、原子写盘、缓存
- `habits.test.ts` — 只测 habits.ts，注入确定性 newId / rand，无磁盘无网络
- 入口是 `server.ts` 的 `export default { id: "habit-profile", async setup(ctx) }`，`ctx` 全为 `any`（无 @opencode-ai/plugin 依赖）
- 能放进 habits.ts 的逻辑别写进 server.ts（server.ts 无法单测）
- 相对导入保留 `.ts` 后缀（`from "./habits.ts"`）
- 官网 /docs/plugins 描述的是旧式插件 API，与这里的 V2 形态不符，别照着它改

## 画像文件格式（契约）

- 分节为 6 个分类 + `## 已抑制`；条目行：`- 描述 <!-- id=a1b2 conf=0.80 seen=3 last=2026-09-14 -->`，id 为 4 位 `[a-z0-9]`
- `parsePortrait` 宽松（静默丢坏行），`lintPortrait` 严格（`/habits check` 用它）——加字段时两处都要处理
- 改格式要同时改 parse / serialize / lint 和测试

## 数值语义

- 置信度：explicit 新增 0.8 / correction 0.2 / ambient 0.1；强化 +0.2（ambient +0.1）；contradict -0.2，低于 0.15 移入已抑制；clamp 后保留 2 位小数
- 重复 add（文本归一化后相同）自动转 reinforce；已抑制文本不会被重新 add
- 单条描述 160 字上限；一次提炼最多 30 个 op

## 容易踩的坑（server.ts）

- 写画像必须走 `serialized()` 串行队列 + `writePortraitFile`（临时文件 + rename），缓存按 mtime+size 失效；新增写路径别绕开
- 提炼必须用 `ctx.session.generate` 在每项目一个的后台会话里跑（`ensureRefineSession`，storage key `refine-session:<baseDir>`，会话标题「习惯画像 · 后台提炼（插件自动创建）」）：provider `o` 的网关要求会话路由头，无会话的 `ctx.generate.text` 会被拒
- TUI 只渲染带 `description` 的 synthetic 消息：`ctx.session.synthetic({ sessionID, text, description: text })`，漏传就只落盘、什么都看不见
- 子会话（子代理，有 `parentID`）不参与提炼
- 「add 只接受 explicit/correction」只写在提炼提示词里，代码不拦（`parseOp` 缺省 `ambient`，`applyOps` 照收）——别以为代码保证了它

## 运行与生效

- 插件 options：`model`（`"provider/model"` 或对象）、`maxInjectedItems`（默认 40）、`autoEveryNMessages`（默认 10，0 关闭自动提炼）
- 画像文件：全局 `~/.config/opencode/habits.md`，项目 `<项目>/.opencode/habits.md`；用户入口是 `/habits view|refresh|check|forget <关键词|id>`，forget 把命中条目移入已抑制
- 会话加载的是从 GitHub 安装的缓存副本（`~/.cache/opencode/npm/git-opencode-habits-*/<时间戳>/`）：本地改动不会立即生效，端到端验证要靠用户重装 / 重启；推送和改全局配置都超出当前权限
