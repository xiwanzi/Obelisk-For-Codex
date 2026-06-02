# obelisk-codex schema

Database location: `~/.codex/obelisk-codex.sqlite`

Data sources:

- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/archived_sessions/*.jsonl`
- `~/.codex/session_index.jsonl` for thread titles

The database keeps the original Obelisk table names so existing query snippets stay familiar, but the indexed records come from Codex JSONL events.

## sessions

One row per Codex JSONL session.

```sql
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,  -- Codex session id
  title         TEXT,              -- session_index thread_name or first user message
  project       TEXT,              -- usually cwd, normalized to forward slashes
  project_path  TEXT,              -- original cwd when available
  started_at    TEXT,
  ended_at      TEXT,
  git_branch    TEXT,              -- currently usually NULL for Codex logs
  version       TEXT,              -- Codex CLI/app version when available
  message_count INTEGER DEFAULT 0,
  jsonl_path    TEXT
);
```

Common queries:

```js
sessions({ limit: 10 })
sessions({ project: '%wiki维护%' })
sessions({ after: '2026-06-01', limit: 20 })
```

## messages

Indexed Codex records. UUIDs are synthetic: `<sessionId>:<lineNumber>`.

```sql
CREATE TABLE messages (
  uuid          TEXT PRIMARY KEY,
  session_id    TEXT,
  type          TEXT,              -- user, assistant, reasoning, tool_call, tool_result
  parent_uuid   TEXT,              -- usually NULL in Codex logs
  timestamp     TEXT,
  role          TEXT,              -- user, assistant, assistant:final, tool_call, tool_result
  text          TEXT,
  model         TEXT,
  is_sidechain  INTEGER DEFAULT 0,
  agent_id      TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER
);
```

Codex mapping:

- `event_msg:user_message` -> `type='user'`, `role='user'`
- `event_msg:agent_message` -> `type='assistant'`, `role='assistant'` or `assistant:<phase>`
- `response_item:reasoning` -> `type='reasoning'`, `role='assistant_reasoning'`
- `response_item:function_call` / `custom_tool_call` / `tool_search_call` -> `type='tool_call'`
- `response_item:function_call_output` / `custom_tool_call_output` / `tool_search_output` -> `type='tool_result'`

Search uses `messages_fts`:

```js
search('TACZ wiki')
search('"Exit code" AND sync_public_wiki', { limit: 20 })
```

## tool_calls

One row per indexed Codex tool call when possible.

```sql
CREATE TABLE tool_calls (
  id           TEXT PRIMARY KEY,   -- Codex call_id
  message_uuid TEXT,
  session_id   TEXT,
  name         TEXT,               -- shell_command, apply_patch, tool_search_call, js, view_image...
  input_json   TEXT,
  file_path    TEXT                -- best-effort extraction
);
```

`file_path` is reliable when the tool input explicitly contains `file_path` or `path`. For PowerShell commands and `apply_patch`, Obelisk-Codex extracts candidates, normalizes paths, and filters common runtime/tool paths such as Python, Node, adb, cache directories, wildcard image paths, and real directories.

Examples:

```js
sql(`
  SELECT name, COUNT(*) n
  FROM tool_calls
  GROUP BY name
  ORDER BY n DESC
  LIMIT 20
`)
```

```js
fileHistory('C:\\Mod\\wiki维护\\sync_public_wiki.py', { limit: 20 })
fileSessions('C:\\Mod\\wiki维护\\sync_public_wiki.py', { limit: 20 })
repeatedFiles({ minSessions: 3, limit: 20 })
```

`fileSessions()` groups by session and includes `tool_calls` for the matching file path so the answer can cite which command or patch touched the file.
Use `{ mode: 'write' }` or `fileEdits()` when the user asks where a file was modified rather than merely read or searched. The write-mode heuristic treats `apply_patch`, common file-writing tools, and common PowerShell write/move/delete commands as high-confidence edits.
For `apply_patch`, file extraction uses patch headers first so paths mentioned inside documentation examples do not get indexed as edited files.

## tool_results

Tool outputs linked by `call_id`.

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

`is_error` is inferred from explicit failed statuses, error fields, or output containing `Exit code: <non-zero>`.

```js
failures({ limit: 20 })
```

## summaries

Compaction and task-completion summaries.

```sql
CREATE TABLE summaries (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  timestamp TEXT,
  source TEXT,       -- context_compacted, task_complete, turn_context
  content TEXT
);
```

```js
summaries({ limit: 20 })
summaries({ sessionId: '019e...' })
```

## Codex Multi-Agent Tables

These tables are retained from upstream Obelisk and populated from Codex multi-agent tool calls:

- `spawn_agent` creates agent metadata
- `wait_agent` records agent conclusions
- `close_agent` records final previous status when available
- a Codex session with spawned agents becomes one workflow-like run: `run_id = "codex:<sessionId>"`

### subagents

```sql
CREATE TABLE subagents (
  agent_id TEXT PRIMARY KEY,
  session_id TEXT,
  parent_tool_use_id TEXT, -- spawn_agent call_id
  agent_type TEXT,
  description TEXT,       -- nickname + first line of spawn task
  duration_ms INTEGER,
  total_tokens INTEGER
);
```

`subagents()` adds:

- `messageCount`
- `latestConclusion`

### workflows

```sql
CREATE TABLE workflows (
  run_id TEXT PRIMARY KEY,
  session_id TEXT,
  task_id TEXT,
  script TEXT,            -- session title
  result_json TEXT,       -- source, completed_agents, failed_agents
  timestamp TEXT,
  agent_count INTEGER DEFAULT 0
);
```

### workflow_agents

```sql
CREATE TABLE workflow_agents (
  agent_id TEXT PRIMARY KEY,
  run_id TEXT,
  session_id TEXT,
  agent_type TEXT,
  description TEXT
);
```

`workflowTree(runId)` returns `{ workflow, result, agents }`. Each agent includes:

- `subagent`
- `messages`
- `conclusions`

## API Notes

- `context(uuid)` returns `message`, `session`, `parentChain`, and `neighbors`. `neighbors` is the useful context source for Codex because parent UUID chains are usually unavailable.
- `trace(uuid)` usually returns only the selected message unless parent links are present.
- `raw(uuid, opts?)` parses the synthetic UUID line number and returns a window of the original JSONL line.
- `thread(sessionId)` can be large; use it only after narrowing to the session you need.

## Useful Query Patterns

Recent sessions:

```js
return recent(10).map(s => ({
  id: s.id,
  title: s.title,
  project: s.project,
  ended: s.ended_at
}))
```

Find where a command was run:

```js
return sql(`
  SELECT tc.name, tc.input_json, s.title, m.timestamp
  FROM tool_calls tc
  JOIN messages m ON m.uuid = tc.message_uuid
  JOIN sessions s ON s.id = tc.session_id
  WHERE tc.name = 'shell_command'
    AND tc.input_json LIKE ?
  ORDER BY m.timestamp DESC
  LIMIT 20
`, '%sync_public_wiki%')
```

Find failed commands:

```js
return failures({ limit: 20 }).map(f => ({
  tool: f.toolCall?.name,
  session: f.session?.title,
  timestamp: f.result?.timestamp,
  output: f.result?.content?.slice(0, 500)
}))
```

Find repeated files:

```js
return repeatedFiles({ minSessions: 3, limit: 20 }).map(f => ({
  file: f.file_path,
  sessions: f.sessions,
  touches: f.touches,
  last: f.last_touched
}))
```

`repeatedFiles()` defaults to edit mode. Pass `{ mode: 'touch' }` to include read/search mentions.

Find sessions for a specific file:

```js
return fileSessions('C:\\Mod\\wiki维护\\sync_public_wiki.py', { limit: 20 })
```

Inspect a Codex multi-agent workflow:

```js
const run = workflows({ limit: 1 })[0]
const tree = workflowTree(run.run_id)
return tree.agents.map(a => ({
  agent: a.agent_id,
  task: a.description,
  conclusions: a.conclusions.map(c => c.text)
}))
```
