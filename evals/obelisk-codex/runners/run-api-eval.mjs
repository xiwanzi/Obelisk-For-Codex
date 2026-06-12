#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildFixtureHome, appendFixtureLines } from './run-fixture-build.mjs';
import { judgeAnswer } from '../judges/judge-answer.mjs';
import { judgeQueryHygiene } from '../judges/judge-query-hygiene.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const runtimePath = path.join(repoRoot, 'scripts', 'runtime.mjs');
const itemsPath = path.join(repoRoot, 'evals', 'obelisk-codex', 'data', 'synthetic', 'items.jsonl');
const tmpRoot = path.join(repoRoot, 'evals', 'obelisk-codex', '.tmp');
const prismDir = process.env.PRISM_DIR || String.raw`C:\Users\34545\.agents\skills\prism`;

function parseArgs(argv) {
  const out = { lane: 'all', stage: 'baseline', reportDir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--lane') out.lane = argv[++i];
    else if (arg === '--stage') out.stage = argv[++i];
    else if (arg === '--report-dir') out.reportDir = path.resolve(argv[++i]);
  }
  return out;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function js(value) {
  return JSON.stringify(value);
}

function queryForItem(item) {
  const finish = `
function finish(out) {
  out.result_chars = JSON.stringify(out).length;
  return out;
}
function callEvidence(call, type = 'tool_call') {
  return {
    type,
    id: call.id || call.tool_use_id,
    session_id: call.session_id,
    message_uuid: call.message_uuid,
    tool_call_id: call.id || call.tool_use_id,
    file_path: call.file_path,
    timestamp: call.timestamp,
    snippet: String(call.input_json || call.content || '').slice(0, 240)
  };
}
`;

  switch (item.id) {
    case 'apply-patch-doc-false-positive':
      return `${finish}
const actualPath = ${js(String.raw`C:\Fixture\Obelisk\src\actual.ts`)};
const fakePath = ${js(String.raw`C:\Fixture\Obelisk\docs\fake-mentioned.md`)};
const actual = fileEdits(actualPath, { limit: 10 });
const fake = fileEdits(fakePath, { limit: 10 });
const evidence = actual.flatMap((s) => s.tool_calls.map((c) => callEvidence({ ...c, session_id: s.session.id, file_path: actualPath })));
return finish({
  answer: \`实际 edit 是 \${actualPath}；docs/fake-mentioned.md 没有被当作 edit，fake_hits=\${fake.length}。\`,
  evidence,
  used_apis: ['fileEdits'],
  query_notes: '直接用 fileEdits 对实际路径和正文提到的假路径做 bounded 对照，每个查询 limit=10。',
  uncertainty: fake.length ? ['假路径也被索引为 edit，疑似 false positive。'] : []
});`;

    case 'powershell-write':
      return `${finish}
const target = ${js(String.raw`C:\Fixture\Obelisk\notes\plan.md`)};
const rows = fileEdits(target, { limit: 10 });
const evidence = rows.flatMap((s) => s.tool_calls.map((c) => callEvidence({ ...c, session_id: s.session.id, file_path: target })));
return finish({
  answer: \`PowerShell Set-Content 实际写入了 \${target}。\`,
  evidence,
  used_apis: ['fileEdits'],
  query_notes: '使用 fileEdits 的 write-mode helper 验证 PowerShell 写路径，limit=10。',
  uncertainty: rows.length ? [] : ['没有找到 high-confidence write 记录。']
});`;

    case 'failure-true-positive':
      return `${finish}
const rows = failures({ limit: 20 });
const target = rows.find((r) => String(r.result?.content || '').includes('FAIL_TRUE_SENTINEL')) || rows[0];
const evidence = target ? [callEvidence(target.result, 'tool_result')] : [];
return finish({
  answer: target ? \`真实失败是 \${target.result.tool_use_id}，输出包含 Exit code: 1。\` : '没有找到真实失败。',
  evidence,
  used_apis: ['failures'],
  query_notes: '优先使用 failures({ limit: 20 })，只检查被 indexer 标记为失败的 tool result。',
  uncertainty: target ? [] : ['没有 failure row。']
});`;

    case 'failure-false-positive':
      return `${finish}
const failed = failures({ limit: 20 });
const hits = search('FALSE_POSITIVE_ERROR_SENTINEL', { limit: 5 });
const evidence = hits.map((h) => ({
  type: h.message.role === 'tool_result' ? 'tool_result' : 'message',
  id: h.message.uuid,
  session_id: h.session.id,
  message_uuid: h.message.uuid,
  timestamp: h.message.timestamp,
  snippet: h.message.text.slice(0, 240)
}));
return finish({
  answer: \`没有真实失败；相关工具输出是 Exit code: 0，failure_rows=\${failed.length}。\`,
  evidence,
  used_apis: ['failures', 'search'],
  query_notes: '先用 failures({ limit: 20 }) 检查结构化失败，再用精确 sentinel search 找到讨论 error 的输出。',
  uncertainty: failed.length ? ['存在 failure row，需要人工确认是否误判。'] : []
});`;

    case 'summary-context':
      return `${finish}
const sums = summaries({ limit: 10 }).filter((s) => String(s.content || '').includes('SUMMARY_CONTEXT_SENTINEL'));
const summary = sums[0];
const hits = summary ? search('SCHEMA_SAFE_SQL_DECISION', { sessionId: summary.session_id, limit: 5 }) : [];
const ctx = hits[0] ? context(hits[0].message.uuid) : null;
const evidence = [];
if (summary) evidence.push({ type: 'summary', id: summary.id, session_id: summary.session_id, timestamp: summary.timestamp, snippet: summary.content.slice(0, 200) });
for (const h of hits) evidence.push({ type: 'message', id: h.message.uuid, session_id: h.session.id, message_uuid: h.message.uuid, timestamp: h.message.timestamp, snippet: h.message.text.slice(0, 240) });
return finish({
  answer: 'summary 只是入口；结构化消息证据显示 schema-safe SQL 必须使用占位符和 LIMIT。',
  evidence,
  used_apis: ['summaries', 'search', 'context'],
  query_notes: '先用 summaries({ limit: 10 }) 找入口，再按 sessionId 做精确 search，并对 hit 调 context。',
  uncertainty: ctx ? [] : ['没有找到 nearby context。']
});`;

    case 'raw-recovery':
      return `${finish}
const hit = search('RAW_SENTINEL_BEGIN', { limit: 1 })[0];
const chunk = hit ? raw(hit.message.uuid, { offset: 10000, limit: 5000 }) : null;
const foundTail = chunk ? chunk.text.includes('RAW_SENTINEL_TAIL') : false;
return finish({
  answer: foundTail ? \`raw() 找回 RAW_SENTINEL_TAIL；totalLength=\${chunk.totalLength}，hasMore=\${chunk.hasMore}，raw hasMore 或 totalLength 证明原文超过索引文本。\` : '没有用 raw() 找回 RAW_SENTINEL_TAIL。',
  evidence: hit && chunk ? [{ type: 'raw', id: hit.message.uuid, session_id: hit.session.id, message_uuid: hit.message.uuid, snippet: chunk.text.slice(0, 240) }] : [],
  used_apis: ['search', 'raw'],
  query_notes: '先用 search 定位长 tool result 的 indexed 前缀，再对具体 uuid 调 raw(offset=10000, limit=5000)。',
  uncertainty: foundTail ? [] : ['raw chunk 中没有 tail sentinel。']
});`;

    case 'fts-punctuation-path':
      return `${finish}
const target = ${js(String.raw`C:\Fixture\Obelisk\中文路径\a:b\file.ts`)};
const ftsPhrase = '"' + target.replace(/"/g, '""') + '"';
let hits = [];
let error = null;
try {
  hits = search(ftsPhrase, { limit: 5 });
} catch (e) {
  error = e.message;
}
const evidence = hits.map((h) => ({ type: 'message', id: h.message.uuid, session_id: h.session.id, message_uuid: h.message.uuid, timestamp: h.message.timestamp, snippet: h.message.text.slice(0, 240) }));
return finish({
  answer: hits.length ? \`找到了路径 \${target}。\` : \`没有找到路径 \${target}。\`,
  evidence,
  used_apis: ['search'],
  query_notes: '调用端显式把 punctuation-heavy Windows path 包成 FTS phrase；search() 不做静默 fallback。',
  uncertainty: error ? [\`search error: \${error}\`] : (hits.length ? [] : ['search 返回空结果。'])
});`;

    case 'spawned-agents-workflow':
      return `${finish}
const runs = workflows({ limit: 10 });
const run = runs.find((w) => w.run_id === 'codex:spawned-agents-workflow-session') || runs[0];
const tree = run ? workflowTree(run.run_id) : null;
const agents = tree?.agents || [];
const evidence = [];
if (run) evidence.push({ type: 'workflow', id: run.run_id, session_id: run.session_id, timestamp: run.timestamp, snippet: String(run.result_json || '').slice(0, 200) });
for (const a of agents) {
  const snippet = String(a.description || '') + ' ' + (a.conclusions || []).map((c) => c.text).join(' ');
  evidence.push({ type: 'subagent', id: a.agent_id, session_id: a.session_id, snippet: snippet.slice(0, 240) });
}
return finish({
  answer: agents.length ? 'Parser agent 结论是保留 raw JSONL relationships，并引用 structured ids。' : '没有找到 spawned agent 结论。',
  evidence,
  used_apis: ['workflows', 'workflowTree'],
  query_notes: '用 workflows({ limit: 10 }) 缩小到 workflow-like run，再对 run_id 调 workflowTree。',
  uncertainty: agents.length ? [] : ['没有 workflow agents。']
});`;

    case 'no-evidence':
      return `${finish}
const hits = search('NO_SUCH_OBELISK_HISTORY_SENTINEL_404', { limit: 5 });
return finish({
  answer: hits.length ? '找到了证据，不能判定为不存在。' : '没有找到证据；不能声称已经实现 NO_SUCH_OBELISK_HISTORY_SENTINEL_404。',
  evidence: [],
  used_apis: ['search'],
  query_notes: '对唯一 sentinel 做 bounded search({ limit: 5 })；无 hit 时只陈述未找到证据。',
  uncertainty: hits.length ? ['存在 hit，需要人工复核。'] : ['只能证明当前 fixture 中未找到证据。']
});`;

    case 'repeated-files':
      return `${finish}
const target = ${js(String.raw`C:\Fixture\Obelisk\src\shared.ts`)};
const rows = repeatedFiles({ minSessions: 2, limit: 10 });
const row = rows.find((r) => String(r.file_path).replace(/\\//g, '\\\\') === target);
return finish({
  answer: row ? \`\${target} 在多个 sessions 中被反复修改，sessions=\${row.sessions}。\` : '没有找到 repeated file。',
  evidence: row ? [{ type: 'file', id: row.file_path, file_path: row.file_path, snippet: JSON.stringify(row).slice(0, 240) }] : [],
  used_apis: ['repeatedFiles'],
  query_notes: '使用 repeatedFiles({ minSessions: 2, limit: 10 }) 聚合跨 session edit。',
  uncertainty: row ? [] : ['目标文件未进入 repeatedFiles 结果。']
});`;

    case 'search-cwd-rank':
      return `${finish}
const hits = search('CWD_RANK_SENTINEL', { cwd: '%SubProject%', limit: 10 });
const rankNumeric = hits.every((h) => typeof h.rank === 'number');
const subOnly = hits.every((h) => String(h.message.cwd || '').includes('SubProject'));
const evidence = hits.map((h) => ({
  type: 'message',
  id: h.message.uuid,
  session_id: h.session.id,
  message_uuid: h.message.uuid,
  timestamp: h.message.timestamp,
  snippet: \`rank=\${h.rank}; cwd=\${h.message.cwd}; text=\${h.message.text.slice(0, 160)}\`
}));
return finish({
  answer: \`\${rankNumeric ? 'rank is numeric' : 'rank missing'}; \${subOnly ? 'SubProject only' : 'cwd filter leaked'}; hits=\${hits.length}.\`,
  evidence,
  used_apis: ['search'],
  query_notes: '使用 search(term, { cwd: \"%SubProject%\", limit: 10 }) 验证 FTS rank 返回和 cwd LIKE 过滤。',
  uncertainty: rankNumeric && subOnly && hits.length ? [] : ['rank 或 cwd filter 不符合预期。']
});`;

    case 'sql-readonly-guard':
      return `${finish}
let selectAllowed = false;
let deleteRejected = false;
let pragmaRejected = false;
try { selectAllowed = sql('SELECT COUNT(*) AS n FROM sessions')[0]?.n >= 0; } catch {}
try { sql('DELETE FROM sessions'); } catch { deleteRejected = true; }
try { sql('PRAGMA table_info(messages)'); } catch { pragmaRejected = true; }
return finish({
  answer: \`\${selectAllowed ? 'SELECT allowed' : 'SELECT blocked'}; \${deleteRejected ? 'DELETE rejected' : 'DELETE allowed'}; \${pragmaRejected ? 'PRAGMA rejected' : 'PRAGMA allowed'}.\`,
  evidence: [{ type: 'sql', id: 'readonly-guard', snippet: JSON.stringify({ selectAllowed, deleteRejected, pragmaRejected }) }],
  used_apis: ['sql'],
  query_notes: '分别 probe SELECT、DELETE 和 PRAGMA；非只读语句必须被 sql() guard 拒绝。',
  uncertainty: selectAllowed && deleteRejected && pragmaRejected ? [] : ['read-only guard 结果异常。']
});`;

    default:
      throw new Error(`No query template for item: ${item.id}`);
  }
}

function runRuntime(querySource, home, opts = {}) {
  const queryPath = path.join(opts.queryDir || tmpRoot, `query-${crypto.randomUUID()}.mjs`);
  fs.mkdirSync(path.dirname(queryPath), { recursive: true });
  fs.writeFileSync(queryPath, querySource, 'utf8');
  const env = { ...process.env };
  if (home) {
    env.USERPROFILE = home;
    env.HOME = home;
  }
  const result = spawnSync(process.execPath, [runtimePath, '--query', queryPath], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: opts.timeout || 20000,
    maxBuffer: 1024 * 1024 * 10,
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout || 'null');
  } catch (e) {
    json = { error: `Failed to parse stdout: ${e.message}`, stdout: result.stdout };
  }
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.message || null,
    stdout: result.stdout,
    stderr: result.stderr,
    json,
    queryPath,
  };
}

