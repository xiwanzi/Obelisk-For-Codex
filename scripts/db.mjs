import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const CODEX_DIR = path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
const ARCHIVED_SESSIONS_DIR = path.join(CODEX_DIR, 'archived_sessions');
const SESSION_INDEX_PATH = path.join(CODEX_DIR, 'session_index.jsonl');
const DB_PATH = path.join(CODEX_DIR, 'obelisk-codex.sqlite');
const TEXT_LIMIT = 10000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, title TEXT, project TEXT, project_path TEXT,
  started_at TEXT, ended_at TEXT, git_branch TEXT, version TEXT,
  message_count INTEGER DEFAULT 0, jsonl_path TEXT);
CREATE TABLE IF NOT EXISTS messages (
  uuid TEXT PRIMARY KEY, session_id TEXT, type TEXT, parent_uuid TEXT,
  timestamp TEXT, role TEXT, text TEXT, model TEXT,
  is_sidechain INTEGER DEFAULT 0, agent_id TEXT,
  input_tokens INTEGER, output_tokens INTEGER);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY, message_uuid TEXT, session_id TEXT,
  name TEXT, input_json TEXT, file_path TEXT);
CREATE TABLE IF NOT EXISTS tool_results (
  tool_use_id TEXT PRIMARY KEY, message_uuid TEXT, session_id TEXT,
  content TEXT, file_path TEXT, is_error INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS subagents (
  agent_id TEXT PRIMARY KEY, session_id TEXT, parent_tool_use_id TEXT,
  agent_type TEXT, description TEXT, duration_ms INTEGER, total_tokens INTEGER);
CREATE TABLE IF NOT EXISTS workflows (
  run_id TEXT PRIMARY KEY, session_id TEXT, task_id TEXT,
  script TEXT, result_json TEXT, timestamp TEXT, agent_count INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS workflow_agents (
  agent_id TEXT PRIMARY KEY, run_id TEXT, session_id TEXT,
  agent_type TEXT, description TEXT);
CREATE TABLE IF NOT EXISTS index_state (
  jsonl_path TEXT PRIMARY KEY, mtime REAL, lines_processed INTEGER);
CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY, session_id TEXT, timestamp TEXT,
  source TEXT, content TEXT);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY, value TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  uuid UNINDEXED, session_id UNINDEXED, text, content=messages, content_rowid=rowid);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_tc_session_name ON tool_calls(session_id, name);
CREATE INDEX IF NOT EXISTS idx_tc_file ON tool_calls(file_path);
CREATE INDEX IF NOT EXISTS idx_sa_session ON subagents(session_id);
CREATE INDEX IF NOT EXISTS idx_wf_session ON workflows(session_id);
CREATE INDEX IF NOT EXISTS idx_wa_run ON workflow_agents(run_id);
CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id);
`;

function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec(SCHEMA);
  return db;
}

function trunc(s) {
  return typeof s === 'string' && s.length > TEXT_LIMIT ? s.slice(0, TEXT_LIMIT) : s;
}

function truncJson(obj, limit = TEXT_LIMIT) {
  if (obj === null || obj === undefined) return null;
  const walk = (v) => {
    if (typeof v === 'string') return v.length > limit ? v.slice(0, limit) + '...[truncated]' : v;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object' && v !== null) {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(obj));
}

function extractText(content) {
  if (typeof content === 'string') return trunc(content);
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const b of content) {
    if (!b) continue;
    if (typeof b === 'string') parts.push(b);
    else if (typeof b.text === 'string') parts.push(b.text);
    else if (typeof b.input_text === 'string') parts.push(b.input_text);
    else if (typeof b.output_text === 'string') parts.push(b.output_text);
    else if (typeof b.thinking === 'string') parts.push(b.thinking);
  }
  return parts.length ? trunc(parts.join('\n')) : null;
}

function parseMaybeJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function pathsFromPatch(text) {
  if (typeof text !== 'string') return null;
  return [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/gm)].map(m => m[1].trim());
}

function pathsFromText(text) {
  if (typeof text !== 'string') return [];
  const results = [];
  for (const match of text.matchAll(/-(?:LiteralPath|Path)\s+['"]([^'"]+)['"]/gi)) results.push(match[1]);
  for (const match of text.matchAll(/['"]([A-Za-z]:\\[^'"]+)['"]/g)) results.push(match[1]);
  for (const match of text.matchAll(/[A-Za-z]:\\[^\s'"`<>|,;]+/g)) results.push(match[0]);
  for (const match of text.matchAll(/['"]([^'"]+\.[A-Za-z0-9]{1,8})['"]/g)) results.push(match[1]);
  return results;
}

function cleanPathCandidate(candidate) {
  if (typeof candidate !== 'string') return null;
  let value = candidate.trim();
  value = value.replace(/^<|>$/g, '');
  value = value.replace(/[),;]+$/g, '');
  value = value.replace(/^file:/i, '');
  return value || null;
}

