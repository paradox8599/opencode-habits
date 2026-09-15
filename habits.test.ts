import { describe, expect, test } from "bun:test"
import {
  applyOps,
  buildInjection,
  cleanText,
  describePortrait,
  describeSuppressed,
  isOutputMessage,
  lintPortrait,
  makeId,
  OUTPUT_METADATA,
  parseModelRef,
  parseOpsJson,
  parsePortrait,
  serializePortrait,
  suppressMatches,
  type Entry,
  type Op,
  type Portrait,
} from "./habits.ts"

function entry(partial: Partial<Entry> & { id: string; text: string }): Entry {
  return {
    category: "编码",
    confidence: 0.5,
    seen: 1,
    last: "2026-09-01",
    ...partial,
  }
}

function portrait(entries: Entry[], suppressed: Portrait["suppressed"] = []): Portrait {
  return { entries, suppressed }
}

function counterNewId(): (used: ReadonlySet<string>) => string {
  let counter = 0
  return (used) => {
    let id = ""
    do {
      id = `t${String(counter++).padStart(3, "0")}`
    } while (used.has(id))
    return id
  }
}

describe("parseModelRef", () => {
  test("字符串形式 provider/model", () => {
    expect(parseModelRef("o/deepseek-v4.1-flash")).toEqual({ providerID: "o", id: "deepseek-v4.1-flash" })
    expect(parseModelRef("  o/glm-5.3-flash  ")).toEqual({ providerID: "o", id: "glm-5.3-flash" })
    expect(parseModelRef("openrouter/anthropic/claude-sonnet-5")).toEqual({
      providerID: "openrouter",
      id: "anthropic/claude-sonnet-5",
    })
  })

  test("字符串带变体", () => {
    expect(parseModelRef("o/glm-5.3#think")).toEqual({ providerID: "o", id: "glm-5.3", variant: "think" })
    expect(parseModelRef("o/glm-5.3#")).toEqual({ providerID: "o", id: "glm-5.3" })
  })

  test("对象形式", () => {
    expect(parseModelRef({ providerID: "o", id: "glm-5.3" })).toEqual({ providerID: "o", id: "glm-5.3" })
    expect(parseModelRef({ providerID: "o", id: "glm-5.3", variant: "think" })).toEqual({
      providerID: "o",
      id: "glm-5.3",
      variant: "think",
    })
  })

  test("非法输入返回 undefined", () => {
    const invalid: unknown[] = [
      "",
      "   ",
      "noslash",
      "/x",
      "x/",
      "#variant",
      "x/#v",
      42,
      null,
      undefined,
      {},
      { providerID: "o" },
      { id: "x" },
      { providerID: "", id: "x" },
    ]
    for (const value of invalid) expect(parseModelRef(value)).toBeUndefined()
  })
})

describe("parsePortrait / serializePortrait", () => {
  test("空文件解析为空画像", () => {
    expect(parsePortrait("")).toEqual({ entries: [], suppressed: [] })
    expect(parsePortrait("\n\n# 用户习惯画像\n")).toEqual({ entries: [], suppressed: [] })
  })

  test("忽略未知格式的行与未知分节", () => {
    const md = [
      "# 随便写的",
      "一些说明文字",
      "## 未知分类",
      "- 不该出现的条目 <!-- id=zzzz conf=0.50 seen=1 last=2026-09-01 -->",
      "- 没有元数据的手写条目",
    ].join("\n")
    expect(parsePortrait(md)).toEqual({ entries: [], suppressed: [] })
  })

  test("解析条目与已抑制条目", () => {
    const md = [
      "## 编码",
      "- 偏好类型收窄 <!-- id=a1b2 conf=0.80 seen=3 last=2026-09-14 -->",
      "## 已抑制",
      "- 使用 X 库 <!-- id=c3d4 suppressed=2026-09-13 reason=user-forget -->",
    ].join("\n")
    expect(parsePortrait(md)).toEqual({
      entries: [entry({ id: "a1b2", text: "偏好类型收窄", confidence: 0.8, seen: 3, last: "2026-09-14" })],
      suppressed: [{ id: "c3d4", text: "使用 X 库", reason: "user-forget", date: "2026-09-13" }],
    })
  })

  test("序列化后解析可还原", () => {
    const source = portrait(
      [
        entry({ id: "a1b2", text: "偏好类型收窄", category: "编码", confidence: 0.8, seen: 3, last: "2026-09-14" }),
        entry({ id: "d4e5", text: "偏好暗色主题", category: "UI 设计", confidence: 1 }),
        entry({ id: "b2c3", text: "先方案后动手", category: "协作方式", confidence: 0.2 }),
      ],
      [{ id: "c3d4", text: "使用 X 库", reason: "contradicted", date: "2026-09-13" }],
    )
    expect(parsePortrait(serializePortrait(source))).toEqual(source)
  })

  test("序列化格式包含可解析的内联元数据", () => {
    const md = serializePortrait(portrait([entry({ id: "a1b2", text: "偏好类型收窄", confidence: 0.8 })]))
    expect(md).toContain("- 偏好类型收窄 <!-- id=a1b2 conf=0.80 seen=1 last=2026-09-01 -->")
    expect(md).toContain("## 已抑制")
  })
})

