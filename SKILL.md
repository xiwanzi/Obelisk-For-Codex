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

Query Codex's local session history. This skill indexes JSONL session logs under `~/.codex/sessions/` and `~/.codex/archived_sessions/`, then exposes them through a small SQLite-backed query API.

Use it when the user asks about prior Codex work, wants to continue a past thread, asks how a bug was fixed before, or explicitly writes `/obelisk-codex ...`.

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

1. Write a JS query snippet to a temp file, for example `$env:TEMP\obelisk-codex-query.mjs`.
2. Run: `node "$env:SKILL_DIR\scripts\runtime.mjs" --query "$env:TEMP\obelisk-codex-query.mjs"`.
3. Parse the JSON stdout and answer the user directly.

The query file body is executed inside `(async () => { ... })()` with the API below available as globals. Use `return` to emit JSON-serializable results.

## API

### search(text, opts?)

Full-text search across indexed Codex user messages, assistant messages, reasoning summaries, tool calls, and tool outputs.

Returns: `[{ message: {uuid, text, role, timestamp, model}, session: {id, title, project, started_at}, context: [...] }]`

Options: `{ limit, sessionId, project, after, before }`

### sessions(opts?)

Query Codex sessions ordered by most recent end time.

Options: `{ project, after, before, limit, branch, sessionId, sessions }`

```js
sessions({ project: '%wiki维护%', limit: 10 })
sessions({ after: '2026-06-01', limit: 5 })
```

### recent(n?)

Latest `n` Codex sessions, default `10`.

### context(uuid)

Details for a message plus its session and nearby messages. Codex logs do not expose Claude-style parent UUID chains, so `parentChain` is usually empty and `neighbors` provides the useful local context.

### sql(query, ...params)

Raw SQLite query. Use `?` placeholders.

Read `references/schema.md` before writing non-trivial SQL. Tables include `sessions`, `messages`, `tool_calls`, `tool_results`, `summaries`, `subagents`, and `workflows`.

### Other APIs

- `thread(sessionId)` -- all indexed records in a Codex session, ordered by time
- `fileHistory(filePath, opts?)` -- recent tool calls that mention a file path. Use `{ mode: 'write' }` for high-confidence edits only.
- `fileSessions(filePath, opts?)` -- sessions where a file was touched, grouped by session with touch counts and matching tool calls. Use `{ mode: 'write' }` for edits only.
- `fileEdits(filePath, opts?)` -- shortcut for `fileSessions(filePath, { mode: 'write', ...opts })`
- `repeatedFiles(opts?)` -- files edited across multiple sessions by default. Use `{ mode: 'touch' }` to include read/search mentions. opts: `{ minSessions, mode, project, after, before, limit }`
- `failures(opts?)` -- tool outputs inferred as errors, with nearby messages
- `summaries(opts?)` -- compacted context and task-completion summaries
- `raw(uuid, opts?)` -- original JSONL line window for an indexed message
- `subagents(opts?)` -- Codex spawned agent metadata plus latest conclusion
- `workflows(opts?)` -- Codex sessions that used spawned agents, exposed as workflow-like runs
- `workflowTree(runId)` -- workflow plus spawned agents, their messages, and their recorded conclusions
- `trace(uuid)` -- compatibility API; Codex logs usually do not expose parent chains

## Retrieval Strategy

Prefer incremental retrieval:

1. `recent()` or `sessions({ project: '...' })` to find candidate sessions.
2. `summaries({ sessions: [...] })` to cheaply inspect likely sessions.
3. `search('specific terms')` to find exact messages or tool calls.
4. `context(uuid)` for nearby messages.
5. `raw(uuid)` only when indexed text was truncated or the exact JSONL record matters.
6. `thread(sessionId)` only as a last resort.

Never dump entire sessions unless the user explicitly needs it.

## Examples

### "上次怎么修 wiki 同步的"

```js
const hits = search('wiki 同步 修', { limit: 8 })
return hits.map(h => ({
  session: h.session.title,
  date: h.session.started_at,
  role: h.message.role,
  text: h.message.text?.slice(0, 240)
}))
```

### "最近在做什么"

```js
return recent(10).map(s => ({
  title: s.title,
  project: s.project,
  started: s.started_at,
  ended: s.ended_at
}))
```

### "最近哪些工具失败了"

```js
return failures({ limit: 20 }).map(f => ({
  tool: f.toolCall?.name,
  session: f.session?.title,
  timestamp: f.result?.timestamp,
  output: f.result?.content?.slice(0, 300)
}))
```

### "这个文件之前在哪些 session 里改过"

```js
return fileEdits('C:\\Mod\\wiki维护\\sync_public_wiki.py', { limit: 20 })
```

### "哪些文件最近在多个 sessions 里反复修改"

```js
return repeatedFiles({ minSessions: 3, limit: 20 }).map(f => ({
  file: f.file_path,
  sessions: f.sessions,
  touches: f.touches,
  last: f.last_touched
}))
```

### "那个 review workflow 的 subagents 各自结论是什么"

```js
const reviewRuns = workflows({ limit: 20 })
  .filter(w => /review|审查|复盘|QA/i.test(`${w.script || ''} ${w.result_json || ''}`))
const run = reviewRuns[0] || workflows({ limit: 1 })[0]
if (!run) return []
const tree = workflowTree(run.run_id)
return tree.agents.map(a => ({
  agent: a.agent_id,
  type: a.agent_type,
  task: a.description,
  conclusions: a.conclusions.map(c => c.text.slice(0, 500))
}))
```

## Notes

- First run builds `~/.codex/obelisk-codex.sqlite`; later runs update incrementally.
- The index scans `~/.codex/sessions/**/*.jsonl` and `~/.codex/archived_sessions/*.jsonl`.
- `session_index.jsonl` is used to recover Codex thread titles where available.
- Codex `spawn_agent`, `wait_agent`, and `close_agent` tool calls are mapped into workflow-like `subagents()` / `workflowTree()` data.
- File paths are normalized and common runtime/tool paths are filtered before repeated-file analysis.
- Query snippets run in a sandboxed VM context without file system or network access.
- Indexed text is truncated to 10k characters per record; use `raw()` to inspect original JSONL windows.
- FTS5 search supports standard SQLite FTS syntax: `"exact phrase"`, `term1 AND term2`, `term1 OR term2`, `term1 NOT term2`.