function runRememberRuntime(scriptSource, home, opts = {}) {
  const scriptPath = path.join(opts.queryDir || tmpRoot, `remember-${crypto.randomUUID()}.mjs`);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, scriptSource, 'utf8');
  const env = { ...process.env };
  if (home) {
    env.USERPROFILE = home;
    env.HOME = home;
  }
  const result = spawnSync(process.execPath, [runtimePath, '--remember', scriptPath], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: opts.timeout || 20000,
    maxBuffer: 1024 * 1024 * 10,
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout || 'null');
  } catch (e) {
    json = { error: `Failed to parse stdout: ${e.message}`, stdout: result.stdout };
  }
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.message || null,
    stdout: result.stdout,
    stderr: result.stderr,
    json,
    queryPath: scriptPath,
  };
}

function writeMemoryFile(projectRoot, fileName = 'memory-layer.md') {
  const dir = path.join(projectRoot, '.obelisk', 'memories');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, [
    '# Persistent Codex Memory Layer',
    '',
    'Persistent Codex memory layer stores durable conclusions as project markdown and indexes English summaries.',
  ].join('\n'), 'utf8');
  return filePath;
}

function memoryProject(built) {
  return built.projectRoot.replace(/\\/g, '/');
}

function registerMemoryForFixture(built, runRoot, summary = 'Decision: Persistent Codex memory layer stores durable conclusions as project markdown and indexes English summaries.') {
  writeMemoryFile(built.projectRoot);
  const script = `
return remember({
  path: '.obelisk/memories/memory-layer.md',
  session_id: 'memory-layer-session',
  message_start: 'memory-layer-session:2',
  message_end: 'memory-layer-session:3',
  summary: ${js(summary)}
});
`;
  return {
    script,
    runtime: runRememberRuntime(script, built.home, { queryDir: runRoot }),
  };
}