describe("makeId / cleanText", () => {
  test("makeId 避开已用 id", () => {
    let index = 0
    const values = [0, 0, 0, 0.03, 0.1, 0.1, 0.1, 0.1]
    const rand = () => values[index++]
    const first = makeId(new Set(), rand)
    const second = makeId(new Set([first]), rand)
    expect(first).not.toBe(second)
    expect(first).toMatch(/^[a-z0-9]{4}$/)
  })

  test("cleanText 压缩空白并截断", () => {
    expect(cleanText("  偏好  类型\n收窄  ")).toBe("偏好 类型 收窄")
    expect(cleanText("x".repeat(500)).length).toBe(160)
  })
})

describe("applyOps", () => {
  test("add 按信号给初始置信度", () => {
    const ops: Op[] = [
      { op: "add", scope: "global", category: "编码", text: "偏好显式类型", signal: "explicit" },
      { op: "add", scope: "global", category: "流程与工具", text: "先跑测试再提交", signal: "correction" },
      { op: "add", scope: "project", category: "协作方式", text: "中文交流", signal: "ambient" },
    ]
    const result = applyOps(portrait([]), ops, "2026-09-14", counterNewId())
    expect(result.portrait.entries.map((item) => [item.text, item.confidence, item.seen, item.last])).toEqual([
      ["偏好显式类型", 0.8, 1, "2026-09-14"],
      ["先跑测试再提交", 0.2, 1, "2026-09-14"],
      ["中文交流", 0.1, 1, "2026-09-14"],
    ])
    expect(result.changes).toHaveLength(3)
    expect(result.changes.every((change) => change.op === "add")).toBe(true)
  })

  test("add 与已有条目重复时转为强化", () => {
    const source = portrait([entry({ id: "a1b2", text: "偏好显式类型", category: "编码", confidence: 0.5, seen: 2 })])
    const result = applyOps(
      source,
      [{ op: "add", scope: "global", category: "编码", text: "  偏好显式类型  ", signal: "correction" }],
      "2026-09-14",
      counterNewId(),
    )
    expect(result.portrait.entries).toHaveLength(1)
    expect(result.portrait.entries[0].confidence).toBe(0.7)
    expect(result.portrait.entries[0].seen).toBe(3)
    expect(result.changes[0].op).toBe("reinforce")
  })

  test("add 不会重新登记已抑制内容", () => {
    const source = portrait([], [{ id: "a1b2", text: "使用 X 库", reason: "user-forget", date: "2026-09-01" }])
    const result = applyOps(
      source,
      [{ op: "add", scope: "global", category: "编码", text: "使用 X 库", signal: "explicit" }],
      "2026-09-14",
      counterNewId(),
    )
    expect(result.portrait.entries).toHaveLength(0)
    expect(result.changes).toHaveLength(0)
  })

  test("reinforce 增加 seen 与置信度并封顶 1", () => {
    const source = portrait([entry({ id: "a1b2", text: "偏好显式类型", confidence: 0.9, seen: 4 })])
    const result = applyOps(
      source,
      [{ op: "reinforce", scope: "global", id: "a1b2", signal: "explicit" }],
      "2026-09-14",
      counterNewId(),
    )
    expect(result.portrait.entries[0].confidence).toBe(1)
    expect(result.portrait.entries[0].seen).toBe(5)
    expect(result.portrait.entries[0].last).toBe("2026-09-14")
  })

  test("amend 只改文本，不改置信度", () => {
    const source = portrait([entry({ id: "a1b2", text: "偏好显式类型", confidence: 0.5 })])
    const result = applyOps(
      source,
      [{ op: "amend", scope: "global", id: "a1b2", text: "偏好显式类型与运行时校验" }],
      "2026-09-14",
      counterNewId(),
    )
    expect(result.portrait.entries[0].text).toBe("偏好显式类型与运行时校验")
    expect(result.portrait.entries[0].confidence).toBe(0.5)
  })

  test("contradict 高于阈值时只降权", () => {
    const source = portrait([entry({ id: "a1b2", text: "偏好显式类型", confidence: 0.5 })])
    const result = applyOps(
      source,
      [{ op: "contradict", scope: "global", id: "a1b2" }],
      "2026-09-14",
      counterNewId(),
    )
    expect(result.portrait.entries[0].confidence).toBe(0.3)
    expect(result.portrait.suppressed).toHaveLength(0)
    expect(result.changes[0].op).toBe("contradict")
  })

  test("contradict 低于阈值时转入已抑制", () => {
    const source = portrait([entry({ id: "a1b2", text: "偏好显式类型", confidence: 0.2 })])
    const result = applyOps(
      source,
      [{ op: "contradict", scope: "global", id: "a1b2" }],
      "2026-09-14",
      counterNewId(),
    )
    expect(result.portrait.entries).toHaveLength(0)
    expect(result.portrait.suppressed).toEqual([
      { id: "a1b2", text: "偏好显式类型", reason: "contradicted", date: "2026-09-14" },
    ])
    expect(result.changes[0].op).toBe("suppress")
  })

  test("未知 id 的 op 被忽略", () => {
    const source = portrait([entry({ id: "a1b2", text: "偏好显式类型" })])
    const result = applyOps(
      source,
      [
        { op: "reinforce", scope: "global", id: "ffff", signal: "ambient" },
        { op: "amend", scope: "global", id: "ffff", text: "不存在" },
        { op: "contradict", scope: "global", id: "ffff" },
      ],
      "2026-09-14",
      counterNewId(),
    )
    expect(result.portrait).toEqual(source)
    expect(result.changes).toHaveLength(0)
  })
})

