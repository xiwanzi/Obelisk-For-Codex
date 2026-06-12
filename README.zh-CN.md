# Obelisk For Codex

<div align="center">

[![stars](https://img.shields.io/github/stars/xiwanzi/Obelisk-For-Codex?style=flat-square)](https://github.com/xiwanzi/Obelisk-For-Codex/stargazers)
[![version](https://img.shields.io/github/v/tag/xiwanzi/Obelisk-For-Codex?label=version&style=flat-square)](https://github.com/xiwanzi/Obelisk-For-Codex/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)

<p>
  <a href="./README.md">English</a>
  ·
  <strong>中文</strong>
</p>

<h3>Obelisk 的 Codex 适配版</h3>

给 Codex agent 使用的本地、结构化、可查询 memory。

</div>

> 本仓库面向 Codex Desktop / Codex CLI 的 session 历史。如果你使用 Claude Code，请使用原版 [tommy0103/obelisk](https://github.com/tommy0103/obelisk)。

Obelisk For Codex 会索引 `~/.codex/sessions/` 和 `~/.codex/archived_sessions/`，写入 SQLite + FTS5，并给 agent 暴露一个小型 JavaScript 查询 API。

它不是给人翻聊天记录的浏览器，而是让 agent 查询过去做过什么、引用证据、带着上下文继续工作。

## 目录

- [快速开始](#快速开始)
- [可以问什么](#可以问什么)
- [核心能力](#核心能力)
- [Memory 层](#memory-层)
- [查询 API](#查询-api)
- [运行命令](#运行命令)
- [索引内容](#索引内容)
- [验证](#验证)
- [项目结构](#项目结构)

## 快速开始

安装为 Codex skill：

```bash
npx skills add xiwanzi/Obelisk-For-Codex
```

也可以手动复制到 Codex skills 目录：

```text
%USERPROFILE%\.codex\skills\obelisk-codex
```

然后在 Codex 中提问：

```text
/obelisk-codex <你的问题>
```

首次运行会构建索引；后续运行会增量更新。

## 依赖

- Node.js 22+，需要内置 `node:sqlite`。
- `~/.codex/sessions/` 或 `~/.codex/archived_sessions/` 中存在 Codex session 日志。
- Codex skills 支持。

## 可以问什么

```text
/obelisk-codex 上次 auth bug 最后到底改了哪些文件，为什么这么改
/obelisk-codex 这个文件最近在哪些 sessions 里被反复修改
/obelisk-codex 找出最近失败的 tool calls，它们分别发生在哪些任务里
/obelisk-codex 那个 review workflow 的 subagents 各自结论是什么
/obelisk-codex 我之前有没有试过这个方案，结果为什么放弃了
/obelisk-codex 记住这次关于索引策略的结论
```

Codex 做过的事情都可以变成结构化记忆：sessions、messages、tool calls、tool outputs、failures、summaries、file history、spawned agents、workflow-like runs，以及批准写入的 markdown memories。

## 核心能力

| 能力 | 说明 |
|---|---|
| Codex 原生索引 | 读取 `~/.codex/sessions/` 和 `~/.codex/archived_sessions/` 中的 Codex JSONL；不使用 Claude Code 的 `~/.claude/projects` 布局。 |
| Helper-first 检索 | 优先使用 `overview()`、`memories()`、`search()`、`fileEdits()`、`failures()`、`workflows()` 和聚焦 helper，再使用 raw SQL。 |
| 持久 memory | 注册用户批准的 markdown memories，通常放在 `.obelisk/memories/`，并用英文 summary 做稳定召回。 |
| 项目与 cwd 感知 | 记录 session `project_path`、message `cwd` 和 tool-level `workdir`，支持按 Codex 工作目录精确检索。 |
| 文件历史 | 查找被触碰文件、高置信编辑、重复修改文件，以及 patch/write provenance。 |
| 失败调查 | 抽取真实失败的 tool calls 和 nearby context，不把所有提到 “error” 的文本都当作失败。 |
| Spawned-agent 映射 | 从 Codex `spawn_agent`、`wait_agent`、`close_agent` 调用重建 workflow-like runs。 |
| 只读查询 | Query 脚本在 sandbox 中运行；`sql()` 只接受只读 `SELECT` / `WITH`。 |

## 工作方式

```text
你提出问题
  |
  v
Codex 选择 obelisk-codex
  |
  v
agent 先用 overview() 定位
  |
  v
agent 查询 memories() 和原始 session 证据
  |
  v
agent 带着简洁证据回答
```

`overview()` 只是地图，不是证据。Memory 是先验结论，不是最终事实。严肃回答仍应回到 `search()`、`context()`、`fileEdits()`、`failures()`、`raw()` 或 scoped SQL 找原始 session 证据。

## Memory 层

Memory 层把长期有用的结论保存在项目 markdown 文件里，并在 SQLite 中注册紧凑的检索 metadata。

推荐工作流：

1. 使用 `overview()`、`memories()` 和原始 session 证据查询历史。
2. 用用户的正常语言综合出长期结论。
3. 在项目内写入 markdown memory 文件，通常是 `.obelisk/memories/<topic>.md`。
4. 用 `runtime.mjs --remember <script>` 注册。
5. 之后用 `memories({ query: 'English topic terms' })` 召回，再回到原始证据确认。

规则：

- `--remember` 只暴露 `remember()`。
- `remember().summary` 必须是英文。
- `memories({ query })` 必须使用英文关键词。中文请求应先翻译成简短英文关键词再查 memory。
- 提供 `session_id` 时，相对 memory 路径会按 source session 的 `project_path` 解析。
- 重建索引不会删除 memory records。

## 查询 API

核心 API：

| API | 用途 |
|---|---|
| `overview(opts?)` | 当前/指定项目的 orientation：sessions、memories、项目统计。 |
| `memories(opts?)` | 按项目、session、branch、时间、英文 query terms 召回已注册 memory records。 |
| `search(text, opts?)` | FTS5 搜索，支持 `rank`、`project`、`cwd`、session 和时间过滤。 |
| `context(uuid)` | 选中消息、附近消息、session metadata，以及 subagent/workflow metadata。 |
| `sql(query, ...params)` | 只读 `SELECT` / `WITH` SQL，支持占位符。 |

结构化 helpers：

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

FTS 注意：`search()` 会把 text 直接传给 SQLite FTS5。对于标点很多的 Windows 路径，应由调用方显式传入合法 FTS phrase，或在已知 scope 下使用 SQL `LIKE`；`search()` 不会静默改写失败查询。

## 运行命令

在仓库目录或已安装 skill 目录运行：

```powershell
node scripts/runtime.mjs --build
node scripts/runtime.mjs --search "auth fix"
node scripts/runtime.mjs --query .\query.mjs
node scripts/runtime.mjs --remember .\register-memory.mjs
```

`--query` 暴露只读 helpers，例如 `overview()`、`search()`、`sql()` 和 `memories()`。

`--remember` 只暴露 `remember(record)`。

## 索引内容

| 层 | 来源 | 捕获内容 |
|---|---|---|
| Sessions | `~/.codex/sessions/**/*.jsonl`、`~/.codex/archived_sessions/*.jsonl` | title、project、cwd、timestamps、JSONL path |
| Messages | Codex event 和 response records | user messages、assistant messages、reasoning、tool calls、tool results、cwd |
| Tool calls | Codex function/custom/tool-search calls | tool name、input JSON、best-effort file path |
| Failures | tool outputs | explicit errors 和非零 shell exits |
| Summaries | Codex compaction 和 task records | compacted context 和 task completion summaries |
| File history | tool inputs 和 patches | touched files、edited files、repeated files |
| Subagents | `spawn_agent`、`wait_agent`、`close_agent` | agent id、nickname、type、task、latest conclusion |
| Workflows | 含 spawned agents 的 sessions | workflow-like run id、agent count、conclusions |
| Memories | agent 经用户批准后注册的 markdown files | 英文 retrieval summary，并链接 source session/messages |

## 验证

Synthetic fixtures 使用 fake Codex homes，不触碰真实 session 数据：

```powershell
node evals/obelisk-codex/runners/run-api-eval.mjs --lane synthetic --stage upstream-memory-port
```

Local smoke 使用真实 `~/.codex`，但只保存 redacted counts 和 hashes：

```powershell
node evals/obelisk-codex/runners/run-api-eval.mjs --lane local --stage upstream-memory-port
```

Benchmark 覆盖 memory 注册/召回、CJK memory guardrails、`overview()`、`search()` rank 与 `cwd` filter、read-only SQL guardrails、file edit helpers、failures、raw recovery、spawned-agent reconstruction 和 incremental indexing。

## 注意

- Query snippets 在 sandboxed VM context 中运行，没有文件系统或网络访问。
- `--remember` 是单独 sandbox，只暴露 `remember()`。
- 单条索引文本截断到 10k 字符；需要原始 JSONL window 时使用 `raw()`。
- Codex 日志通常没有 Claude-style parent UUID chains，所以 `context()` 更强调 nearby messages。
- 从任意 shell 命令中抽取文件路径是 best effort。`fileEdits()` 使用高置信写入启发式，例如 `apply_patch` 和常见 PowerShell 写文件命令。

## 项目结构

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

## 致谢

Obelisk For Codex 是面向 Codex 历史的适配版本，灵感来自 [tommy0103/obelisk](https://github.com/tommy0103/obelisk)。它保留 Obelisk 的 helper-first 检索思路，但按 Codex 的 `~/.codex/sessions` / `archived_sessions` JSONL 结构实现。

## 许可证

MIT @ xiwanzi

Maintainer: xiwanzi <xiwanzi@vip.qq.com>