function softScore(answerJudge, hygieneJudge) {
  const parts = [
    answerJudge.fact_coverage,
    answerJudge.evidence_quality,
    hygieneJudge.bounded_query_hygiene,
    answerJudge.hard_pass ? 1 : 0.5,
    hygieneJudge.hard_pass ? 1 : 0.5,
  ];
  return Number((parts.reduce((a, b) => a + b, 0) / parts.length).toFixed(3));
}

function classifyFailure(item, failures) {
  const text = failures.join('\n');
  if (/search error|missing expected evidence.*fts|missing expected fact.*中文路径/i.test(text)) return 'query_api_ergonomics_failure';
  if (/fileEdits|repeatedFiles|missing expected evidence.*tool_call|missing expected evidence.*file/i.test(text)) return 'indexing_fidelity_failure';
  if (/failure row|Exit code|missing expected evidence.*tool_result/i.test(text)) return 'indexing_fidelity_failure';
  if (/must_use|forbidden|SELECT \*/i.test(text)) return 'bounded_retrieval_failure';
  if (/summary/i.test(text)) return 'skill_guidance_failure';
  if (item.task_type === 'sandbox_safety') return 'evaluator_bug';
  return 'answer_evidence_failure';
}

function finishSpecialItem(item, answer, runtime, querySource) {
  const answerJudge = judgeAnswer({ repoRoot, item, answer, runtime });
  const hygieneJudge = judgeQueryHygiene({ item, querySource, answer });
  const failures = [...answerJudge.failures, ...hygieneJudge.failures];
  return {
    id: item.id,
    lane: 'synthetic',
    hard_pass: failures.length === 0,
    soft_score: softScore(answerJudge, hygieneJudge),
    failure_category: failures.length ? classifyFailure(item, failures) : null,
    failures,
    answer,
    runtime: {
      status: runtime?.status,
      signal: runtime?.signal,
      error: runtime?.error,
      stderr: runtime?.stderr,
    },
    query_source: querySource,
  };
}

