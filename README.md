# Obelisk For Codex

<div align="center">

[![stars](https://img.shields.io/github/stars/xiwanzi/Obelisk-For-Codex?style=flat-square)](https://github.com/xiwanzi/Obelisk-For-Codex/stargazers)
[![version](https://img.shields.io/github/v/tag/xiwanzi/Obelisk-For-Codex?label=version&style=flat-square)](https://github.com/xiwanzi/Obelisk-For-Codex/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)

Every past Codex session, tool call, summary, spawned agent, and workflow-like run -- queryable by your agent.

每一段 Codex 历史、工具调用、摘要、子 agent 和 workflow-like run，都可以由 agent 结构化查询。

**Humans should not browse session history. Agents should query it.**

**人不应该翻聊天记录；agent 应该直接查询历史。**

</div>

## Not a Session Browser / 不是会话浏览器

Most history tools help humans find old chats.

多数历史工具让人去翻旧对话。

Obelisk For Codex is built for agents. It indexes Codex Desktop / Codex CLI session logs under `~/.codex`, exposes them through SQLite + FTS5, and gives the agent a small JavaScript query API. You ask in plain language; the agent writes the query, runs it locally, and answers with structured evidence.

Obelisk For Codex 是给 agent 用的。它索引 `~/.codex` 下的 Codex Desktop / Codex CLI 会话日志，用 SQLite + FTS5 暴露结构化数据，并提供一个小型 JavaScript 查询 API。你用自然语言提问，agent 编写查询，在本地运行，然后带着证据回答。

## Why Obelisk For Codex / 为什么需要它

| Session library | Obelisk For Codex |
|---|---|
| Find an old chat | Answer a question about past Codex work |
| Human browses snippets | Agent writes and runs a query |
| Search result list | Structured context and reasoning |
| Sessions as documents | Sessions as queryable memory |
| Good for recall | Good for investigation |

| 会话库 | Obelisk For Codex |
|---|---|
| 找旧聊天 | 回答过去 Codex 工作中的具体问题 |
| 人浏览片段 | agent 编写并运行查询 |
| 搜索结果列表 | 结构化上下文与推理 |
| 会话像文档 | 会话是可查询记忆 |
| 适合回忆 | 适合调查 |

## What You Can Ask / 可以问什么

```text
/obelisk-codex 上次 auth bug 最后到底改了哪些文件，为什么这么改
/obelisk-codex 这个文件最近在哪些 sessions 里被反复修改
/obelisk-codex 找出最近失败的 tool calls，它们分别发生在哪些任务里
/obelisk-codex 那个 review workflow 的 subagents 各自结论是什么
/obelisk-codex 我之前有没有试过这个方案，结果为什么放弃了
```

```text
/obelisk-codex What did we change last time for the auth bug, and why?
/obelisk-codex Which sessions repeatedly edited this file?
/obelisk-codex Find recent failed tool calls and the tasks they happened in.
/obelisk-codex What did each subagent conclude in that review workflow?
/obelisk-codex Did I try this approach before, and why was it abandoned?
```

Anything Codex has done before can become structured, queryable memory: sessions, messages, tool calls, tool outputs, failures, summaries, file history, spawned agents, and workflow-like runs.

Codex 做过的事情都可以变成结构化记忆：sessions、messages、tool calls、tool outputs、failures、summaries、file history、spawned agents 和 workflow-like runs。

## Install / 安装

Install as a Codex skill:

安装为 Codex skill：

```bash
npx skills add xiwanzi/Obelisk-For-Codex
```

Or copy this repository into your Codex skills directory:

或手动复制到 Codex skills 目录：

```text
%USERPROFILE%\.codex\skills\obelisk-codex
```

Then ask Codex:

然后在 Codex 中提问：

```text
/obelisk-codex <your question>
```

First run builds the index. Later runs update incrementally.

首次运行会构建索引；后续运行会增量更新。

## Requires / 依赖

- Node.js 22+ with built-in `node:sqlite`.
- Codex session logs under `~/.codex/sessions/` or `~/.codex/archived_sessions/`.
- Codex skills support.

- Node.js 22+，需要内置 `node:sqlite`。
- `~/.codex/sessions/` 或 `~/.codex/archived_sessions/` 中存在 Codex 会话日志。
- Codex skills 支持。

## How It Works / 工作方式

```text
You ask a question
  ↓
Codex selects the obelisk-codex skill
  ↓
The agent writes a JS query against the SQLite index
  ↓
Runs scripts/runtime.mjs --query <script>
  ↓
Reads the JSON result and answers in natural language
```

```text
你提出问题
  ↓
Codex 触发 obelisk-codex skill
  ↓
agent 针对 SQLite 索引编写 JS 查询
  ↓
运行 scripts/runtime.mjs --query <script>
  ↓
读取 JSON 结果并用自然语言回答
```

The core idea is the same as Obelisk: do not make humans browse, tag, or organize session history. Agents can write code, so give them a local query runtime over past work.

核心思路与 Obelisk 一致：不要让人手动浏览、标注或整理会话历史。agent 能写代码，所以应该给它一个面向历史工作的本地查询运行时。

## Query API / 查询 API

Simple API taught directly in `SKILL.md`:

`SKILL.md` 直接教给 agent 的简单 API：

- `search(text, opts?)` -- full-text search across indexed Codex messages, reasoning summaries, tool calls, and tool outputs.
- `sessions(opts?)` / `recent(n?)` -- list sessions.
- `context(uuid)` -- message, session, neighbors, subagent/workflow metadata when available.
- `sql(query, ...params)` -- raw SQLite query with placeholders.

Advanced API:

高级 API：

- `thread(sessionId)` -- all indexed messages in a session.
- `fileHistory(filePath, opts?)` -- tool calls mentioning a file.
- `fileSessions(filePath, opts?)` -- sessions where a file was touched.
- `fileEdits(filePath, opts?)` -- high-confidence file edits.
- `repeatedFiles(opts?)` -- files edited across multiple sessions.
- `failures(opts?)` -- failed tool calls and nearby context.
- `summaries(opts?)` -- compacted context and task summaries.
- `raw(uuid, opts?)` -- original JSONL line window.
- `subagents(opts?)` -- Codex spawned agent metadata.
- `workflows(opts?)` -- workflow-like Codex sessions.
- `workflowTree(runId)` -- workflow, agents, messages, and recorded conclusions.

## What Gets Indexed / 索引内容

| Layer | Source | Captured |
|---|---|---|
| Sessions | `~/.codex/sessions/**/*.jsonl`, `~/.codex/archived_sessions/*.jsonl` | title, project, timestamps, JSONL path |
| Messages | Codex event and response records | user messages, assistant messages, reasoning, tool calls, tool results |
| Tool calls | Codex function/custom/tool-search calls | tool name, input JSON, best-effort file path |
| Failures | tool outputs | explicit errors and non-zero shell exits |
| Summaries | Codex compaction/task records | compacted context and task completion summaries |
| File history | tool call inputs and patches | touched files, edited files, repeated files |
| Subagents | `spawn_agent`, `wait_agent`, `close_agent` | agent id, nickname, type, task, latest conclusion |
| Workflows | sessions with spawned agents | workflow-like run id, agent count, conclusions |

| 层级 | 来源 | 捕获内容 |
|---|---|---|
| Sessions | `~/.codex/sessions/**/*.jsonl`、`~/.codex/archived_sessions/*.jsonl` | 标题、项目、时间戳、JSONL 路径 |
| Messages | Codex event / response 记录 | 用户消息、助手消息、reasoning、工具调用、工具结果 |
| Tool calls | Codex function/custom/tool-search calls | 工具名、输入 JSON、尽力提取的文件路径 |
| Failures | 工具输出 | 显式错误和非零 shell exit |
| Summaries | Codex 压缩和任务记录 | compacted context 和任务完成摘要 |
| File history | 工具输入和 patches | 被触碰文件、被修改文件、跨 session 反复修改文件 |
| Subagents | `spawn_agent`、`wait_agent`、`close_agent` | agent id、昵称、类型、任务、最新结论 |
| Workflows | 含 spawned agents 的 sessions | workflow-like run id、agent 数量、结论 |

## Notes / 注意

- Codex logs usually do not expose Claude-style parent UUID chains. `context()` therefore emphasizes nearby messages instead of parent-chain traversal.
- File extraction from arbitrary shell commands is best effort. `fileEdits()` uses high-confidence write heuristics such as `apply_patch` and common PowerShell write commands.
- Query snippets run in a sandboxed VM context without file system or network access.
- Indexed text is truncated to 10k characters per record; use `raw()` to inspect original JSONL windows.
- FTS5 supports standard SQLite FTS syntax. Quote or sanitize punctuation-heavy search terms.

- Codex 日志通常没有 Claude 风格的 parent UUID chain，所以 `context()` 主要提供附近消息，而不是完整父链。
- 从任意 shell 命令中抽取文件路径是 best effort。`fileEdits()` 使用高置信写入启发式，例如 `apply_patch` 和常见 PowerShell 写文件命令。
- 查询片段在 sandboxed VM 中运行，没有文件系统或网络访问。
- 单条索引文本截断到 10k 字符；需要原始 JSONL 窗口时使用 `raw()`。
- FTS5 使用标准 SQLite FTS 语法；包含大量标点的搜索词应加引号或先清洗。

## Structure / 结构

```text
obelisk-codex/
├── SKILL.md
├── scripts/
│   ├── db.mjs
│   ├── indexer.mjs
│   ├── query.mjs
│   └── runtime.mjs
└── references/
    └── schema.md
```

## Acknowledgement / 致谢

Obelisk For Codex is a Codex-oriented adaptation inspired by [tommy0103/obelisk](https://github.com/tommy0103/obelisk).

Obelisk For Codex 是面向 Codex 历史的适配版本，灵感来自 [tommy0103/obelisk](https://github.com/tommy0103/obelisk)。

## License / 许可证

MIT @ xiwanzi

Maintainer: xiwanzi <xiwanzi@vip.qq.com>
