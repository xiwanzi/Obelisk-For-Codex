import fs from 'node:fs';
import path from 'node:path';

function asText(value) {
  if (value == null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function containsFact(answerText, fact) {
  if (!fact) return true;
  if (answerText.includes(fact)) return true;
  const normalizedAnswer = answerText.replace(/\\\\/g, '\\').replace(/\//g, '\\');
  const normalizedFact = String(fact).replace(/\\\\/g, '\\').replace(/\//g, '\\');
  return normalizedAnswer.includes(normalizedFact);
}

function evidenceMatches(actual, expected) {
  const id = String(actual.id || actual.message_uuid || actual.tool_call_id || actual.file_path || '');
  const expectedId = String(expected.id || '');
  if (actual.type !== expected.type) return false;
  if (!expectedId) return true;
  if (id === expectedId || id.includes(expectedId)) return true;
  try {
    return new RegExp(expectedId).test(id);
  } catch {
    return false;
  }
}

function loadGold(repoRoot, item) {
  if (!item.fixture) return {};
  const goldPath = path.join(repoRoot, 'evals', 'obelisk-codex', 'data', 'synthetic', 'fixtures', item.fixture, 'gold.json');
  if (!fs.existsSync(goldPath)) return {};
  return JSON.parse(fs.readFileSync(goldPath, 'utf8'));
}

export function judgeAnswer({ repoRoot, item, answer, runtime }) {
  const gold = loadGold(repoRoot, item);
  const expectedFacts = gold.expected_facts || item.expected_facts || [];
  const expectedEvidence = gold.expected_evidence || item.expected_evidence || [];
  const failures = [];
  const evidence = Array.isArray(answer?.evidence) ? answer.evidence : [];
  const answerText = asText(answer?.answer);
  const allText = asText(answer);

  if (!answer || typeof answer !== 'object') failures.push('answer.json missing or not an object');
  if (!answerText.trim()) failures.push('answer is empty');

  for (const fact of expectedFacts) {
    if (!containsFact(allText, fact)) failures.push(`missing expected fact: ${fact}`);
  }

  for (const ev of expectedEvidence.filter((e) => e.required !== false)) {
    if (!evidence.some((actual) => evidenceMatches(actual, ev))) {
      failures.push(`missing expected evidence: ${ev.type}:${ev.id}`);
    }
  }

  if (expectedEvidence.length && !evidence.some((ev) => ev.id || ev.message_uuid || ev.tool_call_id || ev.file_path)) {
    failures.push('no concrete evidence identifier');
  }

  const maxChars = item.max_result_chars || 12000;
  const resultChars = answer?.result_chars || allText.length;
  if (resultChars > maxChars) failures.push(`result_chars ${resultChars} exceeds max ${maxChars}`);
  if ((runtime?.stdout || '').length > maxChars * 2) failures.push('runtime stdout exceeded benchmark budget');

  if (item.task_type === 'no_evidence' && evidence.length > 0) {
    failures.push('no-evidence item returned evidence');
  }

  return {
    hard_pass: failures.length === 0,
    failures,
    fact_coverage: expectedFacts.length
      ? (expectedFacts.length - failures.filter((f) => f.startsWith('missing expected fact')).length) / expectedFacts.length
      : 1,
    evidence_quality: expectedEvidence.length
      ? (expectedEvidence.length - failures.filter((f) => f.startsWith('missing expected evidence')).length) / expectedEvidence.length
      : item.task_type === 'no_evidence' ? 1 : 0.75,
  };
}
