// habit-profile：opencode V2 插件
//
// 从会话里持续提炼用户的编码 / 设计 / 架构 / 决策习惯，维护两份跨会话画像
// （~/.config/opencode/habits.md 与 <项目>/.opencode/habits.md），并在模型请求前注入。
// 只持久化提炼后的画像条目，不保存任何对话原文。
//
// 命令：/habits 查看 · /habits refresh 提炼本会话 · /habits forget <关键词|id> 永久遗忘

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  applyOps,
  buildInjection,
  describePortrait,
  describeSuppressed,
  parseOpsJson,
  parsePortrait,
  serializePortrait,
  suppressMatches,
  type ApplyResult,
  type Change,
  type Portrait,
  type Scope,
} from "./habits.ts"

const GLOBAL_PATH = join(homedir(), ".config", "opencode", "habits.md")
const TRANSCRIPT_BUDGET = 48_000
const DEFAULT_MAX_ITEMS = 40
const DEFAULT_AUTO_EVERY = 10
const VIEW_TEXT_LIMIT = 6_000

const USAGE = [
  "用法：",
  "- /habits          查看两份习惯画像",
  "- /habits refresh  从当前会话提炼并更新画像",
  "- /habits forget <关键词或 4 位 id>  永久遗忘（写入抑制清单，防止重新学回）",
].join("\n")

// 提炼用的后台会话标题（每个项目一个，自动创建并复用）。
const REFINE_TITLE = "习惯画像 · 后台提炼（插件自动创建）"

function log(...args: unknown[]): void {
  console.error("[habit-profile]", ...args)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function todayString(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

// ---------------------------------------------------------------------------
// 文件读写（原子替换 + mtime 缓存 + 进程内串行化）

const portraitCache = new Map<string, { mtimeMs: number; size: number; portrait: Portrait }>()
const projectDirCache = new Map<string, string>()
const injectedSessions = new Set<string>()
const messageCounts = new Map<string, number>()
const autoQueued = new Set<string>()
const childSessionCache = new Map<string, boolean>()

let queue: Promise<unknown> = Promise.resolve()
let refineChain: Promise<unknown> = Promise.resolve()

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// 提炼串行队列：手动与自动提炼共用一个队列，避免并发 generate 撞同一个后台会话。
function queuedRefine<T>(task: () => Promise<T>): Promise<T> {
  const run = refineChain.then(task, task)
  refineChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// 子会话（子代理）不参与习惯提炼：它们的记录是任务上下文，不是用户的稳定习惯。
async function isChildSession(ctx: any, sessionID: string): Promise<boolean> {
  const cached = childSessionCache.get(sessionID)
  if (cached !== undefined) return cached
  let child = false
  try {
    const session = await ctx.session.get({ sessionID })
    child = Boolean(session?.parentID)
  } catch {
    // 读不到会话信息时按普通会话处理
  }
  childSessionCache.set(sessionID, child)
  return child
}

async function readPortraitFile(path: string): Promise<Portrait> {
  try {
    const info = await stat(path)
    const cached = portraitCache.get(path)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.portrait
    const portrait = parsePortrait(await readFile(path, "utf8"))
    portraitCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, portrait })
    return portrait
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code !== "ENOENT") log("读取画像失败：", path, errorText(error))
    return { entries: [], suppressed: [] }
  }
}

async function writePortraitFile(path: string, portrait: Portrait): Promise<void> {
  const temp = `${path}.tmp-${process.pid}`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temp, serializePortrait(portrait), "utf8")
  await rename(temp, path)
  portraitCache.delete(path)
}

async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code !== "ENOENT") log("读取文件失败：", path, errorText(error))
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 项目定位：优先插件实例的规范项目根，会话跨项目时回退到会话所在目录

async function projectDirOf(ctx: any, sessionID: string): Promise<string> {
  const cached = projectDirCache.get(sessionID)
  if (cached) return cached
  const instance = ctx.location?.project
  let resolved: string | undefined
  try {
    const session = await ctx.session.get({ sessionID })
    if (session?.projectID && instance?.id && session.projectID === instance.id && instance.directory) {
      resolved = instance.directory
    } else if (session?.location?.directory) {
      resolved = session.location.directory
    }
  } catch (error) {
    log("session.get 失败：", errorText(error))
  }
  resolved ??= instance?.directory ?? ctx.location?.directory ?? process.cwd()
  projectDirCache.set(sessionID, resolved)
  return resolved
}

