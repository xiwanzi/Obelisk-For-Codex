# Obelisk For Codex

<div align="center">

[![stars](https://img.shields.io/github/stars/xiwanzi/Obelisk-For-Codex?style=flat-square)](https://github.com/xiwanzi/Obelisk-For-Codex/stargazers)
[![version](https://img.shields.io/github/v/tag/xiwanzi/Obelisk-For-Codex?label=version&style=flat-square)](https://github.com/xiwanzi/Obelisk-For-Codex/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)

<p>
  <strong>English</strong>
  ·
  <a href="./README.zh-CN.md">中文</a>
</p>

<h3>Codex edition of Obelisk</h3>

Local, structured, queryable memory for Codex agents.

</div>

> This repository is for Codex Desktop / Codex CLI session history. If you use Claude Code, use the original [tommy0103/obelisk](https://github.com/tommy0103/obelisk).

Obelisk For Codex indexes `~/.codex/sessions/` and `~/.codex/archived_sessions/`, stores the result in SQLite + FTS5, and exposes a small JavaScript query API to the agent.

The goal is not to make humans browse old chats. The goal is to let the agent query prior work, cite evidence, and continue with context.

## Contents

- [Quick Start](#quick-start)
- [What You Can Ask](#what-you-can-ask)
- [Core Capabilities](#core-capabilities)
- [Memory Layer](#memory-layer)
- [Query API](#query-api)
- [Runtime Commands](#runtime-commands)
- [What Gets Indexed](#what-gets-indexed)
- [Evaluation](#evaluation)
- [Project Layout](#project-layout)

## Quick Start

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

The first run builds the index. Later runs update incrementally.

## Requirements

- Node.js 22+ with built-in `node:sqlite`.
- Codex session logs under `~/.codex/sessions/` or `~/.codex/archived_sessions/`.
- Codex skills support.

## What You Can Ask

```text
/obelisk-codex What files did we change last time for the auth bug, and why?
/obelisk-codex Which sessions repeatedly edited this file?
/obelisk-codex Find recent failed tool calls and the tasks they happened in.
/obelisk-codex What did each subagent conclude in that review workflow?
/obelisk-codex Did we try this approach before, and why was it abandoned?
/obelisk-codex Remember this decision about the indexing strategy.
```

Anything Codex has done before can become structured, queryable memory: sessions, messages, tool calls, tool outputs, failures, summaries, file history, spawned agents, workflow-like runs, and approved markdown memories.

## Core Capabilities

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

## How It Works

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

## Memory Layer

Memory stores durable conclusions in project markdown files and registers compact retrieval metadata in SQLite.

Recommended workflow:

1. Query history with `overview()`, `memories()`, and raw session evidence.
2. Synthesize the durable conclusion in the user's normal language.
3. Write the markdown memory file inside the project, usually `.obelisk/memories/<topic>.md`.
4. Register it with `runtime.mjs --remember <script>`.
5. Recall it later with `memories({ query: 'English topic terms' })`, then confirm against raw evidence.

Rules:

- `--remember` exposes only `remember()`.
- `remember().summary` must be English.
- `memories({ query })` must use English terms. Translate non-English requests into concise English keywords before querying memory.
- Relative memory paths resolve against the source session `project_path` when `session_id` is provided.
- Rebuilding the index does not delete memory records.

## Query API

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

## Runtime Commands

Run from the repository or installed skill directory:

```powershell
node scripts/runtime.mjs --build
node scripts/runtime.mjs --search "auth fix"
node scripts/runtime.mjs --query .\query.mjs
node scripts/runtime.mjs --remember .\register-memory.mjs
```

`--query` exposes read-only helpers such as `overview()`, `search()`, `sql()`, and `memories()`.

`--remember` exposes only `remember(record)`.

## What Gets Indexed

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

## Evaluation

Synthetic fixtures use fake Codex homes and do not touch real session data:

```powershell
node evals/obelisk-codex/runners/run-api-eval.mjs --lane synthetic --stage upstream-memory-port
```

Local smoke uses the real `~/.codex` but stores only redacted counts and hashes:

```powershell
node evals/obelisk-codex/runners/run-api-eval.mjs --lane local --stage upstream-memory-port
```

The benchmark covers memory registration/recall, CJK memory guardrails, `overview()`, `search()` rank and `cwd` filtering, read-only SQL guardrails, file edit helpers, failures, raw recovery, spawned-agent reconstruction, and incremental indexing.

## Notes

- Query snippets run in a sandboxed VM context without file system or network access.
- `--remember` is a separate sandbox that exposes only `remember()`.
- Indexed text is truncated to 10k characters per record; use `raw()` to inspect original JSONL windows.
- Codex logs usually do not expose Claude-style parent UUID chains, so `context()` emphasizes nearby messages.
- File extraction from arbitrary shell commands is best effort. `fileEdits()` uses high-confidence write heuristics such as `apply_patch` and common PowerShell write commands.

## Project Layout

```text
obelisk-codex/
├── README.md
├── README.zh-CN.md
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

## Acknowledgement

Obelisk For Codex is a Codex-oriented adaptation inspired by [tommy0103/obelisk](https://github.com/tommy0103/obelisk). It keeps the Obelisk helper-first retrieval idea while using Codex's `~/.codex/sessions` / `archived_sessions` JSONL structure.

## License

MIT @ xiwanzi

Maintainer: xiwanzi <xiwanzi@vip.qq.com>