describe("suppressMatches", () => {
  test("按 id 与关键词匹配并移入已抑制", () => {
    const source = portrait([
      entry({ id: "a1b2", text: "偏好显式类型" }),
      entry({ id: "b2c3", text: "使用 X 库做状态管理" }),
      entry({ id: "c3d4", text: "提交信息用英文" }),
    ])
    const byId = suppressMatches(source, ["a1b2"], "2026-09-14")
    expect(byId.removed.map((item) => item.id)).toEqual(["a1b2"])
    const byKeyword = suppressMatches(source, ["x 库"], "2026-09-14")
    expect(byKeyword.removed.map((item) => item.id)).toEqual(["b2c3"])
    expect(byKeyword.portrait.suppressed[0].reason).toBe("user-forget")
  })

  test("无匹配时原样返回", () => {
    const source = portrait([entry({ id: "a1b2", text: "偏好显式类型" })])
    const result = suppressMatches(source, ["不存在"], "2026-09-14")
    expect(result.removed).toHaveLength(0)
    expect(result.portrait).toEqual(source)
  })
})

describe("parseOpsJson", () => {
  test("解析纯 JSON 与代码块包裹的 JSON", () => {
    const raw = '```json\n{"ops":[{"op":"reinforce","scope":"global","id":"a1b2","signal":"correction"}]}\n```'
    expect(parseOpsJson(raw)).toEqual({
      ops: [{ op: "reinforce", scope: "global", id: "a1b2", signal: "correction" }],
      errors: [],
    })
    expect(parseOpsJson('{"ops":[{"op":"contradict","scope":"project","id":"c3d4"}]}').ops).toEqual([
      { op: "contradict", scope: "project", id: "c3d4" },
    ])
  })

  test("丢弃非法 op 并记录原因", () => {
    const raw = JSON.stringify({
      ops: [
        { op: "add", scope: "global", category: "不存在的分类", text: "x", signal: "explicit" },
        { op: "add", scope: "global", category: "编码", text: " ", signal: "explicit" },
        { op: "reinforce", id: "a1b2", signal: "ambient" },
        { op: "reinforce", scope: "global", id: "!!!", signal: "ambient" },
        { op: "explode", scope: "global", id: "a1b2" },
      ],
    })
    const result = parseOpsJson(raw)
    expect(result.ops).toHaveLength(0)
    expect(result.errors.length).toBe(5)
  })

  test("signal 缺省为 ambient", () => {
    const result = parseOpsJson('{"ops":[{"op":"reinforce","scope":"global","id":"a1b2"}]}')
    expect(result.ops[0]).toEqual({ op: "reinforce", scope: "global", id: "a1b2", signal: "ambient" })
  })

  test("找不到 JSON 时返回错误", () => {
    expect(parseOpsJson("我无法提炼").errors).toEqual(["模型输出里找不到 JSON 对象"])
    expect(parseOpsJson("{不是 json}").errors[0]).toStartWith("JSON 解析失败")
  })
})

