#!/usr/bin/env node
const result = {
  ok: true,
  lane: 'skill',
  status: 'manual_not_automated',
  reason: 'Skill eval requires an outer agent invocation. API eval is automated and uses the real runtime/indexer/query API.',
  merge_status: 'NOT MERGED — WAITING FOR MARUKO APPROVAL',
};

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
