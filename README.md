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

## Current Capabilities / 当前能力

- Indexes Codex JSONL from `~/.codex/sessions/` and `~/.codex/archived_sessions/`.
- Rebuilds derived tables when the indexer schema changes while preserving registered memories.
- Exposes helper-first retrieval through `overview()`, `memories()`, `search()`, `fileEdits()`, `failures()`, `workflows()`, and related APIs.
- Stores durable memory as project markdown, typically under `.obelisk/memories/`, with an English retrieval summary linked back to source sessions/messages.
- Tracks message `cwd` and tool-level `workdir` so project/file queries match Codex's session layout instead of Claude Code's project directory model.
- Reconstructs Codex spawned-agent workflow-like runs from `spawn_agent`, `wait_agent`, and `close_agent`.
- Keeps query scripts read-only; memory registration runs in a separate `--remember` sandbox.

当前能力：

- 索引 `~/.codex/sessions/` 和 `~/.codex/archived_sessions/` 中的 Codex JSONL。
- indexer schema 变化时重建派生表，同时保留已注册 memories。
- 通过 `overview()`、`memories()`、`search()`、`fileEdits()`、`failures()`、`workflows()` 等 helper-first API 检索历史。
- 用项目内 markdown 保存持久 memory，推荐位置是 `.obelisk/memories/`；索引英文 summary，并回指 source sessions/messages。
- 记录 message `cwd` 和 tool-level `workdir`，按 Codex 的 session 结构查询项目和文件，不照搬 Claude Code 的项目目录模型。
- 从 `spawn_agent`、`wait_agent`、`close_agent` 重建 Codex spawned-agent workflow-like runs。
- 普通 query 脚本只读；memory 注册使用隔离的 `--remember` sandbox。

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

## CLI Usage / 命令行用法

Run from the repository or installed skill directory:

```powershell
node scripts/runtime.mjs --build
node scripts/runtime.mjs --search "auth fix"
node scripts/runtime.mjs --query .\query.mjs
node scripts/runtime.mjs --remember .\register-memory.mjs
```

`--query` exposes read-only helpers such as `overview()`, `search()`, `sql()`, and `memories()`. `--remember` exposes only `remember()`.

`--query` 暴露只读 helper，例如 `overview()`、`search()`、`sql()` 和 `memories()`。`--remember` 只暴露 `remember()`。

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

## Memory Workflow / Memory 工作流

1. Query history with `overview()`, `memories()`, and raw session evidence from `search()` or focused helpers.
2. Synthesize the durable conclusion in the user's normal language.
3. If the conclusion should persist, write a markdown memory file inside the project, usually `.obelisk/memories/<topic>.md`.
4. Register it with `runtime.mjs --remember <script>` using an English `summary`.
5. Future recalls use `memories({ query: 'English topic terms' })` as prior notes, then confirm facts against raw session evidence.

Memory summaries and `memories({ query })` terms are intentionally English-indexed for stable retrieval. Non-English user requests should be translated into concise English keywords before querying the memory layer.

Memory summary 和 `memories({ query })` 查询词固定使用英文索引，便于稳定召回。中文请求应先翻译成简短英文关键词再查询 memory 层。

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

## Structure / 结构

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

Obelisk For Codex is a Codex-oriented adaptation inspired by [tommy0103/obelisk](https://github.com/tommy0103/obelisk).

Obelisk For Codex 是面向 Codex 历史的适配版本，灵感来自 [tommy0103/obelisk](https://github.com/tommy0103/obelisk)。

## License / 许可证

MIT @ xiwanzi

Maintainer: xiwanzi <xiwanzi@vip.qq.com>