function projectHabitsPath(baseDir: string): string {
  return join(baseDir, ".opencode", "habits.md")
}

// ---------------------------------------------------------------------------
// 注入

async function injectionFor(ctx: any, sessionID: string, maxItems: number): Promise<string> {
  const baseDir = await projectDirOf(ctx, sessionID)
  const [globalPortrait, projectPortrait] = await Promise.all([
    readPortraitFile(GLOBAL_PATH),
    readPortraitFile(projectHabitsPath(baseDir)),
  ])
  const text = buildInjection(globalPortrait, projectPortrait, maxItems)
  if (text && !injectedSessions.has(sessionID)) {
    injectedSessions.add(sessionID)
    log(`已注入画像：全局 ${globalPortrait.entries.length} 条 / 项目 ${projectPortrait.entries.length} 条（session ${sessionID}）`)
  }
  return text
}

// ---------------------------------------------------------------------------
// 命令

interface ParsedCommand {
  action: "view" | "refresh" | "forget" | "usage"
  keywords: string[]
}

function parseCommand(rawText: string): ParsedCommand {
  const tokens = rawText
    .trim()
    .replace(/^\/habits\b/, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const [head, ...rest] = tokens
  if (!head || head === "view" || head === "list") return { action: "view", keywords: [] }
  if (head === "refresh") return { action: "refresh", keywords: [] }
  if (head === "forget" && rest.length) return { action: "forget", keywords: rest }
  return { action: "usage", keywords: [] }
}

async function handleCommand(ctx: any, sessionID: string, rawText: string, maxItems: number): Promise<void> {
  const reply = async (text: string) => {
    try {
      await ctx.session.synthetic({ sessionID, text })
    } catch (error) {
      log("synthetic 发送失败：", errorText(error))
    }
  }
  try {
    const command = parseCommand(rawText)
    if (command.action === "view") {
      const baseDir = await projectDirOf(ctx, sessionID)
      const [globalPortrait, projectPortrait] = await Promise.all([
        readPortraitFile(GLOBAL_PATH),
        readPortraitFile(projectHabitsPath(baseDir)),
      ])
      await reply(viewText(globalPortrait, projectPortrait, baseDir, maxItems))
      return
    }
    if (command.action === "refresh") {
      messageCounts.set(sessionID, 0)
      await queuedRefine(() => refresh(ctx, sessionID, reply))
      return
    }
    if (command.action === "forget") {
      await forget(ctx, sessionID, command.keywords, reply)
      return
    }
    await reply(USAGE)
  } catch (error) {
    log("命令处理失败：", errorText(error))
    await reply(`习惯画像操作失败：${errorText(error)}`)
  }
}

function viewText(globalPortrait: Portrait, projectPortrait: Portrait, baseDir: string, maxItems: number): string {
  const lines = ["习惯画像", ""]
  lines.push(`全局（${GLOBAL_PATH}）：共 ${globalPortrait.entries.length} 条，已抑制 ${globalPortrait.suppressed.length} 条`)
  lines.push(describePortrait(globalPortrait), "")
  lines.push(
    `项目（${projectHabitsPath(baseDir)}）：共 ${projectPortrait.entries.length} 条，已抑制 ${projectPortrait.suppressed.length} 条`,
  )
  lines.push(describePortrait(projectPortrait), "")
  if (globalPortrait.suppressed.length) {
    lines.push("已抑制（全局）：", describeSuppressed(globalPortrait), "")
  }
  if (projectPortrait.suppressed.length) {
    lines.push("已抑制（项目）：", describeSuppressed(projectPortrait), "")
  }
  lines.push(`注入上限：每份画像按置信度取前 ${maxItems} 条；/habits refresh 提炼本会话；/habits forget 永久遗忘。`)
  const text = lines.join("\n")
  return text.length > VIEW_TEXT_LIMIT ? `${text.slice(0, VIEW_TEXT_LIMIT)}\n…（输出过长已截断）` : text
}

function summarizeChanges(label: string, result: ApplyResult): string {
  const count = (op: Change["op"]) => result.changes.filter((change) => change.op === op).length
  const total = result.portrait.entries.length
  if (!result.changes.length) return `${label}：无变化（共 ${total} 条）`
  const parts = [`新增 ${count("add")}`, `强化 ${count("reinforce")}`, `修订 ${count("amend")}`]
  const weakened = count("contradict") + count("suppress")
  if (weakened) parts.push(`转弱/抑制 ${weakened}`)
  return `${label}：${parts.join(" · ")}（共 ${total} 条）`
}

async function forget(
  ctx: any,
  sessionID: string,
  keywords: string[],
  reply: (text: string) => Promise<void>,
): Promise<void> {
  const baseDir = await projectDirOf(ctx, sessionID)
  const projectPath = projectHabitsPath(baseDir)
  const today = todayString()
  let removedGlobal: string[] = []
  let removedProject: string[] = []
  await serialized(async () => {
    const globalPortrait = await readPortraitFile(GLOBAL_PATH)
    const globalResult = suppressMatches(globalPortrait, keywords, today)
    if (globalResult.removed.length) {
      await writePortraitFile(GLOBAL_PATH, globalResult.portrait)
      removedGlobal = globalResult.removed.map((entry) => `[${entry.id}] ${entry.category}：${entry.text}`)
    }
    const projectPortrait = await readPortraitFile(projectPath)
    const projectResult = suppressMatches(projectPortrait, keywords, today)
    if (projectResult.removed.length) {
      await writePortraitFile(projectPath, projectResult.portrait)
      removedProject = projectResult.removed.map((entry) => `[${entry.id}] ${entry.category}：${entry.text}`)
    }
  })
  if (!removedGlobal.length && !removedProject.length) {
    await reply(`没有找到匹配「${keywords.join(" ")}」的条目（可按关键词或 4 位 id 搜索）。`)
    return
  }
  const lines = [`已遗忘 ${removedGlobal.length + removedProject.length} 条（写入抑制清单，后续提炼不会重新登记）：`]
  for (const item of removedGlobal) lines.push(`- 全局 ${item}`)
  for (const item of removedProject) lines.push(`- 项目 ${item}`)
  await reply(lines.join("\n"))
}

async function sessionTranscript(ctx: any, sessionID: string): Promise<string> {
  const messages = await ctx.session.context({ sessionID })
  const lines: string[] = []
  let used = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    let line: string | undefined
    if (message?.type === "user") {
      const text = typeof message.text === "string" ? message.text.trim() : ""
      if (text && !text.startsWith("/habits")) line = `用户：${text}`
    } else if (message?.type === "assistant") {
      const text = (Array.isArray(message.content) ? message.content : [])
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n")
        .trim()
      if (text) line = `助手：${text}`
    }
    if (!line) continue
    if (used + line.length > TRANSCRIPT_BUDGET) break
    used += line.length
    lines.push(line)
  }
  return lines.reverse().join("\n\n")
}

