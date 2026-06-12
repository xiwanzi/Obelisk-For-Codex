export function judgeQueryHygiene({ item, querySource, answer }) {
  const failures = [];
  const source = querySource || '';
  const usedApis = Array.isArray(answer?.used_apis) ? answer.used_apis : [];

  for (const marker of item.must_use || []) {
    if (marker === 'runtime-sandbox') continue;
    if (!usedApis.includes(marker) && !source.includes(`${marker}(`)) {
      failures.push(`must_use not satisfied: ${marker}`);
    }
  }

  for (const forbidden of item.forbid || []) {
    if (source.includes(forbidden)) failures.push(`forbidden query marker used: ${forbidden}`);
  }

  if (/SELECT\s+\*/i.test(source) && !/LIMIT\s+\d+/i.test(source)) {
    failures.push('broad SELECT * without LIMIT');
  }

  if (/summaries\s*\(\s*\)/.test(source)) {
    failures.push('summaries() without opts');
  }

  if (!answer?.query_notes && item.task_type !== 'sandbox_safety') {
    failures.push('missing query_notes');
  }

  return {
    hard_pass: failures.length === 0,
    failures,
    bounded_query_hygiene: failures.length ? Math.max(0, 1 - failures.length * 0.25) : 1,
  };
}