function runMemoryRecallItem(item, runRoot) {
  const built = buildFixtureHome(item.fixture, runRoot);
  const registration = registerMemoryForFixture(built, runRoot);
  const project = memoryProject(built);
  const registrationOk = registration.runtime.status === 0;
  const querySource = `
function finish(out) { out.result_chars = JSON.stringify(out).length; return out; }
const project = ${js(project)};
const registrationOk = ${js(registrationOk)};
const prior = memories({ project, query: 'persistent Codex memory layer', limit: 5 });
const hits = search('MEMORY_LAYER_SENTINEL', { project, limit: 5 });
return finish({
  answer: prior.length && hits.length
    ? 'Persistent Codex memory layer recalled from memory and checked against raw session evidence.'
    : 'Persistent Codex memory layer was not fully recalled.',
  evidence: [
    ...prior.map((m) => ({ type: 'memory', id: m.id, session_id: m.session_id, snippet: m.summary })),
    ...hits.map((h) => ({ type: 'message', id: h.message.uuid, session_id: h.session.id, message_uuid: h.message.uuid, snippet: h.message.text.slice(0, 240) })),
  ],
  used_apis: ['remember', 'memories', 'search'],
  query_notes: '先用 --remember 注册项目内 markdown memory，再用 memories({ project, query }) 召回，并用 search() 回查 raw session evidence。',
  uncertainty: registrationOk ? [] : ['memory registration failed']
});
`;
  const runtime = runRuntime(querySource, built.home, { queryDir: runRoot });
  return finishSpecialItem(item, runtime.json, runtime, `${registration.script}\n${querySource}`);
}

function runRememberRegistrationItem(item, runRoot) {
  const built = buildFixtureHome(item.fixture, runRoot);
  writeMemoryFile(built.projectRoot);
  const typeProbeScript = 'return { rememberType: typeof remember, sqlType: typeof sql, searchType: typeof search };';
  const typeProbe = runRememberRuntime(typeProbeScript, built.home, { queryDir: runRoot });
  const registration = registerMemoryForFixture(built, runRoot);
  const missingScript = `
return remember({
  path: '.obelisk/memories/missing.md',
  session_id: 'memory-layer-session',
  summary: 'Decision: This should fail because the markdown file does not exist.'
});
`;
  const missing = runRememberRuntime(missingScript, built.home, { queryDir: runRoot });
  const answer = {
    answer: [
      `rememberType=${typeProbe.json?.rememberType}`,
      `sqlType=${typeProbe.json?.sqlType}`,
      missing.status !== 0 || missing.json?.error ? 'missing file rejected' : 'missing file allowed',
      registration.runtime.json?.id ? `registered ${registration.runtime.json.id}` : 'registration failed',
    ].join('; '),
    evidence: registration.runtime.json?.id ? [{ type: 'memory', id: registration.runtime.json.id, session_id: 'memory-layer-session', snippet: registration.runtime.json.path }] : [],
    used_apis: ['remember'],
    query_notes: '--remember runtime 只暴露 remember()；relative path 按 source session project_path 解析；不存在 markdown 文件时应失败。',
    uncertainty: registration.runtime.status === 0 && (missing.status !== 0 || missing.json?.error) ? [] : ['remember runtime behavior unexpected'],
    result_chars: 0,
  };
  answer.result_chars = JSON.stringify(answer).length;
  return finishSpecialItem(item, answer, registration.runtime, `${typeProbeScript}\n${registration.script}\n${missingScript}`);
}

