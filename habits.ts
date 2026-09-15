// 习惯画像的纯逻辑：解析 / 序列化 / op 合并 / 注入文本拼装。
// 不访问文件系统、不依赖任何外部包，供 server.ts 与 bun test 共用。
//
// 画像文件里的条目一行格式：
//   - 习惯描述 <!-- id=a1b2 conf=0.80 seen=3 last=2026-09-14 -->
// 已抑制条目：
//   - 习惯描述 <!-- id=a1b2 suppressed=2026-09-14 reason=user-forget -->

export const CATEGORIES = [
  "编码",
  "代码设计与架构",
  "UI 设计",
  "流程与工具",
  "决策准则",
  "协作方式",
] as const
export type Category = (typeof CATEGORIES)[number]

export const SCOPES = ["global", "project"] as const
export type Scope = (typeof SCOPES)[number]

export type Signal = "explicit" | "correction" | "ambient"

export interface Entry {
  id: string
  category: Category
  text: string
  confidence: number
  seen: number
  last: string
}

export interface Suppressed {
  id: string
  text: string
  reason: string
  date: string
}

export interface Portrait {
  entries: Entry[]
  suppressed: Suppressed[]
}

export const EMPTY_PORTRAIT: Portrait = { entries: [], suppressed: [] }

export type ChangeOp = "add" | "reinforce" | "amend" | "contradict" | "suppress"

export interface Change {
  op: ChangeOp
  id: string
  text: string
  note?: string
}

export type Op =
  | { op: "add"; scope: Scope; category: Category; text: string; signal: Signal }
  | { op: "reinforce"; scope: Scope; id: string; signal: Signal }
  | { op: "amend"; scope: Scope; id: string; text: string }
  | { op: "contradict"; scope: Scope; id: string }

export interface ApplyResult {
  portrait: Portrait
  changes: Change[]
}

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"
const ID_RE = /^[a-z0-9]{4}$/
const ENTRY_RE = /^- (.*?) <!-- id=([a-z0-9]{4}) (.*?) -->$/
const CONFIDENCE_FLOOR = 0.15
const CONTRADICT_DELTA = 0.2
const INITIAL_CONFIDENCE: Record<Signal, number> = { explicit: 0.8, correction: 0.2, ambient: 0.1 }
const REINFORCE_DELTA: Record<Signal, number> = { explicit: 0.2, correction: 0.2, ambient: 0.1 }
const OP_LIMIT = 30

export const MAX_TEXT_LENGTH = 160

function clamp(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100))
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase()
}

export function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH)
}

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value)
}

export function makeId(used: ReadonlySet<string>, rand: () => number = Math.random): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    let id = ""
    for (let index = 0; index < 4; index++) id += ID_CHARS[Math.floor(rand() * ID_CHARS.length)]
    if (!used.has(id)) return id
  }
  throw new Error("无法生成唯一的条目 id")
}

export function parsePortrait(md: string): Portrait {
  const entries: Entry[] = []
  const suppressed: Suppressed[] = []
  let section: string | null = null
  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith("## ")) {
      section = line.slice(3).trim()
      continue
    }
    if (line.startsWith("#")) continue
    const match = ENTRY_RE.exec(line)
    if (!match || section === null) continue
    const [, text, id, metaRaw] = match
    const meta = new Map<string, string>()
    for (const pair of metaRaw.matchAll(/([a-z]+)=([^\s]+)/g)) meta.set(pair[1], pair[2])
    if (section === "已抑制") {
      const reason = meta.get("reason") ?? "user-forget"
      suppressed.push({
        id,
        text,
        reason: /^[a-z][a-z-]*$/.test(reason) ? reason : "user-forget",
        date: meta.get("suppressed") ?? "",
      })
      continue
    }
    if (!isCategory(section)) continue
    const confidence = Number(meta.get("conf"))
    if (!Number.isFinite(confidence)) continue
    entries.push({
      id,
      category: section,
      text,
      confidence: clamp(confidence),
      seen: Math.max(1, Number.parseInt(meta.get("seen") ?? "1", 10) || 1),
      last: meta.get("last") ?? "",
    })
  }
  return { entries, suppressed }
}

