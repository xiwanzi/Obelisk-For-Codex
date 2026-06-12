# Obelisk For Codex

<div align="center">

[![stars](https://img.shields.io/github/stars/xiwanzi/Obelisk-For-Codex?style=flat-square)](https://github.com/xiwanzi/Obelisk-For-Codex/stargazers)
[![version](https://img.shields.io/github/v/tag/xiwanzi/Obelisk-For-Codex?label=version&style=flat-square)](https://github.com/xiwanzi/Obelisk-For-Codex/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)

Every past Codex session, tool call, summary, spawned agent, workflow-like run, and approved markdown memory -- queryable by your agent.

每一段 Codex 历史、工具调用、摘要、子 agent、workflow-like run 和批准写入的 markdown memory，都可以由 agent 结构化查询。

**Humans should not browse session history. Agents should query it.**

**人不应该翻聊天记录；agent 应该直接查询历史。**

</div>

## Not a Session Browser / 不是会话浏览器

Obelisk For Codex is built for agents. It indexes Codex Desktop / Codex CLI session logs under `~/.codex`, exposes them through SQLite + FTS5, and gives the agent a small JavaScript query API.

Obelisk For Codex 是给 agent 用的。它索引 `~/.codex` 下的 Codex Desktop / Codex CLI 会话日志，用 SQLite + FTS5 暴露结构化数据，并提供一个小型 JavaScript 查询 API。

You ask in plain language. The agent writes the query, runs it locally, checks memory plus raw session evidence, and answers with structured proof.

你用自然语言提问。agent 编写查询，在本地运行，同时检查 memory 和原始 session 证据，然后带着结构化证据回答。

## What You Can Ask / 可以问什么

```text
/obelisk-codex 上次 auth bug 最后到底改了哪些文件，为什么这么改
/obelisk-codex 这个文件最近在哪些 sessions 里被反复修改
/obelisk-codex 找出最近失败的 tool calls，它们分别发生在哪些任务里
/obelisk-codex 那个 review workflow 的 subagents 各自结论是什么
/obelisk-codex 我之前有没有试过这个方案，结果为什么放弃了
/obelisk-codex 记住这次关于索引策略的结论
```

Anything Codex has done before can become structured, queryable memory: sessions, messages, tool calls, tool outputs, failures, summaries, file history, spawned agents, workflow-like runs, and approved markdown memories.

Codex 做过的事情都可以变成结构化记忆：sessions、messages、tool calls、tool outputs、failures、summaries、file history、spawned agents、workflow-like runs，以及批准写入的 markdown memories。

## Install / 安装

Install as a Codex skill:

```bash
npx skills add xiwanzi/Obelisk-For-Codex
```

Or copy this repository into your Codex skills directory:

```text
%USERPROFILE%\.codex\skills\obelisk-codex
```

Then ask Codex:

```text
/obelisk-codex <your question>
```

First run builds the index. Later runs update incrementally.

## Requires / 依赖

- Node.js 22+ with built-in `node:sqlite`.
- Codex session logs under `~/.codex/sessions/` or `~/.codex/archived_sessions/`.
- Codex skills support.

## How It Works / 工作方式

```text
You ask a question
  ↓
Codex selects obelisk-codex
  ↓
The agent runs overview() to orient
  ↓
The agent queries memories() and raw session evidence
  ↓
The agent answers with concise evidence
```

When a retrieval produces a durable conclusion worth keeping, the agent can propose a markdown memory file. After user approval, it registers the file with `runtime.mjs --remember <script>`, which exposes only `remember()`.

当一次检索产生值得长期保留的结论时，agent 可以提议写入 markdown memory。用户批准后，用 `runtime.mjs --remember <script>` 注册；该运行时只暴露 `remember()`。

## Query API / 查询 API

Core primitives:

- `overview(opts?)` -- current/project orientation: sessions, memories, project counts.
- `search(text, opts?)` -- FTS5 full-text search with `rank`, `project`, `cwd`, and time filters.
- `context(uuid)` -- message, session, nearby messages, subagent/workflow metadata.
- `sql(query, ...params)` -- read-only `SELECT` / `WITH` SQL.

Structured helpers:

- `sessions(opts?)` / `recent(n?)`
- `summaries(opts?)`
- `fileHistory(filePath, opts?)`
- `fileSessions(filePath, opts?)`
- `fileEdits(filePath, opts?)`
- `repeatedFiles(opts?)`
- `failures(opts?)`
- `raw(uuid, opts?)`
- `subagents(opts?)`
- `workflows(opts?)`
- `workflowTree(runId)`
- `memories(opts?)`

Memory registration:

- `runtime.mjs --remember <script>` exposes only `remember(record)`.
- `remember().summary` and `memories({ query })` must use English terms.
- Relative memory paths resolve against the source session `project_path`; `.obelisk/memories/` is the recommended project-local location.

## What Gets Indexed / 索引内容

| Layer | Source | Captured |
|---|---|---|
| Sessions | `~/.codex/sessions/**/*.jsonl`, `~/.codex/archived_sessions/*.jsonl` | title, project, cwd, timestamps, JSONL path |
| Messages | Codex event and response records | user messages, assistant messages, reasoning, tool calls, tool results, cwd |
| Tool calls | Codex function/custom/tool-search calls | tool name, input JSON, best-effort file path |
| Failures | tool outputs | explicit errors and non-zero shell exits |
| Summaries | Codex compaction and task records | compacted context and task completion summaries |
| File history | tool inputs and patches | touched files, edited files, repeated files |
| Subagents | `spawn_agent`, `wait_agent`, `close_agent` | agent id, nickname, type, task, latest conclusion |
| Workflows | sessions with spawned agents | workflow-like run id, agent count, conclusions |
| Memories | markdown files registered by the agent after approval | English retrieval summary linked to source session/messages |

## Notes / 注意

- Query snippets run in a sandboxed VM context without file system or network access.
- `--remember` is a separate sandbox that exposes only `remember()`.
- Indexed text is truncated to 10k characters per record; use `raw()` to inspect original JSONL windows.
- Codex logs usually do not expose Claude-style parent UUID chains, so `context()` emphasizes nearby messages.
- File extraction from arbitrary shell commands is best effort. `fileEdits()` uses high-confidence write heuristics such as `apply_patch` and common PowerShell write commands.
- FTS5 supports standard syntax. For punctuation-heavy Windows paths, pass a valid FTS phrase yourself or use scoped SQL `LIKE`; `search()` does not silently rewrite failed queries.

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
    ├── schema.md
    ├── query-patterns.md
    ├── retrieval-semantics.md
    └── pitfalls.md
```

## Acknowledgement / 致谢

Obelisk For Codex is a Codex-oriented adaptation inspired by [tommy0103/obelisk](https://github.com/tommy0103/obelisk).

Obelisk For Codex 是面向 Codex 历史的适配版本，灵感来自 [tommy0103/obelisk](https://github.com/tommy0103/obelisk)。

## License / 许可证

MIT @ xiwanzi

Maintainer: xiwanzi <xiwanzi@vip.qq.com>
