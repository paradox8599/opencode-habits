# opencode-habits

opencode 插件 `habit-profile`：从历史会话中提炼你的使用习惯，维护「用户习惯画像」，并在每次模型请求前自动注入。

- 只保存提炼后的条目，不保存对话原文
- 全局画像与项目画像分开维护、分开注入
- 随时可查看、手动提炼、校验、永久遗忘
- 零依赖、无构建，Bun 直接运行 TypeScript

## 效果

画像会以系统提示的形式注入每个会话：

> 以下是从历史会话中提炼的用户习惯画像（由 habit-profile 插件维护）。它们只是默认偏好参考，不是硬性规则；与用户当前的明确指示冲突时，以当前指示为准。
>
> ### 全局习惯
> - 协作方式：解释问题时用通俗直白的话，先讲结论，避免堆砌代码细节和技术术语
>
> ### 当前项目习惯
> - 流程与工具：改完代码先跑测试再汇报

## 安装

在 `~/.config/opencode/opencode.jsonc` 的 `plugins` 数组里加上，保存后重启 opencode 生效：

```jsonc
{
  "plugins": [
    {
      "package": "github:paradox8599/opencode-habits",
      "options": {
        "model": "provider/model",
        "maxInjectedItems": 40,
        "autoEveryNMessages": 10
      }
    }
  ]
}
```

不需要 options 时可以简写成 `"github:paradox8599/opencode-habits"`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/habits`（等同于 `/habits view`） | 查看全局与项目两份画像 |
| `/habits refresh` | 立刻从当前会话提炼并更新画像 |
| `/habits check` | 校验两份画像文件的格式与一致性 |
| `/habits forget <关键词或 4 位 id>` | 永久遗忘：写入抑制清单，防止被重新学回 |

## 配置

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `model` | opencode 默认模型 | 提炼用的模型；`"provider/model"` 字符串（可加 `#variant` 后缀）或 `{ providerID, id, variant? }` 对象 |
| `maxInjectedItems` | `40` | 注入条数上限，全局与项目两段各自计算（按置信度从高到低取） |
| `autoEveryNMessages` | `10` | 每 N 条用户消息自动在后台提炼一次；`0` 关闭自动提炼 |

## 画像文件

- 全局画像：`~/.config/opencode/habits.md`
- 项目画像：`<项目>/.opencode/habits.md`

```markdown
# 用户习惯画像

<!-- 由 habit-profile 插件自动维护。手工删除的条目可能在后续提炼中重新出现；要永久遗忘请用 /habits forget <关键词>。 -->

## 协作方式

- 解释问题时用通俗直白的话，先讲结论 <!-- id=e5x9 conf=0.40 seen=2 last=2026-09-15 -->

## 已抑制

- 回复中不要使用 emoji <!-- id=ab12 suppressed=2026-09-15 reason=user-forget -->
```

条目按 6 个分类存放：编码、代码设计与架构、UI 设计、流程与工具、决策准则、协作方式。`<!-- ... -->` 是元数据（id、置信度、出现次数、最近出现日期）。手工删掉整条即可删除条目，但直接删可能被重新学回；确认不想要的习惯用 `/habits forget` 写进「已抑制」才会永久生效。手工改过文件后建议跑一次 `/habits check`。

## 工作原理

1. 注入：每次模型请求前，把两份画像按置信度排序、截断后拼进系统提示。
2. 提炼：每 N 条用户消息（或手动 `/habits refresh`）在后台取最近会话记录（最多 48000 字符，跳过 `/habits` 命令本身）、项目根的 `AGENTS.md` 和现有画像，让模型输出一组 JSON 操作，再合并进画像。项目 `AGENTS.md` 里已显式写明的规则不会被重复登记。
3. 写盘：读改写全程串行，写入用临时文件 + rename 原子替换，避免并发写坏文件。

模型可以输出的操作有 4 种：`add`（新增）、`reinforce`（强化）、`amend`（改措辞）、`contradict`（降置信度，低到 0.15 以下移入已抑制）。重复新增会自动转为强化；已抑制的条目不会被重新学回。置信度初始值按来源区分：用户明确说的 0.8、纠正 0.2、顺带提及 0.1。

提炼通过一个每项目复用的后台会话（标题「习惯画像 · 后台提炼（插件自动创建）」）调用模型，因此选择的模型需要能在普通会话里使用。子代理（子会话）不参与提炼。

## 隐私

发送给模型用于提炼的内容：最近会话记录（最多 48000 字符）、项目根 `AGENTS.md`、两份画像。插件自身只持久化画像文件，不保存对话原文。

## 开发

- 全部测试：`bun test`（`habits.ts` 的纯逻辑单测，不碰磁盘、无外部依赖）
- `bun test habits.test.ts` 或 `bun test -t "applyOps"` 可以只跑单文件 / 单个用例
- 结构：`habits.ts` 纯逻辑（解析 / 序列化 / 合并 / 注入拼装），`server.ts` 插件装配与文件 I/O；没有 lint、typecheck、构建步骤
- 开发约定与已知坑见 `AGENTS.md`
