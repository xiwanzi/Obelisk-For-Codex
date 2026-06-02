import {
  SESSIONS_DIR,
  ARCHIVED_SESSIONS_DIR,
  SESSION_INDEX_PATH,
  openDb,
  trunc,
  truncJson,
  extractText,
  parseMaybeJson,
  filePath,
  isDir,
  readLines,
  fs,
  path,
} from './db.mjs';

const INDEXER_VERSION = 'codex-v5-agents-file-edits';

function walkJsonl(dir, files = []) {
  if (!isDir(dir)) return files;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return files; }
  for (const entry of entries) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(fp, files);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fp);
  }
  return files;
}

function parseSessionId(fp) {
  const base = path.basename(fp, '.jsonl');
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match ? match[1] : base;
}

function discoverJsonlFiles() {
  const files = [];
  for (const fp of walkJsonl(SESSIONS_DIR)) {
    files.push({ path: fp, sessionId: parseSessionId(fp), archived: false });
  }
  for (const fp of walkJsonl(ARCHIVED_SESSIONS_DIR)) {
    files.push({ path: fp, sessionId: parseSessionId(fp), archived: true });
  }
  return files;
}

function needsReindex(db, fp) {
  const mt = fs.statSync(fp).mtimeMs;
  const row = db.prepare('SELECT mtime, lines_processed FROM index_state WHERE jsonl_path = ?').get(fp);
  if (!row) return { needed: true, skip: 0 };
  return mt > row.mtime ? { needed: true, skip: row.lines_processed } : { needed: false, skip: 0 };
}

function readSessionTitles() {
  const titles = new Map();
  if (!fs.existsSync(SESSION_INDEX_PATH)) return titles;
  readLines(SESSION_INDEX_PATH, (line) => {
    try {
      const obj = JSON.parse(line);
      if (obj.id && obj.thread_name) titles.set(obj.id, obj.thread_name);
    } catch {}
  });
  return titles;
}

function normalizeProjectPath(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  return cwd.replace(/\\/g, '/');
}

function projectLabel(cwd, fallback) {
  if (!cwd || typeof cwd !== 'string') return fallback;
  const normalized = normalizeProjectPath(cwd);
  return normalized || fallback;
}

function firstLine(text) {
  if (typeof text !== 'string') return null;
  return text.split(/\r?\n/).map(s => s.trim()).find(Boolean) || null;
}

function dateMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function minTime(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a < b ? a : b;
}

function maxTime(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a > b ? a : b;
}

function messageTextForPayload(payload) {
  if (!payload) return null;
  if (typeof payload.message === 'string') return trunc(payload.message);
  if (Array.isArray(payload.text_elements)) {
    const text = payload.text_elements.map(t => typeof t === 'string' ? t : t?.text).filter(Boolean).join('\n');
    if (text) return trunc(text);
  }
  if (Array.isArray(payload.content)) return extractText(payload.content);
  if (Array.isArray(payload.summary)) return extractText(payload.summary);
  if (typeof payload.summary === 'string') return trunc(payload.summary);
  if (typeof payload.last_agent_message === 'string') return trunc(payload.last_agent_message);
  return null;
}

function toolInput(payload) {
  if (!payload) return null;
  if (payload.arguments !== undefined) return parseMaybeJson(payload.arguments);
  if (payload.input !== undefined) return parseMaybeJson(payload.input);
  if (payload.action !== undefined) return payload.action;
  return null;
}

function toolName(payload) {
  if (!payload) return null;
  if (payload.name) return payload.name;
  if (payload.type === 'tool_search_call') return 'tool_search_call';
  if (payload.type === 'web_search_call') return 'web_search_call';
  if (payload.type === 'web_search_end') return 'web_search';
  if (payload.type === 'patch_apply_end') return 'apply_patch';
  if (payload.type === 'mcp_tool_call_end') return payload.name || 'mcp_tool_call';
  return payload.type || 'tool_call';
}

function outputText(payload) {
  if (!payload) return null;
  if (typeof payload.output === 'string') return trunc(payload.output);
  if (payload.output !== undefined) return truncJson(payload.output);
  if (payload.tools !== undefined) return truncJson(payload.tools);
  if (payload.action !== undefined) return truncJson(payload.action);
  if (payload.error !== undefined) return truncJson(payload.error);
  return truncJson(payload);
}

function isErrorPayload(payload, text) {
  if (!payload) return 0;
  if (payload.is_error || payload.error) return 1;
  if (payload.status && ['failed', 'error', 'errored'].includes(String(payload.status).toLowerCase())) return 1;
  if (typeof text === 'string' && /Exit code:\s*[1-9]/.test(text)) return 1;
  return 0;
}