export function serializePortrait(portrait: Portrait): string {
  const lines: string[] = []
  lines.push("# 用户习惯画像", "")
  lines.push(
    "<!-- 由 habit-profile 插件自动维护。手工删除的条目可能在后续提炼中重新出现；要永久遗忘请用 /habits forget <关键词>。 -->",
    "",
  )
  for (const category of CATEGORIES) {
    lines.push(`## ${category}`, "")
    for (const entry of portrait.entries) {
      if (entry.category !== category) continue
      lines.push(
        `- ${entry.text} <!-- id=${entry.id} conf=${entry.confidence.toFixed(2)} seen=${entry.seen} last=${entry.last} -->`,
        "",
      )
    }
  }
  lines.push("## 已抑制", "")
  for (const item of portrait.suppressed) {
    lines.push(`- ${item.text} <!-- id=${item.id} suppressed=${item.date} reason=${item.reason} -->`, "")
  }
  return lines.join("\n")
}

export function applyOps(
  portrait: Portrait,
  ops: readonly Op[],
  today: string,
  newId: (used: ReadonlySet<string>) => string = (used) => makeId(used),
): ApplyResult {
  const entries = portrait.entries.map((entry) => ({ ...entry }))
  const suppressed = portrait.suppressed.map((item) => ({ ...item }))
  const changes: Change[] = []
  const usedIds = () => new Set([...entries.map((entry) => entry.id), ...suppressed.map((item) => item.id)])
  const findEntry = (id: string) => entries.find((entry) => entry.id === id)
  for (const op of ops) {
    if (op.op === "add") {
      const text = cleanText(op.text)
      if (!text) continue
      if (suppressed.some((item) => normalize(item.text) === normalize(text))) continue
      const duplicate = entries.find((entry) => normalize(entry.text) === normalize(text))
      if (duplicate) {
        duplicate.confidence = clamp(duplicate.confidence + REINFORCE_DELTA[op.signal])
        duplicate.seen += 1
        duplicate.last = today
        changes.push({ op: "reinforce", id: duplicate.id, text: duplicate.text, note: "与已有条目重复，转为强化" })
        continue
      }
      const entry: Entry = {
        id: newId(usedIds()),
        category: op.category,
        text,
        confidence: INITIAL_CONFIDENCE[op.signal],
        seen: 1,
        last: today,
      }
      entries.push(entry)
      changes.push({ op: "add", id: entry.id, text: entry.text })
      continue
    }
    if (op.op === "reinforce") {
      const entry = findEntry(op.id)
      if (!entry) continue
      entry.confidence = clamp(entry.confidence + REINFORCE_DELTA[op.signal])
      entry.seen += 1
      entry.last = today
      changes.push({ op: "reinforce", id: entry.id, text: entry.text })
      continue
    }
    if (op.op === "amend") {
      const entry = findEntry(op.id)
      const text = cleanText(op.text)
      if (!entry || !text) continue
      entry.text = text
      entry.last = today
      changes.push({ op: "amend", id: entry.id, text })
      continue
    }
    if (op.op === "contradict") {
      const index = entries.findIndex((entry) => entry.id === op.id)
      if (index < 0) continue
      const entry = entries[index]
      entry.last = today
      if (entry.confidence - CONTRADICT_DELTA < CONFIDENCE_FLOOR) {
        entries.splice(index, 1)
        suppressed.push({ id: entry.id, text: entry.text, reason: "contradicted", date: today })
        changes.push({ op: "suppress", id: entry.id, text: entry.text, note: "证据不足，转入已抑制" })
      } else {
        entry.confidence = clamp(entry.confidence - CONTRADICT_DELTA)
        changes.push({ op: "contradict", id: entry.id, text: entry.text })
      }
    }
  }
  return { portrait: { entries, suppressed }, changes }
}

export interface SuppressResult {
  portrait: Portrait
  removed: Entry[]
}

export function suppressMatches(portrait: Portrait, keywords: readonly string[], today: string): SuppressResult {
  const keys = keywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean)
  if (!keys.length) return { portrait, removed: [] }
  const removed = portrait.entries.filter((entry) =>
    keys.some((key) => entry.id === key || normalize(entry.text).includes(key)),
  )
  if (!removed.length) return { portrait, removed: [] }
  const removedIds = new Set(removed.map((entry) => entry.id))
  return {
    portrait: {
      entries: portrait.entries.filter((entry) => !removedIds.has(entry.id)),
      suppressed: [
        ...portrait.suppressed,
        ...removed.map((entry) => ({ id: entry.id, text: entry.text, reason: "user-forget", date: today })),
      ],
    },
    removed,
  }
}

