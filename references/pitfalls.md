# Obelisk-Codex Pitfalls

Use this after a query error, suspicious empty result, over-large output, or unclear helper row shape.

## Missing Columns And Wrong Aliases

Common wrong guesses:

- Summaries: use `source` and `content`; do not use `summary_type` or `text`.
- Tool call name: use `tool_calls.name`. `tool_name` is only an alias if you create it.
- Tool call timestamps: join `messages m ON m.uuid = tc.message_uuid`.
- Tool result timestamps: join `messages m ON m.uuid = tr.message_uuid`.
- Codex parent chains are usually empty; use `neighbors` from `context()` for local context.

When uncertain:

```js
const rows = summaries({ limit: 1 });
return rows.length ? Object.keys(rows[0]) : [];
```

## FTS5 Syntax Errors

`search(text)` supports raw SQLite FTS5 syntax and does not rewrite invalid queries. For punctuation-heavy literals, pass a valid FTS phrase yourself, or use scoped SQL `LIKE` when literal punctuation is important:

```js
sql(`
  SELECT m.uuid, s.id AS session_id, s.title, substr(m.text,1,180) AS snippet
  FROM messages m
  JOIN sessions s ON s.id = m.session_id
  WHERE s.project LIKE ?
    AND m.text LIKE ?
  ORDER BY m.timestamp DESC
  LIMIT 10
`, '%Obelisk%', '%workflow-script%');
```

## Over-Large Runtime JSON

Fix the query instead of reading huge stdout in chunks.

- Lower `LIMIT`.
- Shorten snippets to 160-240 chars.
- Group in SQL/JS and return counts plus sparse examples.
- For `workflowTree()`, omit full messages unless explicitly needed.
- Use `raw(uuid, { offset, limit })` only after identifying one message UUID.

## Empty Results

An empty array can be the correct answer for exact scopes or sentinel checks. Do not broaden to all projects unless the user asks or your query plan explicitly marks a fallback.

## Memory Guardrails

- `memories({ query })` requires English terms.
- `remember().summary` must be English.
- `remember()` validates that the markdown file already exists.
- `--remember` exposes only `remember()`, not `sql()`, `search()`, or `memories()`.