function runMemoryCjkGuardrailItem(item, runRoot) {
  const built = buildFixtureHome(item.fixture, runRoot);
  writeMemoryFile(built.projectRoot, 'cjk.md');
  const querySource = `
function finish(out) { out.result_chars = JSON.stringify(out).length; return out; }
let queryError = null;
try { memories({ query: '中文记忆', limit: 1 }); } catch (e) { queryError = e.message; }
return finish({
  answer: queryError ? 'memories query rejected CJK.' : 'memories query allowed CJK.',
  evidence: [],
  used_apis: ['memories'],
  query_notes: '直接调用 memories({ query: 中文 })，应由英文索引 guardrail 拒绝。',
  uncertainty: queryError ? [] : ['CJK query was not rejected']
});
`;
  const queryRuntime = runRuntime(querySource, built.home, { queryDir: runRoot });
  const rememberScript = `
return remember({
  path: '.obelisk/memories/cjk.md',
  session_id: 'memory-layer-session',
  summary: '中文摘要应该被拒绝'
});
`;
  const rememberRuntime = runRememberRuntime(rememberScript, built.home, { queryDir: runRoot });
  const queryRejected = /rejected CJK/.test(queryRuntime.json?.answer || '');
  const rememberRejected = rememberRuntime.status !== 0 || rememberRuntime.json?.error;
  const answer = {
    answer: [
      queryRejected ? 'memories query rejected CJK' : 'memories query allowed CJK',
      rememberRejected ? 'remember summary rejected CJK' : 'remember summary allowed CJK',
    ].join('; '),
    evidence: [],
    used_apis: ['memories', 'remember'],
    query_notes: '分别验证 memories query 和 remember summary 的 English-only guardrail。',
    uncertainty: queryRejected && rememberRejected ? [] : ['CJK guardrail behavior unexpected'],
    result_chars: 0,
  };
  answer.result_chars = JSON.stringify(answer).length;
  return finishSpecialItem(item, answer, rememberRuntime, `${querySource}\n${rememberScript}`);
}

function runOverviewProjectMapItem(item, runRoot) {
  const built = buildFixtureHome(item.fixture, runRoot);
  const registration = registerMemoryForFixture(built, runRoot);
  const project = memoryProject(built);
  const registrationOk = registration.runtime.status === 0;
  const querySource = `
function finish(out) { out.result_chars = JSON.stringify(out).length; return out; }
const project = ${js(project)};
const registrationOk = ${js(registrationOk)};
const map = overview({ project, limit: 5, memoryLimit: 5 });
const prior = memories({ project, query: 'persistent Codex memory layer', limit: 5 });
const hits = search('MEMORY_LAYER_SENTINEL', { project, limit: 5 });
const cp = map.current_project || { sessions: [], memories: [], session_total: 0, memory_total: 0 };
return finish({
  answer: \`overview session_total=\${cp.session_total}; memory_total=\${cp.memory_total}; raw evidence \${hits.length ? 'confirmed' : 'missing'}.\`,
  evidence: [
    ...cp.sessions.map((s) => ({ type: 'session', id: s.id, session_id: s.id, snippet: s.title })),
    ...prior.map((m) => ({ type: 'memory', id: m.id, session_id: m.session_id, snippet: m.summary })),
    ...hits.map((h) => ({ type: 'message', id: h.message.uuid, session_id: h.session.id, message_uuid: h.message.uuid, snippet: h.message.text.slice(0, 240) })),
  ],
  used_apis: ['overview', 'memories', 'search'],
  query_notes: 'overview({ project }) 只做 orientation；事实用 memories() 和 search() 复核。',
  uncertainty: registrationOk && cp.session_total === 1 && cp.memory_total === 1 && hits.length ? [] : ['overview map incomplete']
});
`;
  const runtime = runRuntime(querySource, built.home, { queryDir: runRoot });
  return finishSpecialItem(item, runtime.json, runtime, `${registration.script}\n${querySource}`);
}

function runSyntheticItem(item, runRoot) {
  if (item.id === 'memory-recall') return runMemoryRecallItem(item, runRoot);
  if (item.id === 'remember-registration') return runRememberRegistrationItem(item, runRoot);
  if (item.id === 'memory-cjk-guardrail') return runMemoryCjkGuardrailItem(item, runRoot);
  if (item.id === 'overview-project-map') return runOverviewProjectMapItem(item, runRoot);
  if (item.id === 'incremental-indexing') return runIncrementalItem(item, runRoot);
  if (item.id === 'sandbox-safety') return runSandboxItem(item, runRoot);

  const built = buildFixtureHome(item.fixture, runRoot);
  const querySource = queryForItem(item);
  const runtime = runRuntime(querySource, built.home, { queryDir: runRoot });
  const answer = runtime.json;
  const answerJudge = judgeAnswer({ repoRoot, item, answer, runtime });
  const hygieneJudge = judgeQueryHygiene({ item, querySource, answer });
  const failures = [...answerJudge.failures, ...hygieneJudge.failures];
  return {
    id: item.id,
    lane: 'synthetic',
    hard_pass: failures.length === 0,
    soft_score: softScore(answerJudge, hygieneJudge),
    failure_category: failures.length ? classifyFailure(item, failures) : null,
    failures,
    answer,
    runtime: {
      status: runtime.status,
      signal: runtime.signal,
      error: runtime.error,
      stderr: runtime.stderr,
    },
    query_source: querySource,
  };
}