function normalizeFilePath(candidate, workdir = null) {
  const cleaned = cleanPathCandidate(candidate);
  if (!cleaned) return null;
  const normalizedSeparators = cleaned.replace(/\//g, '\\');
  const isWindowsAbs = /^[A-Za-z]:\\/.test(normalizedSeparators) || normalizedSeparators.startsWith('\\\\');
  const value = isWindowsAbs
    ? path.win32.normalize(normalizedSeparators)
    : workdir ? path.win32.normalize(path.win32.join(workdir, normalizedSeparators)) : path.win32.normalize(normalizedSeparators);
  return value.replace(/\s+$/g, '');
}

function isLikelyToolPath(candidate) {
  if (!candidate) return true;
  const value = candidate.replace(/\//g, '\\');
  const lower = value.toLowerCase();
  const basename = path.win32.basename(lower);
  if (/[*?]/.test(value)) return true;
  if (/\\\.cache\\codex-runtimes\\/.test(lower)) return true;
  if (/\\\.codex(?:\\)?$/i.test(lower)) return true;
  if (/\\\.codex\\(?:tmp|cache|generated_images|node_repl|process_manager|browser)\\/.test(lower)) return true;
  if (['python.exe', 'node.exe', 'npm.cmd', 'npx.cmd', 'adb.exe', 'java.exe', 'git.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe'].includes(basename)) return true;
  if (/^[A-Za-z]:\\(?:Program|Mod|Users|Windows|Temp)$/i.test(value)) return true;
  const parsed = path.win32.parse(value);
  const parts = value.split('\\').filter(Boolean);
  if (!parsed.ext) {
    try { if (fs.existsSync(value) && fs.statSync(value).isDirectory()) return true; } catch {}
  }
  if (!parsed.ext && /^[A-Za-z]:\\/.test(value) && parts.length <= 3) return true;
  return false;
}

function pathScore(candidate, workdir = null) {
  const value = normalizeFilePath(candidate, workdir);
  if (!value || isLikelyToolPath(value)) return -1;
  let score = 0;
  const ext = path.win32.extname(value);
  if (ext) score += 8;
  if (workdir && value.toLowerCase().startsWith(path.win32.normalize(workdir).toLowerCase())) score += 12;
  if (/\\(?:src|app|scripts|docs|references|tests|prisma|plugin|backend|frontend)\\/i.test(value)) score += 4;
  if (/\.(?:ts|tsx|js|mjs|py|java|kt|json|md|yml|yaml|toml|html|css|scss|vue|sql|ps1|bat)$/i.test(value)) score += 5;
  if (/\.(?:exe|dll|png|jpg|jpeg|webp|gif)$/i.test(value)) score -= 5;
  score += Math.min(value.length / 100, 3);
  return score;
}

function chooseBestPath(candidates, workdir = null) {
  let best = null;
  let bestScore = -1;
  for (const raw of candidates.flat().filter(Boolean)) {
    const normalized = normalizeFilePath(raw, workdir);
    const score = pathScore(normalized, workdir);
    if (score > bestScore) {
      best = normalized;
      bestScore = score;
    }
  }
  return bestScore >= 0 ? best : null;
}

function filePath(name, input, opts = {}) {
  const parsed = parseMaybeJson(input);
  const workdir = opts.workdir || parsed?.workdir || null;
  const candidates = [];
  const patchCandidates = [];
  if (parsed && typeof parsed === 'object') {
    for (const key of ['file_path', 'path', 'patch_path']) {
      if (typeof parsed[key] === 'string') candidates.push(parsed[key]);
    }
    if (typeof parsed.command === 'string') candidates.push(pathsFromText(parsed.command));
    if (typeof parsed.input === 'string') patchCandidates.push(pathsFromPatch(parsed.input));
    if (typeof parsed.patch === 'string') patchCandidates.push(pathsFromPatch(parsed.patch));
  }
  if (name === 'apply_patch') {
    if (typeof parsed === 'string') patchCandidates.push(pathsFromPatch(parsed));
    const patchPath = chooseBestPath(patchCandidates, workdir);
    if (patchPath) return patchPath;
  }
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.input === 'string') candidates.push(pathsFromText(parsed.input));
    if (typeof parsed.patch === 'string') candidates.push(pathsFromText(parsed.patch));
  }
  candidates.push(pathsFromText(parsed));
  return chooseBestPath(candidates, workdir);
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function readLines(filePath, callback) {
  const fd = fs.openSync(filePath, 'r');
  const bufSize = 64 * 1024;
  const buf = Buffer.alloc(bufSize);
  let remainder = '';
  let bytesRead;
  try {
    while ((bytesRead = fs.readSync(fd, buf, 0, bufSize)) > 0) {
      const chunk = remainder + buf.toString('utf8', 0, bytesRead);
      const lines = chunk.split('\n');
      remainder = lines.pop();
      for (const line of lines) {
        if (line && callback(line) === false) return;
      }
    }
    if (remainder) callback(remainder);
  } finally {
    fs.closeSync(fd);
  }
}

export {
  CODEX_DIR,
  SESSIONS_DIR,
  ARCHIVED_SESSIONS_DIR,
  SESSION_INDEX_PATH,
  DB_PATH,
  TEXT_LIMIT,
  openDb,
  trunc,
  truncJson,
  extractText,
  parseMaybeJson,
  normalizeFilePath,
  isLikelyToolPath,
  filePath,
  isDir,
  readLines,
  fs,
  path,
  os,
};
