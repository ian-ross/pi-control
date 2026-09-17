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

test('Plannotator planning instructions keep Backlog mutations behind approval', async () => {
  const instructions = await readFile(new URL('../skills/plannotator-planning-instructions.md', import.meta.url), 'utf8');
  assert.match(instructions, /inspect the repository/i);
  assert.match(instructions, /write the planning markdown document/i);
  assert.match(instructions, /submit that document for approval with plannotator_submit_plan/i);
  assert.match(instructions, /Do not create Backlog tasks/i);
  assert.match(instructions, /update Backlog tasks/i);
  assert.match(instructions, /before approval/i);
  assert.match(instructions, /AGENTS\.md[\s\S]*deferred until after the plan is approved/i);
  assert.match(instructions, /Repository task-management instructions apply after approval/i);
  assert.match(instructions, /approved-plan handoff is responsible for invoking task generation/i);
  assert.doesNotMatch(instructions, /system prompt/i);
  assert.match(instructions, /prompt guidance[\s\S]*not a shell sandbox/i);
});

test('example Plannotator config uses external handoff and planning-only instructions', async () => {
  const raw = await readFile(new URL('../skills/plannotator.example.json', import.meta.url), 'utf8');
  const config = JSON.parse(raw) as {
    executionMode?: string;
    systemPrompt?: unknown;
    phases?: { planning?: { activeTools?: string[]; instructions?: string; systemPrompt?: unknown } };
  };
  const planning = config.phases?.planning;

  assert.equal(config.executionMode, 'external');
  assert.ok(planning);
  assert.deepEqual(planning.activeTools, ['grep', 'find', 'ls', 'plannotator_submit_plan']);
  assert.equal('systemPrompt' in config, false);
  assert.equal('systemPrompt' in planning, false);
  assert.match(planning.instructions ?? '', /Backlog is off-limits before approval/);
  assert.match(planning.instructions ?? '', /Do not create Backlog tasks/);
  assert.match(planning.instructions ?? '', /Repository task-management instructions apply after approval/);
  assert.match(planning.instructions ?? '', /approved-plan handoff is responsible for invoking task generation/);
});
