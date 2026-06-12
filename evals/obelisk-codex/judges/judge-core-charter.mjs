import fs from 'node:fs';

const rejectPatterns = [
  { id: 'generated_wiki_ground_truth', pattern: /canonical\s+(?:wiki|markdown|summary)|ground\s+truth\s+summary/i },
  { id: 'human_browser_core', pattern: /session\s+browser|browse\s+session/i },
  { id: 'remote_memory', pattern: /remote\s+memory|external\s+memory|cloud\s+memory/i },
  { id: 'daemon_first', pattern: /daemon[-\s]?first|background\s+daemon/i },
  { id: 'full_dump', pattern: /thread\([^)]*\)|SELECT\s+\*\s+FROM\s+messages(?![\s\S]{0,120}LIMIT)/i },
  { id: 'hardcoded_fixture_answer', pattern: /expected_facts.*answer|fixture.*hardcode|hardcoded\s+answer/i },
  { id: 'private_raw_logs', pattern: /\.codex[\\/](?:sessions|archived_sessions)[\\/].*\.jsonl/i },
];

export function judgeCoreCharter({ patchText = '', changedFiles = [] }) {
  const rejects = [];
  for (const check of rejectPatterns) {
    if (check.pattern.test(patchText)) rejects.push(check.id);
  }
  for (const file of changedFiles) {
    if (/\.codex[\\/](?:sessions|archived_sessions)[\\/].*\.jsonl/i.test(file)) {
      rejects.push('private_raw_logs');
    }
  }
  return {
    passed: rejects.length === 0,
    rejects: [...new Set(rejects)],
    merge_status: 'NOT MERGED — WAITING FOR MARUKO APPROVAL',
  };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const patchPath = process.argv[2];
  const patchText = patchPath && fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '';
  process.stdout.write(JSON.stringify(judgeCoreCharter({ patchText }), null, 2) + '\n');
}