export interface OpsParseResult {
  ops: Op[]
  errors: string[]
}

function parseOp(item: unknown, errors: string[]): Op | undefined {
  if (typeof item !== "object" || item === null) {
    errors.push("ops 里有非对象元素")
    return undefined
  }
  const record = item as Record<string, unknown>
  const kind = record.op
  const scope = record.scope
  const id = typeof record.id === "string" ? record.id.toLowerCase() : undefined
  const signal: Signal =
    record.signal === "explicit" || record.signal === "correction" ? record.signal : "ambient"
  if (scope !== "global" && scope !== "project") {
    errors.push(`op ${String(kind)} 缺 scope，已忽略`)
    return undefined
  }
  if (kind === "add") {
    if (!isCategory(record.category)) {
      errors.push("add 的 category 不在既定 6 类里，已忽略")
      return undefined
    }
    const text = typeof record.text === "string" ? record.text : ""
    if (!text.trim()) {
      errors.push("add 缺 text，已忽略")
      return undefined
    }
    return { op: "add", scope, category: record.category, text, signal }
  }
  if (!id || !ID_RE.test(id)) {
    errors.push(`op ${String(kind)} 的 id 非法，已忽略`)
    return undefined
  }
  if (kind === "reinforce") return { op: "reinforce", scope, id, signal }
  if (kind === "amend") {
    const text = typeof record.text === "string" ? record.text : ""
    if (!text.trim()) {
      errors.push("amend 缺 text，已忽略")
      return undefined
    }
    return { op: "amend", scope, id, text }
  }
  if (kind === "contradict") return { op: "contradict", scope, id }
  errors.push(`未知 op ${String(kind)}，已忽略`)
  return undefined
}

export function parseOpsJson(raw: string): OpsParseResult {
  const errors: string[] = []
  let text = raw.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced?.[1]) text = fenced[1].trim()
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return { ops: [], errors: ["模型输出里找不到 JSON 对象"] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch (error) {
    return { ops: [], errors: [`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`] }
  }
  const rawOps = (parsed as { ops?: unknown })?.ops
  if (!Array.isArray(rawOps)) return { ops: [], errors: ["JSON 里缺少 ops 数组"] }
  if (rawOps.length > OP_LIMIT) errors.push(`ops 数量 ${rawOps.length} 超过上限 ${OP_LIMIT}，已截断`)
  const ops: Op[] = []
  for (const item of rawOps.slice(0, OP_LIMIT)) {
    const op = parseOp(item, errors)
    if (op) ops.push(op)
  }
  return { ops, errors }
}

export function buildInjection(globalPortrait: Portrait, projectPortrait: Portrait, maxItems: number): string {
  const limit = Math.max(0, Math.floor(maxItems))
  const section = (title: string, portrait: Portrait): string | undefined => {
    const items = [...portrait.entries].sort((a, b) => b.confidence - a.confidence).slice(0, limit)
    if (!items.length) return undefined
    return [`### ${title}`, ...items.map((entry) => `- ${entry.category}：${entry.text}`)].join("\n")
  }
  const blocks = [section("全局习惯", globalPortrait), section("当前项目习惯", projectPortrait)].filter(
    (block): block is string => Boolean(block),
  )
  if (!blocks.length) return ""
  const header =
    "以下是从历史会话中提炼的用户习惯画像（由 habit-profile 插件维护）。它们只是默认偏好参考，不是硬性规则；与用户当前的明确指示冲突时，以当前指示为准。"
  return `${header}\n\n${blocks.join("\n\n")}`
}

export function describePortrait(portrait: Portrait): string {
  if (!portrait.entries.length) return "（空）"
  return portrait.entries
    .map(
      (entry) =>
        `- [${entry.id}] ${entry.category}：${entry.text}（conf ${entry.confidence.toFixed(2)} · seen ${entry.seen} · last ${entry.last}）`,
    )
    .join("\n")
}

export function describeSuppressed(portrait: Portrait): string {
  if (!portrait.suppressed.length) return "（空）"
  return portrait.suppressed.map((item) => `- ${item.text}（${item.reason} · ${item.date}）`).join("\n")
}
