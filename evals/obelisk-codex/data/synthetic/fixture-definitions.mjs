const CWD = String.raw`C:\Fixture\Obelisk`;
const DYNAMIC_CWD = '__FIXTURE_PROJECT__';

function at(minute) {
  return `2026-06-01T00:${String(minute).padStart(2, '0')}:00.000Z`;
}

function meta(id, cwd = CWD) {
  return { timestamp: at(0), type: 'session_meta', payload: { id, cwd, cli_version: 'fixture-codex' } };
}

function user(message, minute) {
  return { timestamp: at(minute), type: 'event_msg', payload: { type: 'user_message', message } };
}

function agent(message, minute, phase = null) {
  return { timestamp: at(minute), type: 'event_msg', payload: { type: 'agent_message', message, phase } };
}

function compact(message, minute) {
  return { timestamp: at(minute), type: 'event_msg', payload: { type: 'context_compacted', message } };
}

function taskComplete(message, minute) {
  return { timestamp: at(minute), type: 'event_msg', payload: { type: 'task_complete', message } };
}

function toolCall(callId, name, args, minute) {
  return {
    timestamp: at(minute),
    type: 'response_item',
    payload: { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) },
  };
}

function toolResult(callId, output, minute, extra = {}) {
  return {
    timestamp: at(minute),
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: callId, output, ...extra },
  };
}

function session(id, title, lines, cwd = CWD) {
  return { id, title, cwd, lines: [meta(id, cwd), ...lines] };
}

const applyPatchInput = [
  '*** Begin Patch',
  '*** Update File: src/actual.ts',
  '@@',
  '-export const value = 1;',
  '+export const value = 2;',
  String.raw`+// Documentation mentions C:\Fixture\Obelisk\docs\fake-mentioned.md but this path is not edited.`,
  '*** End Patch',
].join('\n');

const rawLongOutput = `RAW_SENTINEL_BEGIN ${'A'.repeat(11200)} RAW_SENTINEL_TAIL`;