function buildRefinePrompt(input: {
  globalPortrait: Portrait
  projectPortrait: Portrait
  agentsMd: string | undefined
  transcript: string
}): string {
  return [
    "你是用户习惯画像（habit-profile）的提炼器。请从最新会话记录中提炼用户的稳定习惯，与已有画像合并，输出一组结构化操作（ops）。",
    "",
    "## 分类（只能使用这 6 个）",
    "- 编码：写代码层面的偏好（语言特性、命名、类型、写法）",
    "- 代码设计与架构：结构与选型（模块边界、抽象层次、依赖选择）",
    "- UI 设计：视觉、界面、交互偏好",
    "- 流程与工具：工作流程与工具链（测试、调试、提交、命令习惯）",
    "- 决策准则：反复出现的取舍价值取向（如「优先简单」「先验证再实现」）",
    "- 协作方式：与助手协作时的要求（如「先给方案再动手」「中文交流」）",
    "",
    "## 登记门槛（重要）",
    "1. 只登记预计跨会话复用的偏好；一次性的任务细节不算习惯。",
    "2. 不摘录对话原文，用自己的话概括成不超过 50 字的一句短句。",
    "3. 项目 AGENTS.md 里已显式写明的规则不登记。",
    "4. 项目专属事实（品牌色、设计系统名称、密钥、业务名词）不登记。",
    "5. 归不进上述 6 类的丢弃，不要发明新分类。",
    "6. 新条目（add）只接受 explicit / correction 信号；ambient 信号只能用于强化已有条目。",
    "7. 「已抑制」清单中的内容一律不得重新登记。",
    "8. reinforce / amend / contradict 只能引用已有画像里出现过的 id 与 scope。",
    "",
    "## 信号分级",
    "- explicit：用户明确要求记住或以后都用（「记住…」「以后都用…」）",
    "- correction：用户在纠正你的行为（「不要用…」「我说过要…」）",
    "- ambient：日常对话中自然流露，仅用于强化已有条目",
    "",
    "## scope 选择",
    "- global：跨项目通用；project：只适用于当前项目。",
    "",
    "## 已有画像 · 全局",
    describePortrait(input.globalPortrait),
    "",
    "## 已有画像 · 项目",
    describePortrait(input.projectPortrait),
    "",
    "## 已抑制 · 全局（不得重新登记）",
    describeSuppressed(input.globalPortrait),
    "",
    "## 已抑制 · 项目（不得重新登记）",
    describeSuppressed(input.projectPortrait),
    "",
    "## 项目 AGENTS.md（其中已有规则无需登记）",
    input.agentsMd?.trim() || "（无）",
    "",
    "## 最新会话记录",
    input.transcript || "（无）",
    "",
    "## 输出",
    '只输出一个 JSON 对象，不要输出任何其他文字：',
    '{"ops":[',
    '  {"op":"add","scope":"global","category":"编码","text":"不超过 50 字的习惯描述","signal":"explicit"},',
    '  {"op":"reinforce","scope":"project","id":"已有条目 id","signal":"correction"},',
    '  {"op":"amend","scope":"project","id":"已有条目 id","text":"修订后的描述"},',
    '  {"op":"contradict","scope":"global","id":"已有条目 id"}',
    "]}",
    '没有可提炼的内容时输出 {"ops":[]}。只依据上述材料判断，不要脑补。',
  ].join("\n")
}