function insertMessage(ins, sid, msgId, type, ts, role, text, model = null, opts = {}) {
  if (!text) return false;
  ins.msg.run(msgId, sid, type, opts.parentUuid || null, ts, role, trunc(text), model, opts.isSidechain ? 1 : 0, opts.agentId || null, opts.inputTokens || null, opts.outputTokens || null);
  return true;
}

function ensureAgent(agents, agentId, defaults = {}) {
  if (!agentId) return null;
  if (!agents.has(agentId)) {
    agents.set(agentId, {
      agent_id: agentId,
      nickname: null,
      agent_type: 'codex-agent',
      description: null,
      parent_tool_use_id: null,
      started_at: null,
      ended_at: null,
      conclusions: [],
      failed: false,
    });
  }
  const agent = agents.get(agentId);
  for (const [key, value] of Object.entries(defaults)) {
    if (value !== undefined && value !== null && (agent[key] === null || agent[key] === undefined || agent[key] === 'codex-agent')) {
      agent[key] = value;
    }
  }
  return agent;
}

function statusText(status) {
  if (status == null) return null;
  if (typeof status === 'string') return status;
  if (typeof status.completed === 'string') return status.completed;
  if (typeof status.error === 'string') return status.error;
  if (typeof status.failed === 'string') return status.failed;
  return truncJson(status);
}

function statusRole(status) {
  if (status && typeof status === 'object') {
    if (status.completed) return 'subagent_result';
    if (status.error || status.failed) return 'subagent_error';
  }
  return 'subagent_status';
}

function recordAgentConclusion(ins, sm, sid, agents, agentId, status, source, ts, lineNum, model) {
  const text = statusText(status);
  if (!agentId || !text) return;
  const role = statusRole(status);
  const agent = ensureAgent(agents, agentId);
  agent.ended_at = maxTime(agent.ended_at, ts);
  agent.failed = agent.failed || role === 'subagent_error';
  agent.conclusions.push({ source, timestamp: ts, role, text: trunc(text) });
  const msgId = `${sid}:${lineNum}:agent:${agentId}:${source}`;
  if (insertMessage(ins, sid, msgId, 'agent_result', ts, role, text, model, { agentId })) sm.n++;
}

function resetIndexIfVersionChanged(db) {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get('indexer_version');
  if (row?.value === INDEXER_VERSION) return;
  const tables = ['messages_fts', 'messages', 'tool_calls', 'tool_results', 'subagents', 'workflows', 'workflow_agents', 'summaries', 'sessions', 'index_state'];
  for (const table of tables) {
    try { db.prepare(`DELETE FROM ${table}`).run(); } catch {}
  }
  db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)').run('indexer_version', INDEXER_VERSION);
}

