---
name: obelisk-codex
description: >
  Search and query past Codex session history from local ~/.codex session JSONL files.
  Use when the user writes /obelisk-codex, mentions Obelisk for Codex, asks how something was fixed last time, wants to find a previous Codex session, asks "上次怎么", "之前的session", "历史记录", or references past work that would benefit from local history lookup.
triggers:
  - "/obelisk-codex"
  - "obelisk-codex"
  - "Codex history"
  - "past Codex session"
  - "what did we do last time"
  - "find the session where"
  - "上次怎么"
  - "之前的session"
  - "历史记录"
  - "继续之前的"
---

# obelisk-codex

Query Codex's local session history. This skill indexes JSONL session logs under `~/.codex/sessions/` and `~/.codex/archived_sessions/`, then exposes SQLite + FTS5 through a small JavaScript query API.

Obelisk-Codex is a CodeAct memory layer: write a bounded JS query, run it locally, read JSON, and answer with concise evidence. Do not browse or dump entire sessions by default.

## Quick Start

Set the skill directory for commands:

```powershell
$env:SKILL_DIR = "C:\Users\34545\.codex\skills\obelisk-codex"
```

Fast keyword search:

```powershell
node "$env:SKILL_DIR\scripts\runtime.mjs" --search "keyword"
```

Custom query:

1. Write a bounded JS query snippet to a temp file.
2. Run `node "$env:SKILL_DIR\scripts\runtime.mjs" --query "$env:TEMP\obelisk-codex-query.mjs"`.
3. Parse JSON stdout and answer the user directly.

Query scripts run inside `(async () => { ... })()`. Use `return` to emit JSON. Query scripts are read-only: `remember()` is not available, and `sql()` only accepts read-only `SELECT` / `WITH` queries.

## Default First Pass

Start with helpers, not raw SQL. For a new retrieval task, normally call `overview({ limit: 6 })` unless the user already gave an exact `session_id`, message `uuid`, or absolute file path.

For semantic or synthesis tasks, combine orientation, memory recall, and raw session evidence:

```js
const map = overview({ limit: 6 });
const project = map.current.project?.project;
const topic = 'English topic terms translated from the user request';

return {
  orientation: map.current_project,
  prior_memories: memories({ project, query: topic, limit: 5 }),
  session_evidence: search(topic.replace(/[-_]/g, ' '), { project, limit: 8 }),
};
```

Use `sql()` only for exact joins, aggregations, or schema questions helpers cannot express cleanly.

## Query Routing

- Read `references/query-patterns.md` before broad synthesis, progress summaries, design history, or questions about what was decided, tried, abandoned, or learned.
- Read `references/retrieval-semantics.md` before multi-step retrieval, scoped project/file/session searches, or conclusion/history questions.
- Read `references/schema.md` before raw `sql()` unless the needed table/column relationship is already explicit here.
- Read `references/pitfalls.md` after query errors, empty results, unclear helper fields, FTS syntax problems, or over-large output.

When a helper row shape is unclear, run a tiny scoped sample and return `Object.keys(row)` or a compact row. Do not invent field names.

## Core API

### `search(text, opts?)`

Full-text search across indexed Codex user messages, assistant messages, reasoning summaries, tool calls, and tool outputs.

Returns:

```js
[{ message: { uuid, text, role, timestamp, model, cwd },
   session: { id, title, project, started_at },
   rank,
   context }]
```

Opts: `{ limit, sessionId, project, after, before, cwd }`. `project` and `cwd` are SQL `LIKE` filters. Results are ordered by FTS5 rank; lower rank sorts earlier.

`search()` passes `text` directly to SQLite FTS5. For punctuation-heavy literals such as Windows paths, pass a valid FTS phrase yourself or use scoped SQL `LIKE`.

### `context(uuid)`

Returns `{ message, parentChain, neighbors, session, subagent, workflow }`. Codex logs usually do not expose Claude-style parent chains, so `neighbors` is the useful local context source.

### `sql(query, ...params)`

Read-only SQL with `?` placeholders. Only `SELECT` and `WITH` are allowed. Mutating/admin SQL such as `INSERT`, `DELETE`, `PRAGMA`, `VACUUM`, and `ATTACH` is rejected.