async function resolveModel(ctx: any): Promise<{ providerID: string; id: string } | undefined> {
  const configured = ctx.options?.model
  if (configured && typeof configured.providerID === "string" && typeof configured.id === "string") {
    return { providerID: configured.providerID, id: configured.id }
  }
  try {
    const fallback = await ctx.catalog.model.default()
    const model = fallback?.data
    if (model && typeof model.providerID === "string" && typeof model.id === "string") {
      return { providerID: model.providerID, id: model.id }
    }
  } catch (error) {
    log("读取默认模型失败：", errorText(error))
  }
  return undefined
}

// 提炼必须走会话内生成：部分 provider（如本机的 o）要求请求带上会话路由头，
// 无会话的 ctx.generate.text 会被网关拒绝。为保持"便宜模型提炼"，插件为每个项目
// 维护一个专用的后台会话（无历史消息），用 session.generate 做瞬时生成。
async function ensureRefineSession(
  ctx: any,
  baseDir: string,
  model: { providerID: string; id: string },
): Promise<string> {
  const key = `refine-session:${baseDir}`
  const modelTag = `${model.providerID}/${model.id}`
  const stored = (await ctx.storage.get(key)) as { id?: string; model?: string } | undefined
  if (stored?.id) {
    try {
      await ctx.session.get({ sessionID: stored.id })
      if (stored.model !== modelTag) {
        await ctx.session.switchModel({ sessionID: stored.id, model })
        await ctx.storage.set(key, { id: stored.id, model: modelTag })
      }
      return stored.id
    } catch {
      log("后台提炼会话已不存在，重建：", stored.id)
    }
  }
  const created = await ctx.session.create({ title: REFINE_TITLE, model, location: { directory: baseDir } })
  await ctx.storage.set(key, { id: created.id, model: modelTag })
  return created.id
}

async function refineText(
  ctx: any,
  baseDir: string,
  model: { providerID: string; id: string },
  prompt: string,
): Promise<string> {
  const sessionID = await serialized(() => ensureRefineSession(ctx, baseDir, model))
  const result = await ctx.session.generate({ sessionID, prompt })
  return result?.text ?? ""
}