function runIncrementalItem(item, runRoot) {
  const built = buildFixtureHome(item.fixture, runRoot);
  const countQuery = `
function finish(out) { out.result_chars = JSON.stringify(out).length; return out; }
const rows = sql('SELECT uuid, session_id FROM messages ORDER BY uuid LIMIT 50');
const dupes = sql('SELECT uuid, COUNT(*) n FROM messages GROUP BY uuid HAVING n > 1 LIMIT 20');
const sessionRows = sessions({ limit: 5 });
return finish({ rows, dupes, sessions: sessionRows, used_apis: ['sql', 'sessions'], query_notes: 'COUNT via bounded SQL with LIMIT 50 plus sessions({ limit: 5 }).', evidence: sessionRows.map((s) => ({ type: 'session', id: s.id, session_id: s.id, snippet: String(s.message_count) })) });
`;
  const first = runRuntime(countQuery, built.home, { queryDir: runRoot });
  appendFixtureLines(item.fixture, built.home);
  const second = runRuntime(countQuery, built.home, { queryDir: runRoot });
  const firstCount = first.json?.rows?.length ?? -1;
  const secondCount = second.json?.rows?.length ?? -1;
  const duplicates = second.json?.dupes?.length ?? -1;
  const answer = {
    answer: `first_count=${firstCount}; second_count=${secondCount}; duplicates=${duplicates}`,
    evidence: second.json?.evidence || [],
    used_apis: ['sql', 'sessions'],
    query_notes: '先构建 fixture，记录 message row 数；append JSONL 后再次调用真实 runtime/indexer，并用 bounded SQL 检查 uuid duplicate。',
    uncertainty: duplicates ? ['发现重复 uuid。'] : [],
    result_chars: 0,
  };
  answer.result_chars = JSON.stringify(answer).length;
  const answerJudge = judgeAnswer({ repoRoot, item, answer, runtime: second });
  const hygieneJudge = judgeQueryHygiene({ item, querySource: countQuery, answer });
  const failures = [...answerJudge.failures, ...hygieneJudge.failures];
  return {
    id: item.id,
    lane: 'synthetic',
    hard_pass: failures.length === 0,
    soft_score: softScore(answerJudge, hygieneJudge),
    failure_category: failures.length ? classifyFailure(item, failures) : null,
    failures,
    answer,
    runtime: { first: { status: first.status, error: first.error }, second: { status: second.status, error: second.error } },
    query_source: countQuery,
  };
}