function indexJsonl(db, fi, titleBySession) {
  const { needed, skip } = needsReindex(db, fi.path);
  if (!needed) return;
  const mt = fs.statSync(fi.path).mtimeMs;

  const ins = {
    ses: db.prepare('INSERT OR REPLACE INTO sessions (id,title,project,project_path,started_at,ended_at,git_branch,version,message_count,jsonl_path) VALUES (?,?,?,?,?,?,?,?,?,?)'),
    msg: db.prepare('INSERT OR REPLACE INTO messages (uuid,session_id,type,parent_uuid,timestamp,role,text,model,is_sidechain,agent_id,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'),
    tc:  db.prepare('INSERT OR REPLACE INTO tool_calls (id,message_uuid,session_id,name,input_json,file_path) VALUES (?,?,?,?,?,?)'),
    tr:  db.prepare('INSERT OR REPLACE INTO tool_results (tool_use_id,message_uuid,session_id,content,file_path,is_error) VALUES (?,?,?,?,?,?)'),
    sum: db.prepare('INSERT OR REPLACE INTO summaries (id,session_id,timestamp,source,content) VALUES (?,?,?,?,?)'),
    sa:  db.prepare('INSERT OR REPLACE INTO subagents (agent_id,session_id,parent_tool_use_id,agent_type,description,duration_ms,total_tokens) VALUES (?,?,?,?,?,?,?)'),
    wf:  db.prepare('INSERT OR REPLACE INTO workflows (run_id,session_id,task_id,script,result_json,timestamp,agent_count) VALUES (?,?,?,?,?,?,?)'),
    wa:  db.prepare('INSERT OR REPLACE INTO workflow_agents (agent_id,run_id,session_id,agent_type,description) VALUES (?,?,?,?,?)'),
    idx: db.prepare('INSERT OR REPLACE INTO index_state (jsonl_path,mtime,lines_processed) VALUES (?,?,?)'),
  };

  let sid = fi.sessionId;
  const existing = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  const sm = {
    started_at: existing?.started_at || null,
    ended_at: existing?.ended_at || null,
    git_branch: existing?.git_branch || null,
    version: existing?.version || null,
    title: existing?.title || titleBySession.get(sid) || null,
    project: existing?.project || null,
    project_path: existing?.project_path || null,
    model: null,
    n: existing?.message_count || 0,
  };
  const callFiles = new Map();
  const callInfo = new Map();
  const agents = new Map();
  let lastToolCallId = null;
  let lineNum = 0;

  readLines(fi.path, (line) => {
    lineNum++;
    if (lineNum <= skip) return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }

    const payload = obj.payload || {};
    const ptype = payload.type;
    const ts = obj.timestamp || payload.started_at || payload.completed_at || null;
    if (ts && (!sm.started_at || ts < sm.started_at)) sm.started_at = ts;
    if (ts && (!sm.ended_at || ts > sm.ended_at)) sm.ended_at = ts;

    if (obj.type === 'session_meta') {
      if (payload.id && payload.id !== sid) {
        sid = payload.id;
        if (!sm.title) sm.title = titleBySession.get(sid) || null;
      }
      sm.project_path = payload.cwd || sm.project_path;
      sm.project = projectLabel(payload.cwd, fi.archived ? 'archived' : 'codex');
      sm.version = payload.cli_version || sm.version;
      return;
    }

    if (obj.type === 'turn_context') {
      sm.project_path = payload.cwd || sm.project_path;
      sm.project = projectLabel(payload.cwd, sm.project || (fi.archived ? 'archived' : 'codex'));
      sm.model = payload.model || sm.model;
      if (payload.summary) {
        const text = typeof payload.summary === 'string' ? payload.summary : truncJson(payload.summary);
        ins.sum.run(`${sid}:summary:${lineNum}`, sid, ts, 'turn_context', text);
      }
      return;
    }

    const msgId = `${sid}:${lineNum}`;

    if (obj.type === 'event_msg' && ptype === 'task_started') {
      if (payload.started_at && (!sm.started_at || payload.started_at < sm.started_at)) sm.started_at = payload.started_at;
      return;
    }

    if (obj.type === 'event_msg' && ptype === 'user_message') {
      const text = messageTextForPayload(payload);
      if (insertMessage(ins, sid, msgId, 'user', ts, 'user', text, sm.model)) sm.n++;
      if (!sm.title && text) sm.title = text.slice(0, 80);
      return;
    }

    if (obj.type === 'event_msg' && ptype === 'agent_message') {
      const text = messageTextForPayload(payload);
      const role = payload.phase ? `assistant:${payload.phase}` : 'assistant';
      if (insertMessage(ins, sid, msgId, 'assistant', ts, role, text, sm.model)) sm.n++;
      return;
    }

    if (obj.type === 'event_msg' && ptype === 'context_compacted') {
      const text = messageTextForPayload(payload) || truncJson(payload);
      ins.sum.run(`${sid}:compact:${lineNum}`, sid, ts, 'context_compacted', text);
      return;
    }

    if (obj.type === 'event_msg' && ptype === 'task_complete') {
      const text = messageTextForPayload(payload);
      if (text) ins.sum.run(`${sid}:task-complete:${lineNum}`, sid, ts, 'task_complete', text);
      return;
    }

    if (obj.type !== 'response_item') return;

    if (ptype === 'reasoning') {
      const text = messageTextForPayload(payload);
      if (insertMessage(ins, sid, msgId, 'reasoning', ts, 'assistant_reasoning', text, sm.model)) sm.n++;
      return;
    }

    if (ptype === 'message') {
      // Codex also stores model input/output items as response_item.message.
      // The user-visible user/assistant text is indexed from event_msg records above;
      // skipping these avoids duplicating assistant replies and indexing long system prompts.
      return;
    }

    if (['function_call', 'custom_tool_call', 'tool_search_call', 'web_search_call'].includes(ptype)) {
      const id = payload.call_id || `${msgId}:call`;
      const name = toolName(payload);
      const input = toolInput(payload);
      const inputJson = truncJson(input ?? payload);
      const fp = filePath(name, input, { workdir: sm.project_path });
      const text = `${name}\n${inputJson || ''}`.trim();
      insertMessage(ins, sid, msgId, 'tool_call', ts, 'tool_call', text, sm.model);
      sm.n++;
      ins.tc.run(id, msgId, sid, name, inputJson, fp);
      callInfo.set(id, { id, name, input, msgId, timestamp: ts, lineNum });
      if (fp) callFiles.set(id, fp);
      lastToolCallId = id;
      return;
    }

    if (['function_call_output', 'custom_tool_call_output', 'tool_search_output', 'web_search_end', 'patch_apply_end', 'mcp_tool_call_end'].includes(ptype)) {
      const id = payload.call_id || lastToolCallId || `${msgId}:result`;
      const text = outputText(payload);
      insertMessage(ins, sid, msgId, 'tool_result', ts, 'tool_result', text, sm.model);
      sm.n++;
      const fp = callFiles.get(id) || filePath(toolName(payload), payload, { workdir: sm.project_path });
      ins.tr.run(id, msgId, sid, text, fp, isErrorPayload(payload, text));
      const call = callInfo.get(id);
      const rawOutput = parseMaybeJson(payload.output);

      if (call?.name === 'spawn_agent') {
        if (rawOutput && typeof rawOutput === 'object' && rawOutput.agent_id) {
          const desc = firstLine(call.input?.message) || call.input?.description || null;
          ensureAgent(agents, rawOutput.agent_id, {
            nickname: rawOutput.nickname || null,
            agent_type: call.input?.agent_type || 'codex-agent',
            description: desc,
            parent_tool_use_id: id,
            started_at: call.timestamp,
            ended_at: ts,
          });
        } else if (typeof rawOutput === 'string' && rawOutput) {
          ins.sum.run(`${sid}:agent-spawn-failed:${lineNum}`, sid, ts, 'agent_spawn_failed', rawOutput);
        }
      }

      if (call?.name === 'wait_agent' && rawOutput?.status && typeof rawOutput.status === 'object') {
        for (const [agentId, status] of Object.entries(rawOutput.status)) {
          recordAgentConclusion(ins, sm, sid, agents, agentId, status, 'wait_agent', ts, lineNum, sm.model);
        }
      }

      if (call?.name === 'close_agent' && rawOutput?.previous_status) {
        const agentId = call.input?.target;
        recordAgentConclusion(ins, sm, sid, agents, agentId, rawOutput.previous_status, 'close_agent', ts, lineNum, sm.model);
      }
    }
  });

  if (agents.size) {
    const runId = `codex:${sid}`;
    const started = [...agents.values()].reduce((acc, a) => minTime(acc, a.started_at), null) || sm.started_at;
    const ended = [...agents.values()].reduce((acc, a) => maxTime(acc, a.ended_at), null) || sm.ended_at;
    const completed = [...agents.values()].filter(a => a.conclusions.length && !a.failed).length;
    const failed = [...agents.values()].filter(a => a.failed).length;
    ins.wf.run(runId, sid, null, sm.title || 'Codex multi-agent session', JSON.stringify({
      source: 'codex_multi_agent',
      completed_agents: completed,
      failed_agents: failed,
      started_at: started,
      ended_at: ended,
    }), started, agents.size);
    for (const agent of agents.values()) {
      const startMs = dateMs(agent.started_at);
      const endMs = dateMs(agent.ended_at);
      const duration = startMs !== null && endMs !== null && endMs >= startMs ? endMs - startMs : null;
      const desc = agent.nickname ? `[${agent.nickname}] ${agent.description || ''}`.trim() : agent.description;
      ins.sa.run(agent.agent_id, sid, agent.parent_tool_use_id, agent.agent_type, trunc(desc || ''), duration, null);
      ins.wa.run(agent.agent_id, runId, sid, agent.agent_type, trunc(desc || ''));
    }
  }

  if (!sm.title) sm.title = titleBySession.get(sid) || path.basename(fi.path, '.jsonl');
  if (!sm.project) sm.project = fi.archived ? 'archived' : 'codex';
  ins.ses.run(sid, sm.title, sm.project, normalizeProjectPath(sm.project_path), sm.started_at, sm.ended_at, sm.git_branch, sm.version, sm.n, fi.path);
  ins.idx.run(fi.path, mt, lineNum);
}

function indexSessionTitles(db, titleBySession) {
  for (const [id, title] of titleBySession.entries()) {
    db.prepare('UPDATE sessions SET title=? WHERE id=? AND (title IS NULL OR title = id)').run(title, id);
  }
}

function buildIndex() {
  const db = openDb();
  resetIndexIfVersionChanged(db);
  const files = discoverJsonlFiles();
  const titleBySession = readSessionTitles();
  for (const f of files) {
    db.exec('BEGIN');
    try {
      indexJsonl(db, f, titleBySession);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      process.stderr.write(`Warning: failed to index ${f.path}: ${e.message}\n`);
    }
  }
  db.exec('BEGIN');
  try {
    indexSessionTitles(db, titleBySession);
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    process.stderr.write(`Warning: failed to finalize index: ${e.message}\n`);
  }
  db.close();
}

export { buildIndex };
