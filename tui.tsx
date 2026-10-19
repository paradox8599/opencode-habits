/** @jsxImportSource ./jsx */
// habit-profile 的 TUI 入口：一屏面板，逐条处理待审批条目。
//
// 打开方式：手动执行斜杠命令 /habits-panel（不自动弹出）。
// 交互：↑/↓ 或 k/j 移动，a 采纳、r 丢弃、空格 循环切换，Enter 一次性提交，Esc 关闭。
// 只提交被明确标记的条目，未操作的条目保持不动、继续留在待审批里。

import { createSignal, For, onMount, Show } from "solid-js"
import { HABITS_RPC, type PendingList, type ReviewDecision, type ReviewResult } from "./rpc.ts"

const PANEL_NAME = "habit-profile.review"

type Mark = "approve" | "reject"

// 从主题里取色，字段缺失时退回默认值。
function colors(theme: any) {
  const text = theme?.text ?? {}
  const feedback = text.feedback ?? {}
  const pick = (...candidates: Array<string | undefined>): string | undefined =>
    candidates.find((value): value is string => typeof value === "string")
  return {
    base: pick(text.base, text.default),
    muted: pick(text.muted, text.subdued),
    success: pick(feedback.success?.base, feedback.success?.default, text.base),
    error: pick(feedback.error?.base, feedback.error?.default, text.base),
    warning: pick(feedback.warning?.base, feedback.warning?.default, text.muted),
    accent: pick(theme?.hue?.interactive?.[300], text.base),
  }
}

