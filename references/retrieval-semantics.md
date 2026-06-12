# Obelisk-Codex Retrieval Semantics

Read this before designing a non-trivial query. `pitfalls.md` is only the debug checklist.

## Scope First

Classify the user's request before choosing helpers.

| User signal | Locator mode | Start with | Avoid first |
|-------------|--------------|------------|-------------|
| unclear project/session landscape | orientation | `overview()` | treating overview rows as evidence |
| project name/path, session, cwd, file, time range | scope | `sessions()`, `fileEdits()`, scoped `search()` | all-project FTS |
| workflow, subagent, tool call, summary, edit | artifact | `workflows()`, `subagents()`, `summaries()`, `failures()` | session dumps |
| concept, conclusion, design history, vague memory | semantic | `memories({ query })`, `search()`, bounded facet sweep | `thread()` |

`overview()` is a navigation map, not proof. Confirm facts with `memories()`, `search()`, other helpers, or exact read-only SQL.

Project-like fields are distinct:

- `sessions.project`: Codex cwd normalized to forward slashes, or fallback labels such as `codex` / `archived`.
- `sessions.project_path`: normalized session cwd when available.
- `messages.cwd`: working directory at message/tool-call time.
- helper `project`: SQL `LIKE` over the relevant project field.
- helper `cwd`: SQL `LIKE` over `messages.cwd`.

## Plan Before Probe

For conclusions, broad history, failure investigation, or file evolution, prefer one bounded retrieval script over interactive probing:

1. locate candidates with scope/artifact/semantic helpers;
2. expand only selected hits;
3. dedupe and group in the script;
4. return compact evidence rows plus counts and limits.

## Structure Before Text

Use database shape before asking the model to read long text.

- Count and aggregate in SQL or JS.
- Join metadata from owner tables instead of inventing fields.
- Project compact rows; do not return full sessions, full workflow trees, or complete tool outputs.
- Keep synthesis runtime JSON around 10k-12k chars when possible.
- For file evolution, prefer `fileEdits()` and group by session.

Ordering semantics:

- `sessions()`, `memories()`, `summaries()`, `workflows()`, and `failures()` are newest first.
- `fileHistory()` is newest first in Obelisk-Codex.
- `search().context` is temporal neighbors, not causal parent-chain context.
- `context(uuid)` is the usual focused expansion point.

## Evidence Before Conclusion

Build a task-local evidence view:

```js
{
  query_plan: { mode, scope, facets, limits },
  prior_memories: [
    { id, path, session_id, created_at, summary }
  ],
  evidence: [
    { type, id, session_id, timestamp, facet, snippet }
  ],
  omitted: 0
}
```

Memory recall is English-indexed: translate non-English user requests into concise English query terms before calling `memories({ query })`. Memory summaries registered with `remember()` are also English, regardless of the conversation language.

After synthesis, offer to write a memory only when the result is durable, useful in future sessions, and not already covered by `prior_memories`.

## FTS Search Semantics

`search(text)` passes text directly to SQLite FTS5 and lets syntax errors surface. For punctuation-heavy literals, pass a valid FTS phrase yourself. For exact literal punctuation under a known scope, SQL `LIKE` can be more exact.
