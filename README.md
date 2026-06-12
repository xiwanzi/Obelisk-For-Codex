# Obelisk For Codex

<div align="center">

[![stars](https://img.shields.io/github/stars/xiwanzi/Obelisk-For-Codex?style=flat-square)](https://github.com/xiwanzi/Obelisk-For-Codex/stargazers)
[![version](https://img.shields.io/github/v/tag/xiwanzi/Obelisk-For-Codex?label=version&style=flat-square)](https://github.com/xiwanzi/Obelisk-For-Codex/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)

**Codex edition of Obelisk: local, structured, queryable memory for Codex agents.**

**这是适配于 Codex 的 Obelisk 版本：把 Codex 历史变成本地、结构化、可查询的 agent memory。**

</div>

> This repository is for Codex Desktop / Codex CLI session history. If you use Claude Code, use the original [tommy0103/obelisk](https://github.com/tommy0103/obelisk).
>
> 本仓库面向 Codex Desktop / Codex CLI 的 session 历史。如果你使用 Claude Code，请使用原版 [tommy0103/obelisk](https://github.com/tommy0103/obelisk)。

Obelisk For Codex indexes `~/.codex/sessions/` and `~/.codex/archived_sessions/`, stores the result in SQLite + FTS5, and exposes a small JavaScript query API to the agent. The goal is not to make humans browse old chats. The goal is to let the agent query prior work, cite evidence, and continue with context.

Obelisk For Codex 会索引 `~/.codex/sessions/` 和 `~/.codex/archived_sessions/`，写入 SQLite + FTS5，并给 agent 暴露一个小型 JavaScript 查询 API。它不是给人翻聊天记录的浏览器，而是让 agent 查询过去做过什么、引用证据、带着上下文继续工作。

## Contents

- [Quick Start](#quick-start--快速开始)
- [What You Can Ask](#what-you-can-ask--可以问什么)
- [Core Capabilities](#core-capabilities--核心能力)
- [Memory Layer](#memory-layer--memory-层)
- [Query API](#query-api--查询-api)
- [Runtime Commands](#runtime-commands--运行命令)
- [What Gets Indexed](#what-gets-indexed--索引内容)
- [Evaluation](#evaluation--验证)
- [Project Layout](#project-layout--项目结构)

## Quick Start / 快速开始

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

首次运行会构建索引；后续运行会增量更新。

## Requirements / 依赖

- Node.js 22+ with built-in `node:sqlite`.
- Codex session logs under `~/.codex/sessions/` or `~/.codex/archived_sessions/`.
- Codex skills support.

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

## Core Capabilities / 核心能力

| Area | What it provides |
|---|---|
| Codex-native indexing | Reads Codex JSONL from `~/.codex/sessions/` and `~/.codex/archived_sessions/`; does not use Claude Code's `~/.claude/projects` layout. |
| Helper-first retrieval | Starts with `overview()`, `memories()`, `search()`, `fileEdits()`, `failures()`, `workflows()`, and focused helpers before raw SQL. |
| Persistent memory | Registers approved markdown memories, usually under `.obelisk/memories/`, with English summaries for stable recall. |
| Project and cwd awareness | Tracks session `project_path`, message `cwd`, and tool-level `workdir` for scoped Codex searches. |
| File history | Finds touched files, high-confidence edits, repeated files, and patch/write provenance. |
| Failure investigation | Extracts failed tool calls and nearby context without treating every mention of "error" as a failure. |
| Spawned-agent mapping | Reconstructs workflow-like runs from Codex `spawn_agent`, `wait_agent`, and `close_agent` calls. |
| Read-only querying | Query scripts run in a sandbox; `sql()` only accepts read-only `SELECT` / `WITH` queries. |

## How It Works / 工作方式

```text
You ask a question
  |
  v
Codex selects obelisk-codex
  |
  v
The agent runs overview() to orient
  |
  v
The agent queries memories() and raw session evidence
  |
  v
The agent answers with concise evidence
```

`overview()` is a map, not proof. Durable memory is prior knowledge, not final authority. Correct answers should still cite raw session evidence from `search()`, `context()`, `fileEdits()`, `failures()`, `raw()`, or focused SQL.

`overview()` 只是地图，不是证据。Memory 是先验结论，不是最终事实。严肃回答仍应回到 `search()`、`context()`、`fileEdits()`、`failures()`、`raw()` 或 scoped SQL 找原始 session 证据。

## Memory Layer / Memory 层

Memory stores durable conclusions in project markdown files and registers compact retrieval metadata in SQLite.

Memory 层把长期有用的结论保存在项目 markdown 文件里，并在 SQLite 中注册紧凑的检索 metadata。

Recommended workflow:

1. Query history with `overview()`, `memories()`, and raw session evidence.
2. Synthesize the durable conclusion in the user's normal language.
3. Write the markdown memory file inside the project, usually `.obelisk/memories/<topic>.md`.
4. Register it with `runtime.mjs --remember <script>`.
5. Recall it later with `memories({ query: 'English topic terms' })`, then confirm against raw evidence.

Rules:

- `--remember` exposes only `remember()`.
- `remember().summary` must be English.
- `memories({ query })` must use English terms. Translate Chinese or other non-English requests into concise English keywords before querying memory.
- Relative memory paths resolve against the source session `project_path` when `session_id` is provided.
- Rebuilding the index does not delete memory records.

## Query API / 查询 API

Core primitives:

| API | Purpose |
|---|---|
| `overview(opts?)` | Current/project orientation: sessions, memories, project counts. |
| `memories(opts?)` | Recall registered memory records by project, session, branch, time, and English query terms. |
| `search(text, opts?)` | FTS5 search with `rank`, `project`, `cwd`, session, and time filters. |
| `context(uuid)` | Selected message, nearby messages, session metadata, and subagent/workflow metadata. |
| `sql(query, ...params)` | Read-only `SELECT` / `WITH` SQL with placeholders. |

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

FTS note: `search()` passes text directly to SQLite FTS5. For punctuation-heavy Windows paths, pass a valid FTS phrase yourself or use scoped SQL `LIKE`; `search()` does not silently rewrite failed queries.

## Runtime Commands / 运行命令

Run from the repository or installed skill directory:

```powershell
node scripts/runtime.mjs --build
node scripts/runtime.mjs --search "auth fix"
node scripts/runtime.mjs --query .\query.mjs
node scripts/runtime.mjs --remember .\register-memory.mjs
```

`--query` exposes read-only helpers such as `overview()`, `search()`, `sql()`, and `memories()`.

`--remember` exposes only `remember(record)`.

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

## Evaluation / 验证

Synthetic fixtures use fake Codex homes and do not touch real session data:

```powershell
node evals/obelisk-codex/runners/run-api-eval.mjs --lane synthetic --stage upstream-memory-port
```

Local smoke uses the real `~/.codex` but stores only redacted counts and hashes:

```powershell
node evals/obelisk-codex/runners/run-api-eval.mjs --lane local --stage upstream-memory-port
```

The benchmark covers memory registration/recall, CJK memory guardrails, `overview()`, `search()` rank and `cwd` filtering, read-only SQL guardrails, file edit helpers, failures, raw recovery, spawned-agent reconstruction, and incremental indexing.

## Notes / 注意

- Query snippets run in a sandboxed VM context without file system or network access.
- `--remember` is a separate sandbox that exposes only `remember()`.
- Indexed text is truncated to 10k characters per record; use `raw()` to inspect original JSONL windows.
- Codex logs usually do not expose Claude-style parent UUID chains, so `context()` emphasizes nearby messages.
- File extraction from arbitrary shell commands is best effort. `fileEdits()` uses high-confidence write heuristics such as `apply_patch` and common PowerShell write commands.

## Project Layout / 项目结构

```text
obelisk-codex/
├── SKILL.md
├── docs/
│   └── obelisk-codex-benchmark.md
├── evals/
│   └── obelisk-codex/
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

Obelisk For Codex is a Codex-oriented adaptation inspired by [tommy0103/obelisk](https://github.com/tommy0103/obelisk). It keeps the Obelisk helper-first retrieval idea while using Codex's `~/.codex/sessions` / `archived_sessions` JSONL structure.

Obelisk For Codex 是面向 Codex 历史的适配版本，灵感来自 [tommy0103/obelisk](https://github.com/tommy0103/obelisk)。它保留 Obelisk 的 helper-first 检索思路，但按 Codex 的 `~/.codex/sessions` / `archived_sessions` JSONL 结构实现。

## License / 许可证

MIT @ xiwanzi

Maintainer: xiwanzi <xiwanzi@vip.qq.com>