function Panel(props: { context: any; panel: any }) {
  const c = colors(props.context.theme)
  const api = props.context.client.rpc(HABITS_RPC)
  const [items, setItems] = createSignal<PendingList["items"] | undefined>(undefined)
  const [revision, setRevision] = createSignal("")
  const [failed, setFailed] = createSignal(false)
  const [marks, setMarks] = createSignal<Record<number, Mark>>({})
  const [cursor, setCursor] = createSignal(0)
  const [busy, setBusy] = createSignal(false)

  const load = async () => {
    try {
      const result = (await api.list({})) as PendingList
      setItems(result.items)
      setRevision(result.revision)
      setFailed(false)
      setMarks({})
      setCursor(0)
    } catch (error) {
      setItems(undefined)
      setFailed(true)
      props.context.ui.toast.show({
        title: "习惯画像",
        message: `读取待审批失败：${String(error)}`,
        variant: "error",
      })
    }
  }

  onMount(() => {
    void load()
  })

  const move = (delta: number) => {
    const total = items()?.length ?? 0
    if (total <= 0) return
    setCursor((value) => Math.min(Math.max(value + delta, 0), total - 1))
  }

  const setMark = (index: number, mark: Mark) => {
    setMarks((current) => {
      const next = { ...current }
      if (next[index] === mark) delete next[index]
      else next[index] = mark
      return next
    })
  }

  const cycle = (index: number) => {
    const current = marks()[index]
    if (current === undefined) setMark(index, "approve")
    else if (current === "approve") setMark(index, "reject")
    else setMark(index, "approve")
  }

  const submit = async () => {
    if (busy()) return
    const list = items() ?? []
    const current = marks()
    const decisions: ReviewDecision[] = Object.entries(current)
      .map(([key, action]) => ({ index: Number(key) + 1, action }))
      .filter((decision) => decision.index >= 1 && decision.index <= list.length)
    if (!decisions.length) {
      props.context.ui.toast.show({ title: "习惯画像", message: "没有标记任何条目。", variant: "warning" })
      return
    }
    setBusy(true)
    try {
      const result = (await api.review({ revision: revision(), decisions })) as ReviewResult
      const errors = result.errors.length ? `（${result.errors.join("；")}）` : ""
      props.context.ui.toast.show({
        title: "习惯画像",
        message: `已采纳 ${result.approved} 条、丢弃 ${result.rejected} 条，剩余待审批 ${result.remaining} 条${errors}`,
        variant: result.errors.length ? "warning" : "success",
      })
      await load()
      if (!failed() && (items()?.length ?? 0) === 0) props.panel.close()
    } catch (error) {
      props.context.ui.toast.show({
        title: "习惯画像",
        message: `提交失败：${String(error)}`,
        variant: "error",
      })
    } finally {
      setBusy(false)
    }
  }

  // 面板拥有输入时这些键才生效。
  props.context.keymap.layer(() => ({
    commands: [
      { id: "habit-profile.panel.up", bind: "up", run: () => move(-1) },
      { id: "habit-profile.panel.down", bind: "down", run: () => move(1) },
      { id: "habit-profile.panel.k", bind: "k", run: () => move(-1) },
      { id: "habit-profile.panel.j", bind: "j", run: () => move(1) },
      { id: "habit-profile.panel.approve", bind: "a", run: () => setMark(cursor(), "approve") },
      { id: "habit-profile.panel.reject", bind: "r", run: () => setMark(cursor(), "reject") },
      { id: "habit-profile.panel.cycle", bind: "space", run: () => cycle(cursor()) },
      { id: "habit-profile.panel.submit", bind: "return", run: () => void submit() },
      { id: "habit-profile.panel.close", bind: "escape", run: () => props.panel.close() },
    ],
  }))

  const markTag = (index: number) => {
    const mark = marks()[index]
    if (mark === "approve") return { label: "采纳", color: c.success }
    if (mark === "reject") return { label: "丢弃", color: c.error }
    return { label: "不动", color: c.muted }
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexDirection="row" justifyContent="space-between" paddingBottom={1}>
        <text fg={c.accent}>
          <b>待审批习惯</b>
        </text>
        <Show
          when={busy()}
          fallback={<text fg={c.muted}>{"↑/↓ 移动 · a 采纳 · r 丢弃 · 空格 切换 · Enter 提交 · Esc 关闭"}</text>}
        >
          <text fg={c.muted}>提交中…</text>
        </Show>
      </box>
      <Show
        when={items()}
        fallback={<text fg={c.muted}>{failed() ? "读取待审批失败。" : "读取中…"}</text>}
      >
        <Show
          when={(items()?.length ?? 0) > 0}
          fallback={<text fg={c.muted}>没有待审批条目。</text>}
        >
          <For each={items()}>
            {(item, index) => {
              const tag = () => markTag(index())
              const isCursor = () => cursor() === index()
              return (
                <box flexDirection="row" paddingLeft={1}>
                  <text fg={isCursor() ? c.accent : c.muted}>{isCursor() ? "❯ " : "  "}</text>
                  <text fg={tag().color}>{`[${tag().label}] `}</text>
                  <text fg={isCursor() ? c.base : c.muted}>{item.summary}</text>
                </box>
              )
            }}
          </For>
        </Show>
      </Show>
    </box>
  )
}

// 全局命令层：提供手动打开面板的斜杠命令（挂在常驻的 app 槽上）。
function Commands(props: { context: any }) {
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "habit-profile.panel.open",
        title: "习惯画像：审批待处理条目",
        description: "打开一屏面板，逐条采纳 / 丢弃待审批的习惯条目",
        group: "习惯画像",
        bind: false,
        palette: true,
        slash: { name: "habits-panel" },
        run: () => {
          const opened = props.context.ui.panel.open(PANEL_NAME)
          if (opened === false) {
            props.context.ui.toast.show({
              title: "习惯画像",
              message: "请先在某个会话中打开面板。",
              variant: "warning",
            })
          }
        },
      },
    ],
  }))
  return null
}

export default {
  id: "habit-profile.tui",
  setup(context: any) {
    const disposers: Array<() => void> = []
    disposers.push(
      context.ui.slot({
        append: "session.panel",
        render: (panel: any) => (
          <Show when={panel.name === PANEL_NAME}>
            <Panel context={context} panel={panel} />
          </Show>
        ),
      }),
    )
    disposers.push(
      context.ui.slot({
        append: "app",
        render: () => <Commands context={context} />,
      }),
    )
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 清理失败不影响其它注销
        }
      }
    }
  },
}
