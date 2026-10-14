// habit-profile 的 RPC 契约：server 端注册、TUI 端调用共用同一份定义。
//
// 这里刻意不 import 任何 @opencode/* 包——RPC 按 definition.id 字符串路由，
// 与定义对象的身份无关（见 packages/core/src/rpc.ts 的 register/call），
// 而本插件目录没有 node_modules，任何 @opencode/* import 都可能在非插件进程里解析失败。

export interface PendingView {
  // 提炼时就渲染好的人话描述（含目标条目原文），供弹窗直接展示。
  readonly summary: string
}

export interface PendingList {
  readonly items: PendingView[]
  // 列表内容指纹：提交时回传，供 server 核对列表未被改动。
  readonly revision: string
}

export interface ReviewDecision {
  // 1 起算，对应 list 返回的顺序。
  readonly index: number
  readonly action: "approve" | "reject"
}

export interface ReviewResult {
  readonly approved: number
  readonly rejected: number
  readonly remaining: number
  readonly errors: string[]
}

export const HABITS_RPC = {
  id: "habit-profile",
  methods: {
    // 列出当前待审批条目。
    list: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { summary: { type: "string" } },
              required: ["summary"],
              additionalProperties: false,
            },
          },
          revision: { type: "string" },
        },
        required: ["items", "revision"],
        additionalProperties: false,
      },
    },
    // 一次性提交一组审批决策；未出现在 decisions 里的条目保持不动。
    // revision 为 list 返回的指纹，不匹配则整批拒绝，避免位置编号错位。
    review: {
      input: {
        type: "object",
        properties: {
          revision: { type: "string" },
          decisions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                index: { type: "integer" },
                action: { type: "string" },
              },
              required: ["index", "action"],
              additionalProperties: false,
            },
          },
        },
        required: ["revision", "decisions"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          approved: { type: "integer" },
          rejected: { type: "integer" },
          remaining: { type: "integer" },
          errors: { type: "array", items: { type: "string" } },
        },
        required: ["approved", "rejected", "remaining", "errors"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const