Before non-trivial SQL, read `references/schema.md`.

## Structured Helpers

All list helpers accept bounded `limit`. Many also accept `{ project, after, before, sessionId, sessions, branch }`.

- `overview(opts?)` -- compact orientation map: current cwd/project when knowable, global project counts, recent current-project sessions, and memory records.
- `sessions(opts?)` / `recent(n?)` -- session rows, newest first.
- `summaries(opts?)` -- compaction and task-completion summaries.
- `fileHistory(filePath, opts?)` -- tool calls mentioning a file; includes read/search mentions by default.
- `fileSessions(filePath, opts?)` -- sessions where a file was touched, grouped by session.
- `fileEdits(filePath, opts?)` -- high-confidence writes only.
- `repeatedFiles(opts?)` -- files edited across multiple sessions by default; pass `{ mode: 'touch' }` to include reads/searches.
- `failures(opts?)` -- failed tool results with nearby messages.
- `subagents(opts?)`, `workflows(opts?)`, `workflowTree(runId)` -- Codex spawned-agent workflow-like reconstruction.
- `thread(sessionId)` -- full session messages; last resort only.
- `raw(uuid, opts?)` -- windowed access to the original JSONL line.
- `memories(opts?)` -- recall registered memory records, newest first.

## Memory Layer

Obelisk-Codex has persistent markdown memories alongside raw session data. Query both layers: use `memories()` for prior conclusions and `search()` / helpers for raw evidence. Treat memory as prior notes, not final authority.

The memory layer is English-indexed. Use English terms in `memories({ query })` even when the user asks in another language. Write every `remember().summary` in English. The runtime rejects obvious CJK text in memory queries and summaries.

Recall:

```js
return memories({
  query: 'persistent Codex memory layer',
  project: '%Obelisk%',
  limit: 5,
});
```

Writing memories requires user approval. Flow:

1. Write a markdown file, usually under `.obelisk/memories/` in the source project.
2. Register it through the narrow runtime:

```js
return remember({
  path: '.obelisk/memories/design-decision.md',
  session_id: 'source-session-id',
  message_start: 'first-message-uuid',
  message_end: 'last-message-uuid',
  summary: 'Decision: keep durable conclusions in project markdown and index English summaries for stable recall.'
});
```

Run:

```powershell
node "$env:SKILL_DIR\scripts\runtime.mjs" --remember "$env:TEMP\register-memory.mjs"
```

`--remember` exposes only `remember()`. It does not expose `search()`, `sql()`, `memories()`, or other query helpers. Relative paths resolve against the source session's `project_path` when `session_id` is provided, otherwise against the runtime cwd. `remember()` validates that the markdown file already exists.

Good memory candidates: design decisions, project conventions, abandoned alternatives, repeated failure causes, workflow patterns, and conclusions synthesized across multiple evidence points. Do not propose memory for one-off lookups or uncertain findings.

## Minimal Patterns

Find recent context:

```js
return overview({ limit: 6 });
```

Search, then expand one promising hit:

```js
const hits = search('auth fix', { limit: 5 });
if (!hits.length) return [];
return hits.slice(0, 3).map(h => ({
  session_id: h.session.id,
  session_title: h.session.title,
  uuid: h.message.uuid,
  snippet: h.message.text?.slice(0, 240),
}));
```

File edit history:

```js
return fileEdits('C:\\Mod\\wiki维护\\sync_public_wiki.py', { limit: 20 });
```

Recent failures:

```js
return failures({ limit: 20 }).map(f => ({
  tool: f.toolCall?.name,
  session: f.session?.title,
  timestamp: f.result?.timestamp,
  output: f.result?.content?.slice(0, 300),
}));
```

## Notes

- First run builds `~/.codex/obelisk-codex.sqlite`; later runs update incrementally.
- The index scans `~/.codex/sessions/**/*.jsonl` and `~/.codex/archived_sessions/*.jsonl`.
- `session_index.jsonl` is used to recover Codex thread titles where available.
- Codex `spawn_agent`, `wait_agent`, and `close_agent` tool calls are mapped into workflow-like `subagents()` / `workflowTree()` data.
- Indexed text is truncated to 10k characters per record; use `raw()` for exact JSONL windows.
