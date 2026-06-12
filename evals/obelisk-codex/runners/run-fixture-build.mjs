#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureDefinitions, renderJsonlLines } from '../data/synthetic/fixture-definitions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');

export function buildFixtureHome(fixtureId, targetRoot, opts = {}) {
  const def = fixtureDefinitions[fixtureId];
  if (!def) throw new Error(`Unknown fixture: ${fixtureId}`);

  const home = path.join(targetRoot, fixtureId);
  fs.rmSync(home, { recursive: true, force: true });
  const codexDir = path.join(home, '.codex');
  const sessionsDir = path.join(codexDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const projectRoot = path.join(home, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const projectRootJson = JSON.stringify(projectRoot).slice(1, -1);

  const indexLines = [];
  for (const session of def.sessions) {
    const jsonlPath = path.join(sessionsDir, `${session.id}.jsonl`);
    const jsonl = renderJsonlLines(session, opts.includeAppend, def)
      .replaceAll('__FIXTURE_PROJECT__', projectRootJson);
    fs.writeFileSync(jsonlPath, jsonl, 'utf8');
    indexLines.push(JSON.stringify({ id: session.id, thread_name: session.title }));
  }
  fs.writeFileSync(path.join(codexDir, 'session_index.jsonl'), indexLines.join('\n') + '\n', 'utf8');
  return { home, sessionsDir, projectRoot, fixture: def };
}

export function appendFixtureLines(fixtureId, home) {
  const def = fixtureDefinitions[fixtureId];
  if (!def?.append?.length) return 0;
  const firstSession = def.sessions[0];
  const jsonlPath = path.join(home, '.codex', 'sessions', `${firstSession.id}.jsonl`);
  fs.appendFileSync(jsonlPath, def.append.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return def.append.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixtureId = process.argv[2];
  if (!fixtureId) {
    process.stderr.write('Usage: node evals/obelisk-codex/runners/run-fixture-build.mjs <fixture-id> [target-root]\n');
    process.exit(1);
  }
  const targetRoot = process.argv[3] ? path.resolve(process.argv[3]) : path.join(repoRoot, 'evals', 'obelisk-codex', '.tmp', 'fixtures');
  const built = buildFixtureHome(fixtureId, targetRoot);
  process.stdout.write(JSON.stringify({ ok: true, home: built.home }, null, 2) + '\n');
}
