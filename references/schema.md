# obelisk-codex schema

Database location: `~/.codex/obelisk-codex.sqlite`

Data sources:

- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/archived_sessions/*.jsonl`
- `~/.codex/session_index.jsonl` for thread titles

The database keeps Obelisk-style table names, but rows are derived from Codex JSONL events.

## 1. Database Schema

### sessions

One row per Codex JSONL session.

```sql
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  title         TEXT,
  project       TEXT,              -- cwd normalized to forward slashes, or fallback label
  project_path  TEXT,              -- normalized session cwd when available
  started_at    TEXT,
  ended_at      TEXT,
  git_branch    TEXT,
  version       TEXT,
  message_count INTEGER DEFAULT 0,
  jsonl_path    TEXT
);
```

### messages

Indexed Codex records. UUIDs are synthetic for Codex event lines: `<sessionId>:<lineNumber>`.

```sql
CREATE TABLE messages (
  uuid          TEXT PRIMARY KEY,
  session_id    TEXT,
  type          TEXT,              -- user, assistant, reasoning, tool_call, tool_result, agent_result
  parent_uuid   TEXT,
  timestamp     TEXT,
  role          TEXT,
  text          TEXT,
  model         TEXT,
  is_sidechain  INTEGER DEFAULT 0,
  agent_id      TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cwd           TEXT               -- cwd at message/tool-call time when known
);
```

Search uses `messages_fts`.

### tool_calls

```sql
CREATE TABLE tool_calls (
  id           TEXT PRIMARY KEY,
  message_uuid TEXT,
  session_id   TEXT,
  name         TEXT,
  input_json   TEXT,
  file_path    TEXT
);
```

`file_path` is best effort. For Codex shell and patch tools, Obelisk-Codex prioritizes explicit path fields, patch headers, and tool `workdir` before falling back to session cwd.

### tool_results

```sql
CREATE TABLE tool_results (
  tool_use_id TEXT PRIMARY KEY,
  message_uuid TEXT,
  session_id TEXT,
  content TEXT,
  file_path TEXT,
  is_error INTEGER DEFAULT 0
);
```

`is_error` comes from explicit failed status/error fields or non-zero shell exit output.

### summaries

```sql
CREATE TABLE summaries (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  timestamp TEXT,
  source TEXT,       -- context_compacted, task_complete, turn_context, agent_spawn_failed
  content TEXT
);
```

### subagents, workflows, workflow_agents

Codex spawned-agent calls are reconstructed from `spawn_agent`, `wait_agent`, and `close_agent`.

```sql
CREATE TABLE subagents (
  agent_id TEXT PRIMARY KEY,
  session_id TEXT,
  parent_tool_use_id TEXT,
  agent_type TEXT,
  description TEXT,
  duration_ms INTEGER,
  total_tokens INTEGER
);

CREATE TABLE workflows (
  run_id TEXT PRIMARY KEY,         -- codex:<sessionId>
  session_id TEXT,
  task_id TEXT,
  script TEXT,
  result_json TEXT,
  timestamp TEXT,
  agent_count INTEGER DEFAULT 0
);

CREATE TABLE workflow_agents (
  agent_id TEXT PRIMARY KEY,
  run_id TEXT,
  session_id TEXT,
  agent_type TEXT,
  description TEXT
);
```

### memories

Registered markdown memories. The markdown file at `path` is the durable content; `summary` is the compact English retrieval text.

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  project TEXT,
  message_start TEXT,
  message_end TEXT,
  path TEXT,
  summary TEXT,
  created_at TEXT
);
```

Indexes exist for `project`, `session_id`, and `created_at`.

### Key Relationships

```text
sessions.id        <-- messages.session_id
sessions.id        <-- tool_calls.session_id
sessions.id        <-- tool_results.session_id
sessions.id        <-- summaries.session_id
sessions.id        <-- subagents.session_id
sessions.id        <-- workflows.session_id
sessions.id        <-- memories.session_id
messages.uuid      <-- tool_calls.message_uuid
messages.uuid      <-- tool_results.message_uuid
messages.uuid      <-- memories.message_start / memories.message_end
workflows.run_id   <-- workflow_agents.run_id
```

## 2. Query API Reference

### `search(text, opts?)`

Full-text search across indexed messages and tool records.

Opts: `{ limit, sessionId, project, after, before, cwd }`

- `project` is SQL `LIKE` over `sessions.project`.
- `cwd` is SQL `LIKE` over `messages.cwd`.
- Returns `rank` from FTS5; lower rank sorts earlier.
- `search()` passes raw FTS syntax through. For punctuation-heavy strings, pass a valid FTS phrase yourself or use scoped SQL `LIKE`.

### `context(uuid)`

Returns `{ message, parentChain, neighbors, session, subagent, workflow }`.

Codex parent chains are usually unavailable. Use `neighbors` for local context.

### `sql(query, ...params)`

Read-only SQL escape hatch. Only `SELECT` and `WITH` are allowed; mutating/admin SQL is rejected.

Common joins:

```sql
tool_calls tc
JOIN messages m ON m.uuid = tc.message_uuid
JOIN sessions s ON s.id = tc.session_id
```

### `overview(opts?)`

Compact orientation map. `opts` may be a project string, number limit, or object.

```js
const map = overview({ project: '%Obelisk%', limit: 5, memoryLimit: 5 });
return {
  current: map.current,
  current_project: map.current_project,
  totals: map.totals,
};
```

Returns:

```js
{
  current: { cwd, project },
  current_project: {
    project, project_path, session_total, memory_total,
    sessions: [{ id, title, project, project_path, started_at, ended_at, git_branch, message_count }],
    memories: [{ id, path, summary, session_id, project, created_at }]
  },
  projects: [{ project, project_path, session_count, memory_count, last_session_at, last_memory_at, recent_branches }],
  totals: { projects, sessions, memories }
}
```

`overview()` is a map, not proof. Confirm facts with `memories()`, `search()`, helpers, or SQL.

### `memories(opts?)`

Recall memory layer records, newest first.

Opts: `{ query, project, sessionId, sessions, after, before, branch, limit }`

- `query` filters `summary` and `path` using English terms.
- Hyphens and underscores are treated as spaces.
- CJK text in `query` is rejected to keep memory retrieval language-stable.

```js
return memories({
  project: '%Obelisk%',
  query: 'persistent Codex memory layer',
  limit: 5,
});
```

### `remember(record)`

Available only through `runtime.mjs --remember <script>`.

```js
return remember({
  path: '.obelisk/memories/design-decision.md',
  session_id: 'source-session-id',
  message_start: 'first-message-uuid',
  message_end: 'last-message-uuid',
  summary: 'Decision: keep durable conclusions in markdown memories and index English summaries.'
});
```

Fields:

- `path`: existing markdown file. Relative paths resolve against the source session `project_path` when `session_id` is provided.
- `session_id`: source Codex session.
- `message_start`, `message_end`: optional source evidence range.
- `summary`: required English retrieval summary.
- `project`: optional override; defaults from source session.

`--remember` exposes only `remember()`.

## 3. Other Helpers

- `sessions(opts?)` / `recent(n?)`
- `summaries(opts?)`
- `fileHistory(filePath, opts?)`
- `fileSessions(filePath, opts?)`
- `fileEdits(filePath, opts?)`
- `repeatedFiles(opts?)`
- `failures(opts?)`
- `subagents(opts?)`
- `workflows(opts?)`
- `workflowTree(runId)`
- `thread(sessionId)`
- `raw(uuid, opts?)`

## 4. Useful Patterns

Find recent failures:

```js
return failures({ limit: 20 }).map(f => ({
  tool: f.toolCall?.name,
  session: f.session?.title,
  timestamp: f.result?.timestamp,
  output: f.result?.content?.slice(0, 300),
}));
```

Find repeated edits:

```js
return repeatedFiles({ minSessions: 3, limit: 20 }).map(f => ({
  file: f.file_path,
  sessions: f.sessions,
  touches: f.touches,
  last: f.last_touched,
}));
```

Recover raw JSONL beyond indexed truncation:

```js
const hit = search('RAW_SENTINEL_BEGIN', { limit: 1 })[0];
return hit ? raw(hit.message.uuid, { offset: 10000, limit: 5000 }) : null;
```
