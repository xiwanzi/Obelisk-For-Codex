import { openDb, readLines, fs, path, normalizeFilePath, isLikelyToolPath } from './db.mjs';

function normalizeOpts(optsOrScalar, scalarKey = 'sessionId') {
  if (optsOrScalar == null) return {};
  if (typeof optsOrScalar === 'string') return { [scalarKey]: optsOrScalar };
  if (typeof optsOrScalar === 'number') return { limit: optsOrScalar };
  return optsOrScalar;
}

function buildWhere(opts, aliases) {
  const clauses = [];
  const params = [];
  if (opts.sessionId) { clauses.push(`${aliases.sessionId} = ?`); params.push(opts.sessionId); }
  if (opts.sessions?.length) {
    clauses.push(`${aliases.sessionId} IN (${opts.sessions.map(() => '?').join(',')})`);
    params.push(...opts.sessions);
  }
  if (opts.project) { clauses.push(`${aliases.project} LIKE ?`); params.push(opts.project); }
  if (opts.after) { clauses.push(`${aliases.timestamp} > ?`); params.push(opts.after); }
  if (opts.before) { clauses.push(`${aliases.timestamp} < ?`); params.push(opts.before); }
  if (opts.branch) { clauses.push(`${aliases.branch} = ?`); params.push(opts.branch); }
  return { where: clauses.length ? clauses.join(' AND ') : '1=1', params };
}

const BASH_EXIT_PAT = 'Exit code [1-9]%';

function pathVariants(fp) {
  const values = new Set();
  if (typeof fp === 'string' && fp.trim()) values.add(fp.trim());
  const normalized = normalizeFilePath(fp);
  if (normalized) values.add(normalized);
  return [...values];
}

function mutationSql(alias = 'tc') {
  const name = `LOWER(${alias}.name)`;
  const input = `LOWER(COALESCE(${alias}.input_json,''))`;
  return `(
    ${name} IN ('apply_patch','write_file','edit_file','create_file','delete_file','move_file','rename_file')
    OR (${name} = 'shell_command' AND (
      ${input} LIKE '%set-content%'
      OR ${input} LIKE '%add-content%'
      OR ${input} LIKE '%out-file%'
      OR ${input} LIKE '%new-item%'
      OR ${input} LIKE '%remove-item%'
      OR ${input} LIKE '%move-item%'
      OR ${input} LIKE '%copy-item%'
      OR ${input} LIKE '%rename-item%'
      OR ${input} LIKE '%[io.file]::write%'
      OR ${input} LIKE '%git apply%'
    ))
  )`;
}