describe("buildInjection", () => {
  test("按置信度排序并截断，全局与项目各成一段", () => {
    const global = portrait([
      entry({ id: "a1b2", text: "低优先", confidence: 0.2 }),
      entry({ id: "b2c3", text: "高优先", confidence: 0.9 }),
      entry({ id: "c3d4", text: "中优先", confidence: 0.5 }),
    ])
    const project = portrait([entry({ id: "d4e5", text: "项目习惯", category: "协作方式", confidence: 0.7 })])
    const text = buildInjection(global, project, 2)
    expect(text).toContain("高优先")
    expect(text).toContain("中优先")
    expect(text).not.toContain("低优先")
    expect(text).toContain("### 全局习惯")
    expect(text).toContain("### 当前项目习惯")
    expect(text.indexOf("高优先")).toBeLessThan(text.indexOf("中优先"))
  })

  test("两份画像都为空时返回空串", () => {
    expect(buildInjection(portrait([]), portrait([]), 40)).toBe("")
  })

  test("已抑制的条目不参与注入", () => {
    const global = portrait([], [{ id: "a1b2", text: "被遗忘的习惯", reason: "user-forget", date: "2026-09-01" }])
    expect(buildInjection(global, portrait([]), 40)).toBe("")
  })
})

describe("describePortrait / describeSuppressed", () => {
  test("空画像显示占位", () => {
    expect(describePortrait(portrait([]))).toBe("（空）")
    expect(describeSuppressed(portrait([]))).toBe("（空）")
  })

  test("逐条输出 id 与元数据", () => {
    const text = describePortrait(
      portrait([entry({ id: "a1b2", text: "偏好显式类型", category: "编码", confidence: 0.8, seen: 3, last: "2026-09-14" })]),
    )
    expect(text).toBe("- [a1b2] 编码：偏好显式类型（conf 0.80 · seen 3 · last 2026-09-14）")
  })
})

