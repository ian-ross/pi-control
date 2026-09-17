import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { formatSkillsForPrompt, loadSkillsFromDir } from '@earendil-works/pi-coding-agent';

test('plan-to-backlog loads for explicit invocation without being advertised to the model', () => {
  const result = loadSkillsFromDir({ dir: fileURLToPath(new URL('../skills', import.meta.url)), source: 'test' });
  assert.deepEqual(result.diagnostics, []);
  const skill = result.skills.find(s => s.name === 'plan-to-backlog');
  assert.ok(skill);
  assert.equal(skill.disableModelInvocation, true);
  assert.equal(formatSkillsForPrompt([skill]), '');
});

test('task generation instructions require writing and reading back every implementation plan', async () => {
  const skill = await readFile(new URL('../skills/plan-to-backlog/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /Every created or updated implementation task must have a non-empty `implementationPlan` field/);
  assert.match(skill, /backlog task edit <id> --plan <text>/);
  assert.match(skill, /backlog task <id> --json/);
  assert.match(skill, /Do not report generation as complete while any task lacks its plan/);
  assert.match(skill, /Do not mark it In Progress merely to attach a plan/);
});
