import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertTaskMetadataEdit } from '../src/metadata.js';

const before = `---
id: TASK-1
title: Example
status: In Progress
assignee: [pi-control]
---

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Works
- [x] #2 Human check
<!-- AC:END -->

## Implementation Plan
<!-- SECTION:PLAN:BEGIN -->
Preserve this.
<!-- SECTION:PLAN:END -->
`;
const after = before.replace('status: In Progress', "status: Done\nupdated_date: '2026-09-17 14:47'").replace('- [ ] #1', '- [x] #1') + `
## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Finished safely.
<!-- SECTION:FINAL_SUMMARY:END -->
`;

test('metadata comparison permits only intended CLI edits', () => {
  assert.doesNotThrow(() => assertTaskMetadataEdit(before, after, [1]));
  assert.doesNotThrow(() => assertTaskMetadataEdit(after, after.replace('Finished safely.', 'Updated summary.'), []));
  for (const changed of [
    after.replace('title: Example', 'title: Changed'),
    after.replace('assignee: [pi-control]', 'assignee: [someone]'),
    after.replace('Preserve this.', 'Replaced plan.'),
    after.replace('- [x] #2', '- [ ] #2'),
    after.replace('Works', 'Different criterion'),
    after.replace('id: TASK-1', 'id: TASK-1\nunknown: surprise'),
    after + '\nUnreported content\n',
  ]) assert.throws(() => assertTaskMetadataEdit(before, changed, [1]), /outside the intended/);
  assert.throws(() => assertTaskMetadataEdit(before, after, []), /outside the intended/);
});

test('malformed task text and ambiguous metadata markers fail closed', () => {
  assert.throws(() => assertTaskMetadataEdit('not frontmatter', after, [1]), /frontmatter/);
  assert.throws(() => assertTaskMetadataEdit(before, after.replace('status: Done', 'status: Done\nstatus: Ready'), [1]), /Duplicate/);
  assert.throws(() => assertTaskMetadataEdit(before, after + '<!-- SECTION:FINAL_SUMMARY:BEGIN -->', [1]), /markers/);
});