describe("lintPortrait", () => {
  const valid = () =>
    serializePortrait(
      portrait(
        [entry({ id: "a1b2", text: "偏好显式类型", category: "编码", confidence: 0.8, seen: 3, last: "2026-09-14" })],
        [{ id: "c3d4", text: "使用 X 库", reason: "user-forget", date: "2026-09-13" }],
      ),
    )

  test("干净画像无问题", () => {
    expect(lintPortrait(valid())).toEqual([])
    expect(lintPortrait(serializePortrait(portrait([])))).toEqual([])
  })

  test("条目缺少元数据注释报错误", () => {
    const md = ["## 编码", "- 手写但没有元数据的条目"].join("\n")
    const issues = lintPortrait(md)
    expect(issues.some((issue) => issue.level === "error" && issue.message.includes("缺少合法元数据注释"))).toBe(true)
  })

  test("非法置信度报错误，非法 seen/last 报警告", () => {
    const broken = ["## 编码", "- 某个习惯 <!-- id=a1b2 conf=9 seen=abc last=昨天 -->"].join("\n")
    const issues = lintPortrait(broken)
    expect(issues.some((issue) => issue.level === "error" && issue.message.includes("置信度非法"))).toBe(true)
    expect(issues.some((issue) => issue.level === "warn" && issue.message.includes("seen 非法"))).toBe(true)
    expect(issues.some((issue) => issue.level === "warn" && issue.message.includes("last 日期非法"))).toBe(true)
  })

  test("重复 id 报错误，重复描述报警告", () => {
    const md = [
      "## 编码",
      "- 习惯一 <!-- id=a1b2 conf=0.50 seen=1 last=2026-09-14 -->",
      "- 习惯二 <!-- id=a1b2 conf=0.50 seen=1 last=2026-09-14 -->",
      "- 习惯一 <!-- id=d4e5 conf=0.50 seen=1 last=2026-09-14 -->",
    ].join("\n")
    const issues = lintPortrait(md)
    expect(issues.some((issue) => issue.level === "error" && issue.message.includes("重复的条目 id"))).toBe(true)
    expect(issues.some((issue) => issue.level === "warn" && issue.message.includes("重复的描述"))).toBe(true)
  })

  test("未知分节与缺失分节报警告", () => {
    const md = ["## 编码", "- 习惯 <!-- id=a1b2 conf=0.50 seen=1 last=2026-09-14 -->", "## 编程"].join("\n")
    const issues = lintPortrait(md)
    expect(issues.some((issue) => issue.message.includes("未知分节：编程"))).toBe(true)
    expect(issues.some((issue) => issue.message.includes("缺少分节：## 已抑制"))).toBe(true)
    expect(issues.some((issue) => issue.message.includes("缺少分节：## UI 设计"))).toBe(true)
  })

  test("无法识别的行报警告，多行注释不误报", () => {
    const md = ["<!-- 多行", "注释 -->", "一些手写说明", "## 编码"].join("\n")
    const issues = lintPortrait(md)
    expect(issues.some((issue) => issue.message.includes("无法识别的行（写盘时会被丢弃）：一些手写说明"))).toBe(true)
    expect(issues.some((issue) => issue.message.includes("多行"))).toBe(false)
  })

  test("同一描述同时存在于条目与已抑制报警告", () => {
    const md = [
      "## 编码",
      "- 使用 X 库 <!-- id=a1b2 conf=0.50 seen=1 last=2026-09-14 -->",
      "## 已抑制",
      "- 使用 X 库 <!-- id=c3d4 suppressed=2026-09-13 reason=user-forget -->",
      "- 日期残缺 <!-- id=e5f6 suppressed=昨天 reason=user-forget -->",
    ].join("\n")
    const issues = lintPortrait(md)
    expect(issues.some((issue) => issue.message.includes("同时存在于条目与已抑制"))).toBe(true)
    expect(issues.some((issue) => issue.message.includes("已抑制条目缺少合法日期"))).toBe(true)
  })
})

describe("isOutputMessage", () => {
  test("识别 /habits 输出消息的 metadata 标记", () => {
    expect(isOutputMessage({ metadata: OUTPUT_METADATA })).toBe(true)
  })

  test("没有标记或标记不匹配时返回 false", () => {
    expect(isOutputMessage({})).toBe(false)
    expect(isOutputMessage({ metadata: { habitProfile: { kind: "别的值" } } })).toBe(false)
    expect(isOutputMessage({ metadata: { 其他插件: { kind: "output" } } })).toBe(false)
  })
})