export const fixtureDefinitions = {
  'apply-patch-doc-false-positive': {
    sessions: [
      session('apply-patch-doc-false-positive-session', 'apply_patch false positive fixture', [
        user('Please update src/actual.ts and mention docs/fake-mentioned.md only in a comment.', 1),
        toolCall('call_apply_patch', 'apply_patch', { input: applyPatchInput }, 2),
        toolResult('call_apply_patch', 'Patch applied successfully.', 3),
        agent('Updated actual.ts; fake-mentioned.md was only mentioned in patch text.', 4),
      ]),
    ],
  },

  'powershell-write': {
    sessions: [
      session('powershell-write-session', 'PowerShell write fixture', [
        user('Write the benchmark plan file with PowerShell.', 1),
        toolCall('call_powershell_write', 'shell_command', {
          command: String.raw`Set-Content -LiteralPath 'notes\plan.md' -Value 'POWERSHELL_WRITE_SENTINEL'`,
          workdir: CWD,
        }, 2),
        toolResult('call_powershell_write', 'Exit code: 0\nWrote notes\\plan.md', 3),
      ]),
    ],
  },

  'failure-true-positive': {
    sessions: [
      session('failure-true-positive-session', 'true failure fixture', [
        user('Run the failing command.', 1),
        toolCall('call_failure_true', 'shell_command', {
          command: 'node missing-file.js',
          workdir: CWD,
        }, 2),
        toolResult('call_failure_true', 'Exit code: 1\nError: Cannot find module missing-file.js\nFAIL_TRUE_SENTINEL', 3),
      ]),
    ],
  },

  'failure-false-positive': {
    sessions: [
      session('failure-false-positive-session', 'false failure fixture', [
        user('Discuss error handling without failing.', 1),
        toolCall('call_failure_false', 'shell_command', {
          command: 'Write-Output "FALSE_POSITIVE_ERROR_SENTINEL: this text mentions error but exits cleanly"',
          workdir: CWD,
        }, 2),
        toolResult('call_failure_false', 'Exit code: 0\nFALSE_POSITIVE_ERROR_SENTINEL: discussed error handling text only.', 3),
      ]),
    ],
  },

  'summary-context': {
    sessions: [
      session('summary-context-session', 'summary context fixture', [
        user('We need a schema-safe SQL rule.', 1),
        compact('SUMMARY_CONTEXT_SENTINEL: schema-safe SQL decision exists; use this only as an entry point.', 2),
        agent('SCHEMA_SAFE_SQL_DECISION: use placeholders for user input and always apply LIMIT to exploratory SQL.', 4),
        toolCall('call_schema_query', 'shell_command', {
          command: 'node scripts/runtime.mjs --query bounded-query.mjs',
          workdir: CWD,
        }, 5),
        toolResult('call_schema_query', 'Exit code: 0\nVerified bounded SQL with placeholders and LIMIT.', 6),
      ]),
    ],
  },

  'raw-recovery': {
    sessions: [
      session('raw-recovery-session', 'raw recovery fixture', [
        user('Capture a long tool output.', 1),
        toolCall('call_raw_long', 'shell_command', {
          command: 'node emit-long-output.js',
          workdir: CWD,
        }, 2),
        toolResult('call_raw_long', rawLongOutput, 3),
      ]),
    ],
  },

  'fts-punctuation-path': {
    sessions: [
      session('fts-punctuation-path-session', 'FTS punctuation fixture', [
        user(String.raw`Please remember the changed path C:\Fixture\Obelisk\中文路径\a:b\file.ts for FTS_PUNCT_SENTINEL.`, 1),
        agent(String.raw`FTS_PUNCT_SENTINEL path evidence: C:\Fixture\Obelisk\中文路径\a:b\file.ts`, 2),
      ]),
    ],
  },

  'spawned-agents-workflow': {
    sessions: [
      session('spawned-agents-workflow-session', 'spawned agents workflow fixture', [
        user('Spawn a parser review agent and collect its conclusion.', 1),
        toolCall('call_spawn_parser', 'spawn_agent', {
          agent_type: 'review',
          nickname: 'Parser',
          message: 'Review whether parser keeps raw JSONL relationships.',
        }, 2),
        toolResult('call_spawn_parser', { agent_id: 'agent_parser_1', nickname: 'Parser' }, 3),
        toolCall('call_wait_parser', 'wait_agent', { targets: ['agent_parser_1'] }, 4),
        toolResult('call_wait_parser', {
          status: {
            agent_parser_1: {
              completed: 'Parser agent conclusion: keep raw JSONL relationships and cite structured ids.',
            },
          },
        }, 5),
        taskComplete('Workflow completed with one parser agent.', 6),
      ]),
    ],
  },

  'no-evidence': {
    sessions: [
      session('no-evidence-session', 'no evidence fixture', [
        user('Discuss an unrelated benchmark harness.', 1),
        agent('No mention of the missing sentinel exists in this fixture.', 2),
      ]),
    ],
  },

  'incremental-indexing': {
    sessions: [
      session('incremental-indexing-session', 'incremental indexing fixture', [
        user('Initial line before append.', 1),
        agent('Initial indexed assistant line before append.', 2),
      ]),
    ],
    append: [
      agent('INCREMENTAL_APPEND_SENTINEL: appended after first index run.', 3),
    ],
  },

  'sandbox-safety': {
    sessions: [
      session('sandbox-safety-session', 'sandbox safety fixture', [
        user('Sandbox fixture exists only to let runtime build an index.', 1),
      ]),
    ],
  },

  'sql-readonly-guard': {
    sessions: [
      session('sql-readonly-guard-session', 'SQL readonly guard fixture', [
        user('SQL guard fixture exists only to let runtime build an index.', 1),
      ]),
    ],
  },

  'repeated-files': {
    sessions: [
      session('repeated-files-session-a', 'repeated files A', [
        user('First edit of shared file.', 1),
        toolCall('call_shared_a', 'apply_patch', {
          input: [
            '*** Begin Patch',
            '*** Update File: src/shared.ts',
            '@@',
            '-export const shared = 1;',
            '+export const shared = 2;',
            '*** End Patch',
          ].join('\n'),
        }, 2),
        toolResult('call_shared_a', 'Patch applied successfully.', 3),
      ]),
      session('repeated-files-session-b', 'repeated files B', [
        user('Second edit of shared file.', 1),
        toolCall('call_shared_b', 'apply_patch', {
          input: [
            '*** Begin Patch',
            '*** Update File: src/shared.ts',
            '@@',
            '-export const shared = 2;',
            '+export const shared = 3;',
            '*** End Patch',
          ].join('\n'),
        }, 2),
        toolResult('call_shared_b', 'Patch applied successfully.', 3),
      ]),
    ],
  },

  'memory-layer': {
    sessions: [
      session('memory-layer-session', 'memory layer fixture', [
        user('Please preserve the durable memory decision for MEMORY_LAYER_SENTINEL.', 1),
        agent('MEMORY_LAYER_SENTINEL: Persistent Codex memory layer stores durable conclusions as project markdown and indexes English summaries.', 2),
      ], DYNAMIC_CWD),
    ],
  },

  'search-cwd-rank': {
    sessions: [
      session('search-cwd-rank-main', 'cwd rank main', [
        user('CWD_RANK_SENTINEL appears in the main project.', 1),
        agent('CWD_RANK_SENTINEL main project evidence.', 2),
      ], String.raw`C:\Fixture\MainProject`),
      session('search-cwd-rank-sub', 'cwd rank sub', [
        user('CWD_RANK_SENTINEL appears in the sub project.', 1),
        agent('CWD_RANK_SENTINEL sub project evidence.', 2),
      ], String.raw`C:\Fixture\SubProject`),
    ],
  },
};

export function renderJsonlLines(sessionDef, includeAppend = false, fixtureDef = null) {
  const lines = [...sessionDef.lines];
  if (includeAppend && fixtureDef?.append?.length && sessionDef.id === fixtureDef.sessions[0].id) {
    lines.push(...fixtureDef.append);
  }
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}
