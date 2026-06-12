# Obelisk-Codex Query Patterns

Copy these patterns into `runtime.mjs --query` scripts and adapt the scope. Keep results compact and evidence-bearing.

## First Pass: Overview + Recall + Evidence

Use this for broad synthesis before custom SQL.

```js
const topic = 'English topic terms translated from the user request';
const map = overview({ limit: 6 });
const project = map.current.project?.project;
const scoped = project ? { project } : {};

return {
  query_plan: {
    mode: 'first_pass',
    topic,
    project: project || null,
    limits: { sessions: 6, memories: 5, search: 8 },
  },
  orientation: map.current_project && {
    project: map.current_project.project,
    session_total: map.current_project.session_total,
    sessions: map.current_project.sessions.map(s => ({
      id: s.id,
      title: s.title,
      ended_at: s.ended_at,
    })),
    memory_total: map.current_project.memory_total,
    memories: map.current_project.memories.map(m => ({
      id: m.id,
      path: m.path,
      summary: m.summary?.slice(0, 240),
    })),
  },
  prior_memories: memories({ ...scoped, query: topic, limit: 5 }).map(m => ({
    id: m.id,
    path: m.path,
    session_id: m.session_id,
    created_at: m.created_at,
    summary: m.summary?.slice(0, 260),
  })),
  session_evidence: search(topic.replace(/[-_]/g, ' '), { ...scoped, limit: 8 })
    .slice(0, 6)
    .map(h => ({
      session_id: h.session.id,
      session_title: h.session.title,
      uuid: h.message.uuid,
      timestamp: h.message.timestamp,
      snippet: h.message.text?.slice(0, 220),
    })),
};
```

## Memory Plus Raw Evidence

Use memory as prior notes. Confirm with raw session evidence when correctness matters.

```js
const project = '%Obelisk%';
const topic = 'persistent Codex memory layer';

return {
  prior_memories: memories({ project, query: topic, limit: 5 }).map(m => ({
    id: m.id,
    path: m.path,
    session_id: m.session_id,
    message_start: m.message_start,
    message_end: m.message_end,
    summary: m.summary?.slice(0, 260),
  })),
  evidence: search(topic, { project, limit: 8 }).map(h => ({
    session_id: h.session.id,
    uuid: h.message.uuid,
    timestamp: h.message.timestamp,
    snippet: h.message.text?.slice(0, 220),
  })),
};
```

## Register Approved Memory

Use only after the user approves writing memory and the markdown file already exists. Run with `runtime.mjs --remember <script>`.

```js
return remember({
  path: '.obelisk/memories/memory-layer-design.md',
  session_id: 'source-session-id',
  message_start: 'first-message-uuid',
  message_end: 'last-message-uuid',
  summary: [
    'Decision: Obelisk-Codex queries both memory records and raw Codex sessions.',
    'Memory records are prior notes and must be checked against raw evidence when correctness matters.',
    'New memory writes require explicit user approval before registration.',
  ].join(' '),
});
```

## Bounded Search To Context

```js
const hits = search('"runtime query"', { project: '%Obelisk%', limit: 8 });
return hits.slice(0, 5).map(h => {
  const c = context(h.message.uuid);
  return {
    session_id: h.session.id,
    session_title: h.session.title,
    uuid: h.message.uuid,
    timestamp: h.message.timestamp,
    snippet: h.message.text?.slice(0, 240),
    neighbors: (c?.neighbors || []).slice(0, 4).map(m => ({
      uuid: m.uuid,
      role: m.role,
      snippet: m.text?.slice(0, 120),
    })),
  };
});
```

## File Evolution

```js
const rows = fileEdits('C:\\Mod\\project\\src\\shared.ts', { limit: 20 });
return rows.map(s => ({
  session_id: s.session.id,
  title: s.session.title,
  touches: s.touches,
  first_touched: s.first_touched,
  last_touched: s.last_touched,
  examples: s.tool_calls.slice(0, 3).map(c => ({
    id: c.id,
    tool: c.name,
    timestamp: c.timestamp,
  })),
}));
```
