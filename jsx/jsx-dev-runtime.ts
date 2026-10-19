// tui.tsx 的 JSX 运行时转发层（见 AGENTS.md「tui.tsx 的 JSX pragma」）。
// Bun 按 pragma 注入的 jsx 导入必须是「源码里写死的 import」，opencode 才会把它改写到宿主的
// 运行时模块；直接写 @jsxImportSource @opentui/solid 时注入的那句改写不到，插件装进
// node_modules 后就找不到 @opentui/solid。
export { jsxDEV, Fragment } from "@opentui/solid/jsx-dev-runtime"