function createQueryApi(db) {
  const q = (sql, ...p) => db.prepare(sql).all(...p);

  const search = (text, opts = {}) => {
    const { limit = 20, sessionId, project, after, before } = opts;
    let where = 'WHERE mf.text MATCH ?';
    const p = [text];
    if (sessionId) { where += ' AND mf.session_id=?'; p.push(sessionId); }
    if (project)   { where += ' AND s.project=?';     p.push(project); }
    if (after)     { where += ' AND m.timestamp>?';    p.push(after); }
    if (before)    { where += ' AND m.timestamp<?';    p.push(before); }
    p.push(limit);
    const rows = db.prepare(`
      SELECT m.uuid,m.session_id,m.text,m.role,m.timestamp,m.model,
             s.id as s_id,s.title as s_title,s.project as s_project,s.started_at as s_started
      FROM messages_fts mf JOIN messages m ON m.uuid=mf.uuid LEFT JOIN sessions s ON s.id=m.session_id
      ${where} ORDER BY rank LIMIT ?`).all(...p);
    return rows.map(r => {
      const ctx = db.prepare(
        'SELECT uuid,text,role,timestamp,model FROM messages WHERE session_id=? AND uuid!=? ORDER BY ABS(JULIANDAY(timestamp)-JULIANDAY(?)) LIMIT 6'
      ).all(r.session_id, r.uuid, r.timestamp).sort((a,b) => a.timestamp < b.timestamp ? -1 : 1);
      return {
        message: { uuid: r.uuid, text: r.text, role: r.role, timestamp: r.timestamp, model: r.model },
        session: { id: r.s_id, title: r.s_title, project: r.s_project, started_at: r.s_started },
        context: ctx,
      };
    });
  };

  const context = (uuid) => {
    const msg = db.prepare('SELECT * FROM messages WHERE uuid=?').get(uuid);
    if (!msg) return null;
    const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(msg.session_id);
    const chain = [];
    let cur = msg;
    while (cur?.parent_uuid) { cur = db.prepare('SELECT * FROM messages WHERE uuid=?').get(cur.parent_uuid); if (cur) chain.unshift(cur); }
    const neighbors = db.prepare(
      'SELECT * FROM messages WHERE session_id=? AND uuid!=? ORDER BY ABS(JULIANDAY(timestamp)-JULIANDAY(?)) LIMIT 10'
    ).all(msg.session_id, uuid, msg.timestamp).sort((a,b) => a.timestamp < b.timestamp ? -1 : 1);
    let subagent = msg.agent_id ? db.prepare('SELECT * FROM subagents WHERE agent_id=?').get(msg.agent_id) : null;
    let workflow = null;
    if (msg.agent_id) {
      const wa = db.prepare('SELECT * FROM workflow_agents WHERE agent_id=?').get(msg.agent_id);
      if (wa) workflow = db.prepare('SELECT * FROM workflows WHERE run_id=?').get(wa.run_id);
    }
    return { message: msg, parentChain: chain, neighbors, session, subagent, workflow };
  };

  const trace = (uuid) => {
    const chain = [];
    let cur = db.prepare('SELECT * FROM messages WHERE uuid=?').get(uuid);
    while (cur) { chain.unshift(cur); cur = cur.parent_uuid ? db.prepare('SELECT * FROM messages WHERE uuid=?').get(cur.parent_uuid) : null; }
    return chain;
  };

  const thread = (sid) => db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY timestamp').all(sid);

  const subagents = (optsOrSid) => {
    const opts = normalizeOpts(optsOrSid);
    const { limit = 100 } = opts;
    const needsJoin = opts.project || opts.branch;
    const { where, params } = buildWhere(opts, { sessionId: 'sa.session_id', project: 's.project', timestamp: 'sa.session_id', branch: 's.git_branch' });
    params.push(limit);
    const join = needsJoin ? 'LEFT JOIN sessions s ON s.id=sa.session_id' : '';
    return db.prepare(`SELECT sa.* FROM subagents sa ${join} WHERE ${where} LIMIT ?`).all(...params).map(r => {
      const c = db.prepare('SELECT COUNT(*) as c FROM messages WHERE agent_id=?').get(r.agent_id);
      const latest = db.prepare("SELECT uuid,role,text,timestamp FROM messages WHERE agent_id=? AND type='agent_result' ORDER BY timestamp DESC LIMIT 1").get(r.agent_id);
      return { ...r, messageCount: c?.c || 0, latestConclusion: latest || null };
    });
  };

  const workflows = (optsOrSid) => {
    const opts = normalizeOpts(optsOrSid);
    const { limit = 100 } = opts;
    const needsJoin = opts.project || opts.branch;
    const { where, params } = buildWhere(opts, { sessionId: 'w.session_id', project: 's.project', timestamp: 'w.timestamp', branch: 's.git_branch' });
    params.push(limit);
    const join = needsJoin ? 'LEFT JOIN sessions s ON s.id=w.session_id' : '';
    return db.prepare(`SELECT w.* FROM workflows w ${join} WHERE ${where} ORDER BY w.timestamp DESC LIMIT ?`).all(...params);
  };

  const workflowTree = (runId) => {
    const wf = db.prepare('SELECT * FROM workflows WHERE run_id=?').get(runId);
    if (!wf) return null;
    const agents = db.prepare('SELECT * FROM workflow_agents WHERE run_id=?').all(runId).map(a => ({
      ...a,
      subagent: db.prepare('SELECT * FROM subagents WHERE agent_id=?').get(a.agent_id) || null,
      messages: db.prepare('SELECT * FROM messages WHERE agent_id=? ORDER BY timestamp').all(a.agent_id),
      conclusions: db.prepare("SELECT uuid,role,text,timestamp FROM messages WHERE agent_id=? AND type='agent_result' ORDER BY timestamp").all(a.agent_id),
    }));
    let result = null;
    try { result = wf.result_json ? JSON.parse(wf.result_json) : null; } catch {}
    return { ...wf, workflow: wf, result, agents };
  };

  const fileHistory = (fp, opts = {}) => {
    const { limit = 200, after, before, mode = 'touch' } = opts;
    const variants = pathVariants(fp);
    if (!variants.length) return [];
    let where = `tc.file_path IN (${variants.map(() => '?').join(',')})`;
    const params = [...variants];
    if (after)  { where += ' AND m.timestamp > ?'; params.push(after); }
    if (before) { where += ' AND m.timestamp < ?'; params.push(before); }
    if (mode === 'write') where += ` AND ${mutationSql('tc')}`;
    params.push(limit);
    return db.prepare(
      `SELECT tc.*,s.title as s_title,s.project as s_project,m.timestamp as ts FROM tool_calls tc LEFT JOIN sessions s ON s.id=tc.session_id LEFT JOIN messages m ON m.uuid=tc.message_uuid WHERE ${where} ORDER BY m.timestamp DESC LIMIT ?`
    ).all(...params).map(r => ({
      toolCall: { id: r.id, message_uuid: r.message_uuid, name: r.name, input_json: r.input_json },
      session: { id: r.session_id, title: r.s_title, project: r.s_project },
      timestamp: r.ts,
    }));
  };

  const fileSessions = (fp, opts = {}) => {
    const { limit = 50, after, before, mode = 'touch' } = opts;
    const variants = pathVariants(fp);
    if (!variants.length) return [];
    let where = `tc.file_path IN (${variants.map(() => '?').join(',')})`;
    const params = [...variants];
    if (after)  { where += ' AND m.timestamp > ?'; params.push(after); }
    if (before) { where += ' AND m.timestamp < ?'; params.push(before); }
    if (mode === 'write') where += ` AND ${mutationSql('tc')}`;
    params.push(limit);
    return db.prepare(`
      SELECT tc.file_path, tc.session_id, s.title as s_title, s.project as s_project,
             COUNT(*) as touches, MIN(m.timestamp) as first_touched, MAX(m.timestamp) as last_touched
      FROM tool_calls tc
      LEFT JOIN sessions s ON s.id=tc.session_id
      LEFT JOIN messages m ON m.uuid=tc.message_uuid
      WHERE ${where}
      GROUP BY tc.file_path, tc.session_id
      ORDER BY last_touched DESC
      LIMIT ?`).all(...params).map(r => {
        const calls = db.prepare(`
          SELECT tc.id, tc.message_uuid, tc.name, tc.input_json, m.timestamp
          FROM tool_calls tc
          LEFT JOIN messages m ON m.uuid=tc.message_uuid
          WHERE tc.session_id=? AND tc.file_path=?
            ${mode === 'write' ? `AND ${mutationSql('tc')}` : ''}
          ORDER BY m.timestamp DESC
          LIMIT 20`).all(r.session_id, r.file_path);
        return {
          file_path: r.file_path,
          touches: r.touches,
          first_touched: r.first_touched,
          last_touched: r.last_touched,
          session: { id: r.session_id, title: r.s_title, project: r.s_project },
          tool_calls: calls,
        };
      });
  };

  const fileEdits = (fp, opts = {}) => fileSessions(fp, { ...opts, mode: 'write' });

  const repeatedFiles = (opts = {}) => {
    const { limit = 50, minSessions = 2, project, after, before, mode = 'write' } = opts;
    const clauses = ['tc.file_path IS NOT NULL'];
    const params = [];
    if (project) { clauses.push('s.project LIKE ?'); params.push(project); }
    if (after) { clauses.push('m.timestamp > ?'); params.push(after); }
    if (before) { clauses.push('m.timestamp < ?'); params.push(before); }
    if (mode === 'write') clauses.push(mutationSql('tc'));
    params.push(Math.max(limit * 5, limit));
    const rows = db.prepare(`
      SELECT tc.file_path, COUNT(*) as touches, COUNT(DISTINCT tc.session_id) as sessions,
             MIN(m.timestamp) as first_touched, MAX(m.timestamp) as last_touched
      FROM tool_calls tc
      LEFT JOIN sessions s ON s.id=tc.session_id
      LEFT JOIN messages m ON m.uuid=tc.message_uuid
      WHERE ${clauses.join(' AND ')}
      GROUP BY tc.file_path
      HAVING sessions >= ?
      ORDER BY sessions DESC, touches DESC
      LIMIT ?`).all(...params.slice(0, -1), minSessions, params[params.length - 1]);
    return rows.filter(r => !isLikelyToolPath(r.file_path)).slice(0, limit);
  };

  const failures = (optsOrSid) => {
    const opts = normalizeOpts(optsOrSid);
    const { limit = 50 } = opts;
    const needsJoin = opts.project || opts.branch;
    const { where, params: filterParams } = buildWhere(opts, { sessionId: 'tr.session_id', project: 's.project', timestamp: 'rm.timestamp', branch: 's.git_branch' });
    const join = needsJoin ? 'LEFT JOIN sessions s ON s.id=tr.session_id' : '';
    const errorCond = `(tr.is_error = 1 OR tr.content LIKE '${BASH_EXIT_PAT}')`;
    const allParams = [...filterParams, limit];
    const rows = db.prepare(`SELECT tr.*, rm.timestamp as timestamp FROM tool_results tr ${join} LEFT JOIN messages rm ON rm.uuid=tr.message_uuid WHERE ${errorCond} AND ${where} LIMIT ?`).all(...allParams);
    return rows.map(r => {
      const tc = db.prepare('SELECT * FROM tool_calls WHERE id=?').get(r.tool_use_id);
      const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(r.session_id);
      const rm = db.prepare('SELECT * FROM messages WHERE uuid=?').get(r.message_uuid);
      const next = rm?.timestamp ? db.prepare('SELECT * FROM messages WHERE session_id=? AND timestamp>? ORDER BY timestamp LIMIT 3').all(r.session_id, rm.timestamp) : [];
      return { toolCall: tc, result: r, session, nextMessages: next };
    });
  };

  const sessions = (optsOrN) => {
    const opts = normalizeOpts(optsOrN, 'sessionId');
    const { limit = 50 } = opts;
    const { where, params } = buildWhere(opts, { sessionId: 's.id', project: 's.project', timestamp: 's.started_at', branch: 's.git_branch' });
    params.push(limit);
    return db.prepare(`SELECT * FROM sessions s WHERE ${where} ORDER BY ended_at DESC LIMIT ?`).all(...params);
  };

  const recent = (n = 10) => sessions({ limit: n });

  const summaries = (optsOrSid) => {
    const opts = normalizeOpts(optsOrSid);
    const { limit = 100 } = opts;
    const { where, params } = buildWhere(opts, { sessionId: 'su.session_id', project: 's.project', timestamp: 'su.timestamp', branch: 's.git_branch' });
    params.push(limit);
    return db.prepare(`SELECT su.*, s.title as session_title, s.project FROM summaries su LEFT JOIN sessions s ON s.id=su.session_id WHERE ${where} ORDER BY su.timestamp DESC LIMIT ?`).all(...params);
  };

  const resolveJsonlPath = (messageUuid) => {
    const msg = db.prepare('SELECT session_id, agent_id FROM messages WHERE uuid=?').get(messageUuid);
    if (!msg) return null;
    const ses = db.prepare('SELECT jsonl_path FROM sessions WHERE id=?').get(msg.session_id);
    if (ses) return ses.jsonl_path;
    return null;
  };

  const lineNumberFromUuid = (uuid) => {
    const match = String(uuid).match(/^[^:]+:(\d+)/);
    if (!match) return null;
    const n = Number(match[1]);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  const findRawLine = (jsonlPath, uuid) => {
    if (!jsonlPath || !fs.existsSync(jsonlPath)) return null;
    const lineNumber = lineNumberFromUuid(uuid);
    if (lineNumber) {
      let current = 0;
      let foundByLine = null;
      readLines(jsonlPath, (line) => {
        current++;
        if (current === lineNumber) { foundByLine = line; return false; }
      });
      return foundByLine;
    }
    let found = null;
    readLines(jsonlPath, (line) => {
      if (!line.includes(uuid)) return;
      try { const obj = JSON.parse(line); if (obj.uuid === uuid) { found = line; return false; } } catch {}
    });
    return found;
  };

  const raw = (messageUuid, opts = {}) => {
    const { offset = 0, limit = 10000 } = opts;
    const jsonlPath = resolveJsonlPath(messageUuid);
    const line = findRawLine(jsonlPath, messageUuid);
    if (!line) return null;
    return {
      text: line.slice(offset, offset + limit),
      totalLength: line.length,
      offset,
      limit,
      hasMore: offset + limit < line.length,
    };
  };

  return { sql: q, search, context, trace, thread, subagents, workflows, workflowTree, fileHistory, fileSessions, fileEdits, repeatedFiles, failures, sessions, recent, summaries, raw };
}

export { createQueryApi };