function runSandboxItem(item, runRoot) {
  const built = buildFixtureHome(item.fixture, runRoot);
  const probes = [
    { id: 'process', query: 'return typeof process' },
    { id: 'require', query: 'return typeof require' },
    { id: 'fs', query: 'return typeof fs' },
    { id: 'loop', query: 'while (true) {}' },
  ];
  const results = {};
  for (const probe of probes) {
    results[probe.id] = runRuntime(probe.query, built.home, { queryDir: runRoot, timeout: probe.id === 'loop' ? 2500 : 10000 });
  }
  const processUnavailable = results.process.json === 'undefined';
  const requireUnavailable = results.require.json === 'undefined';
  const fsUnavailable = results.fs.json === 'undefined';
  const loopBlocked = results.loop.error || results.loop.status !== 0 || results.loop.signal;
  const answer = {
    answer: [
      processUnavailable ? 'process unavailable' : 'process available',
      requireUnavailable ? 'require unavailable' : 'require available',
      fsUnavailable ? 'fs unavailable' : 'fs available',
      loopBlocked ? 'loop blocked' : 'loop not blocked',
    ].join('; '),
    evidence: [],
    used_apis: ['runtime-sandbox'],
    query_notes: '对 process/require/fs 使用 typeof probe；无限循环由 runtime/child timeout 阻断。',
    uncertainty: loopBlocked ? [] : ['无限循环没有被阻断。'],
    result_chars: 0,
  };
  answer.result_chars = JSON.stringify(answer).length;
  const answerJudge = judgeAnswer({ repoRoot, item, answer, runtime: results.loop });
  const hygieneJudge = judgeQueryHygiene({ item, querySource: probes.map((p) => p.query).join('\n'), answer });
  const failures = [...answerJudge.failures, ...hygieneJudge.failures];
  return {
    id: item.id,
    lane: 'synthetic',
    hard_pass: failures.length === 0,
    soft_score: softScore(answerJudge, hygieneJudge),
    failure_category: failures.length ? classifyFailure(item, failures) : null,
    failures,
    answer,
    runtime: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { status: v.status, signal: v.signal, error: v.error, json: v.json }])),
    query_source: probes.map((p) => `// ${p.id}\n${p.query}`).join('\n'),
  };
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function runLocalSmoke(reportDir) {
  const codexDir = path.join(os.homedir(), '.codex');
  if (!fs.existsSync(codexDir)) {
    return { lane: 'local', skipped: true, reason: `${codexDir} does not exist`, needs_human_review: true };
  }
  const query = `
const counts = {
  sessions: sql('SELECT COUNT(*) n FROM sessions')[0]?.n || 0,
  messages: sql('SELECT COUNT(*) n FROM messages')[0]?.n || 0,
  tool_calls: sql('SELECT COUNT(*) n FROM tool_calls')[0]?.n || 0,
  failures: sql('SELECT COUNT(*) n FROM tool_results WHERE is_error=1')[0]?.n || 0,
  summaries: sql('SELECT COUNT(*) n FROM summaries')[0]?.n || 0,
  workflows: sql('SELECT COUNT(*) n FROM workflows')[0]?.n || 0,
  memories: sql('SELECT COUNT(*) n FROM memories')[0]?.n || 0
};
const map = overview({ limit: 3, memoryLimit: 3 });
return {
  counts,
  recent_sessions: sessions({ limit: 3 }).map((s) => ({ id: s.id, project: s.project, started_at: s.started_at, ended_at: s.ended_at, message_count: s.message_count })),
  failures: failures({ limit: 5 }).map((f) => ({ tool: f.toolCall?.name, session_id: f.session?.id, content_chars: String(f.result?.content || '').length, is_error: f.result?.is_error })),
  repeated_files: repeatedFiles({ minSessions: 2, limit: 5 }).map((f) => ({ file_path: f.file_path, sessions: f.sessions, touches: f.touches })),
  workflows: workflows({ limit: 5 }).map((w) => ({ run_id: w.run_id, session_id: w.session_id, agent_count: w.agent_count })),
  overview: {
    totals: map.totals,
    current_project: map.current_project ? {
      project: map.current_project.project,
      project_path: map.current_project.project_path,
      session_total: map.current_project.session_total,
      memory_total: map.current_project.memory_total,
    } : null,
    projects: (map.projects || []).map((p) => ({ project: p.project, project_path: p.project_path, session_count: p.session_count, memory_count: p.memory_count })),
  }
};
`;
  const runtime = runRuntime(query, null, { queryDir: reportDir, timeout: 120000 });
  if (runtime.status !== 0 || runtime.error || runtime.json?.error) {
    return { lane: 'local', skipped: true, reason: runtime.error || runtime.json?.error || runtime.stderr, needs_human_review: true };
  }
  const raw = runtime.json;
  return {
    lane: 'local',
    skipped: false,
    needs_human_review: true,
    privacy: 'redacted: no titles, snippets, raw JSONL, private paths, or tool outputs saved',
    counts: raw.counts,
    recent_sessions: (raw.recent_sessions || []).map((s) => ({
      id_hash: hash(s.id),
      project_hash: hash(s.project),
      started_at: s.started_at,
      ended_at: s.ended_at,
      message_count: s.message_count,
    })),
    failures: (raw.failures || []).map((f) => ({
      tool: f.tool,
      session_hash: hash(f.session_id),
      content_chars: f.content_chars,
      is_error: f.is_error,
    })),
    repeated_files: (raw.repeated_files || []).map((f) => ({
      file_hash: hash(f.file_path),
      sessions: f.sessions,
      touches: f.touches,
    })),
    workflows: (raw.workflows || []).map((w) => ({
      run_hash: hash(w.run_id),
      session_hash: hash(w.session_id),
      agent_count: w.agent_count,
    })),
    overview: raw.overview ? {
      totals: raw.overview.totals,
      current_project: raw.overview.current_project ? {
        project_hash: hash(raw.overview.current_project.project),
        project_path_hash: hash(raw.overview.current_project.project_path),
        session_total: raw.overview.current_project.session_total,
        memory_total: raw.overview.current_project.memory_total,
      } : null,
      projects: (raw.overview.projects || []).map((p) => ({
        project_hash: hash(p.project),
        project_path_hash: hash(p.project_path),
        session_count: p.session_count,
        memory_count: p.memory_count,
      })),
    } : null,
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function writePrismReport({ reportDir, stage, summary, results, local }) {
  const hardPct = summary.synthetic_items ? Math.round((summary.synthetic_hard_pass / summary.synthetic_items) * 100) : 0;
  const topFailures = results.filter((r) => !r.hard_pass).slice(0, 8);
  const template = `<!-- lang: zh-CN -->
<h1>Obelisk For Codex ${escapeHtml(stage)} Benchmark Report</h1>

<p-decision status="${summary.synthetic_failures ? 'exploring' : 'approved'}" verdict="${summary.synthetic_failures ? '需要 candidate' : 'Baseline captured'}">
  <template #title>${summary.synthetic_failures ? '已保存 baseline，存在可迭代失败' : '已保存 baseline，synthetic lane 全部 hard pass'}</template>
  <p>本报告由真实 <code>scripts/runtime.mjs</code>、真实 indexer 和 query API 生成。当前报告不是合并许可。</p>
</p-decision>

<p-metrics>
  <p-metric value="${summary.synthetic_items}" label="synthetic items"></p-metric>
  <p-metric value="${summary.synthetic_hard_pass}" label="hard pass" delta="${hardPct}%"></p-metric>
  <p-metric value="${summary.synthetic_soft_score}" label="soft score"></p-metric>
  <p-metric value="${local?.skipped ? 'skipped' : 'run'}" label="local lane"></p-metric>
</p-metrics>

<hr>

<h2>范围</h2>
<p>Benchmark 覆盖 synthetic fixture lane 和可用时的 local smoke lane。Local lane 只保存 hash 与计数，不保存私有原文。</p>

<p-collapse title="运行元数据" open>
  <p-kv :items="[{ key: 'stage', value: '${escapeHtml(stage)}' }, { key: 'commit', value: '${escapeHtml(summary.git_commit)}' }, { key: 'git_status', value: '${escapeHtml(summary.git_status)}' }, { key: 'report_dir', value: '${escapeHtml(reportDir)}' }]"></p-kv>
</p-collapse>

<hr>

<h2>Synthetic 结果</h2>
<p>Hard pass 要求事实、证据 identifier、bounded query 和输出预算同时满足。</p>

<p-bars>
  <p-bar label="hard pass" value="${summary.synthetic_hard_pass}" :percent="${hardPct}" color="success"></p-bar>
  <p-bar label="fail" value="${summary.synthetic_failures}" :percent="${100 - hardPct}" color="${summary.synthetic_failures ? 'danger' : 'success'}"></p-bar>
</p-bars>

<p-collapse title="Top failures">
  ${topFailures.length ? `<table><thead><tr><th>item</th><th>category</th><th>failure</th></tr></thead><tbody>${topFailures.map((r) => `<tr><td><code>${escapeHtml(r.id)}</code></td><td>${escapeHtml(r.failure_category)}</td><td>${escapeHtml(r.failures.join('; '))}</td></tr>`).join('')}</tbody></table>` : '<p>没有 synthetic hard failure。</p>'}
</p-collapse>

<hr>

<h2>Local 隐私处理</h2>
<p>Local lane 不写入 title、snippet、raw JSONL、私有路径或 tool output。所有 session/project/file/workflow identifier 都会 hash。</p>

<p-collapse title="Local lane 摘要">
  <p-code file="local-redacted-summary.json"><pre><code>${escapeHtml(JSON.stringify(local || {}, null, 2))}</code></pre></p-code>
</p-collapse>

<hr>

<h2>结论</h2>
<p>Baseline 已经保存。后续 candidate 必须隔离保存 patch、before/after delta、guardian report 和 merge proposal。</p>

<p-callout type="warning" icon="!">
  <p><strong>MERGE STATUS:</strong> NOT MERGED — WAITING FOR MARUKO APPROVAL</p>
</p-callout>
`;
  const templatePath = path.join(reportDir, 'template.html');
  fs.writeFileSync(templatePath, template, 'utf8');
  fs.writeFileSync(path.join(reportDir, 'prism-report.md'), template, 'utf8');

  const buildScript = path.join(prismDir, 'build.js');
  if (fs.existsSync(buildScript)) {
    const built = spawnSync(process.execPath, [buildScript, templatePath, path.join(reportDir, 'index.html')], {
      cwd: prismDir,
      encoding: 'utf8',
      timeout: 20000,
    });
    fs.writeFileSync(path.join(reportDir, 'prism-build.log'), `${built.stdout || ''}${built.stderr || ''}`, 'utf8');
  } else {
    fs.writeFileSync(path.join(reportDir, 'PRISM_SKILL_UNAVAILABLE.txt'), `PRISM_SKILL_UNAVAILABLE: missing ${buildScript}\n`, 'utf8');
  }
}

function gitInfo() {
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--short', '--branch'], { cwd: repoRoot, encoding: 'utf8' });
  return {
    commit: commit.status === 0 ? commit.stdout.trim() : 'not-a-git-repo',
    status: status.status === 0 ? status.stdout.trim() : 'git-status-unavailable',
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ts = timestamp();
  const reportDir = args.reportDir || path.join(repoRoot, 'evals', 'obelisk-codex', 'reports', `${args.stage}-${ts}`);
  const runRoot = path.join(tmpRoot, `${args.stage}-${ts}`);
  fs.mkdirSync(reportDir, { recursive: true });
  fs.mkdirSync(runRoot, { recursive: true });

  const results = [];
  if (args.lane === 'all' || args.lane === 'synthetic') {
    for (const item of readJsonl(itemsPath)) {
      results.push(runSyntheticItem(item, runRoot));
    }
  }

  let local = null;
  if (args.lane === 'all' || args.lane === 'local') {
    local = runLocalSmoke(reportDir);
  }

  const git = gitInfo();
  const syntheticItems = results.length;
  const syntheticHardPass = results.filter((r) => r.hard_pass).length;
  const syntheticFailures = syntheticItems - syntheticHardPass;
  const syntheticSoftScore = syntheticItems
    ? Number((results.reduce((sum, r) => sum + r.soft_score, 0) / syntheticItems).toFixed(3))
    : 0;
  const failureCategories = {};
  for (const result of results.filter((r) => !r.hard_pass)) {
    failureCategories[result.failure_category || 'unknown'] = (failureCategories[result.failure_category || 'unknown'] || 0) + 1;
  }
  const summary = {
    stage: args.stage,
    timestamp: ts,
    report_dir: reportDir,
    git_commit: git.commit,
    git_status: git.status,
    synthetic_items: syntheticItems,
    synthetic_hard_pass: syntheticHardPass,
    synthetic_failures: syntheticFailures,
    synthetic_soft_score: syntheticSoftScore,
    failure_categories: failureCategories,
    local_lane: local ? { skipped: local.skipped, needs_human_review: local.needs_human_review, counts: local.counts || null } : null,
    merge_status: 'NOT MERGED — WAITING FOR MARUKO APPROVAL',
  };

  writeJson(path.join(reportDir, 'raw-results.json'), { synthetic: results, local });
  writeJson(path.join(reportDir, 'summary.json'), summary);
  writeJson(path.join(reportDir, 'failures.json'), results.filter((r) => !r.hard_pass).map((r) => ({
    id: r.id,
    category: r.failure_category,
    failures: r.failures,
  })));
  writePrismReport({ reportDir, stage: args.stage, summary, results, local });

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

main();