async function refresh(ctx: any, sessionID: string, reply: (text: string) => Promise<void>): Promise<void> {
  const baseDir = await projectDirOf(ctx, sessionID)
  const projectPath = projectHabitsPath(baseDir)
  const [globalPortrait, projectPortrait, transcript, agentsMd] = await Promise.all([
    readPortraitFile(GLOBAL_PATH),
    readPortraitFile(projectPath),
    sessionTranscript(ctx, sessionID),
    readTextFile(join(baseDir, "AGENTS.md")),
  ])
  const model = await resolveModel(ctx)
  if (!model) {
    await reply("习惯画像：没有可用的提炼模型（插件 options.model 未配置，也读不到默认模型）。")
    return
  }
  const prompt = buildRefinePrompt({ globalPortrait, projectPortrait, agentsMd, transcript })
  log(`开始提炼（session ${sessionID}，模型 ${model.providerID}/${model.id}，记录 ${transcript.length} 字）`)
  const generatedText = await refineText(ctx, baseDir, model, prompt)
  const { ops, errors } = parseOpsJson(generatedText)
  if (errors.length) log("提炼输出有被忽略的 op：", errors.join("；"))
  if (!ops.length) {
    await reply("习惯画像：本会话没有可提炼的新内容。")
    return
  }
  const today = todayString()
  const at = (scope: Scope) => ops.filter((op) => op.scope === scope)
  let globalResult: ApplyResult | undefined
  let projectResult: ApplyResult | undefined
  await serialized(async () => {
    globalResult = applyOps(await readPortraitFile(GLOBAL_PATH), at("global"), today)
    projectResult = applyOps(await readPortraitFile(projectPath), at("project"), today)
    if (globalResult.changes.length) await writePortraitFile(GLOBAL_PATH, globalResult.portrait)
    if (projectResult.changes.length) await writePortraitFile(projectPath, projectResult.portrait)
  })
  const lines = ["习惯画像已刷新", summarizeChanges("全局", globalResult!), summarizeChanges("项目", projectResult!)]
  await reply(lines.join("\n"))
}

// ---------------------------------------------------------------------------
// 插件装配

export default {
  id: "habit-profile",
  async setup(ctx: any) {
    const maxItems = Number.isFinite(Number(ctx.options?.maxInjectedItems))
      ? Number(ctx.options.maxInjectedItems)
      : DEFAULT_MAX_ITEMS
    // 自动提炼：每 N 条用户消息一次；显式配 0 关闭，缺省用默认值。
    const autoEvery = Number.isFinite(Number(ctx.options?.autoEveryNMessages))
      ? Math.max(0, Math.floor(Number(ctx.options.autoEveryNMessages)))
      : DEFAULT_AUTO_EVERY
    log(
      `插件加载：location=${ctx.location?.directory ?? "?"} project=${ctx.location?.project?.directory ?? "?"} maxInjectedItems=${maxItems} autoEveryNMessages=${autoEvery} options=${JSON.stringify(ctx.options ?? {})}`,
    )
    const registrations: Array<{ dispose(): Promise<void> }> = []
    registrations.push(
      await ctx.session.hook("context", async (event: any) => {
        try {
          const text = await injectionFor(ctx, event.sessionID, maxItems)
          if (text) event.system.push({ type: "text", text })
        } catch (error) {
          log("注入失败（已忽略）：", errorText(error))
        }
      }),
    )
    registrations.push(
      await ctx.session.hook("prompt", async (event: any) => {
        try {
          if (autoEvery <= 0) return
          const text = typeof event?.prompt?.text === "string" ? event.prompt.text.trim() : ""
          if (!text || text.startsWith("/habits")) return
          if (await isChildSession(ctx, event.sessionID)) return
          const count = (messageCounts.get(event.sessionID) ?? 0) + 1
          if (count < autoEvery) {
            messageCounts.set(event.sessionID, count)
            return
          }
          messageCounts.set(event.sessionID, 0)
          if (autoQueued.has(event.sessionID)) return
          autoQueued.add(event.sessionID)
          log(`自动提炼触发（session ${event.sessionID}，每 ${autoEvery} 条用户消息）`)
          void queuedRefine(async () => {
            try {
              await refresh(ctx, event.sessionID, async (replyText) => {
                log(`自动提炼结果：${replyText.replace(/\n/g, " · ")}`)
              })
            } catch (error) {
              log("自动提炼失败（已忽略）：", errorText(error))
            } finally {
              autoQueued.delete(event.sessionID)
            }
          })
        } catch (error) {
          log("prompt hook 失败（已忽略）：", errorText(error))
        }
      }),
    )
    registrations.push(
      await ctx.command.transform((editor: any) => {
        editor.add({
          name: "habits",
          description: "用户习惯画像：查看 / refresh 提炼 / forget 遗忘",
          execute: async ({ sessionID, prompt }: any) => {
            await handleCommand(ctx, sessionID, prompt?.text ?? "", maxItems)
          },
        })
      }),
    )
    return async () => {
      for (const registration of registrations) {
        try {
          await registration.dispose()
        } catch (error) {
          log("卸载失败：", errorText(error))
        }
      }
    }
  },
}
