#!/usr/bin/env node
// Explicit development integration check; neither repository needs the other for standalone tests.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

if (process.argv.length !== 3) throw new Error('usage: verify-standalone-skill-examples.mjs /path/to/yylo-skills/skills/benchmark-yylo (build Benchmark first)');
const { loadChecklist, assessChecklist, checklistScore, EvaluatorSchema } = await import('../dist/index.js');
const skill = path.resolve(process.argv[2]);
assert.match(await readFile(path.join(skill, 'SKILL.md'), 'utf8'), /\nname: benchmark-yylo\n/);
const examples = path.join(skill, 'examples');
const checklist = await loadChecklist({ criteria: path.join(examples, 'task.yaml'), projectCriteria: path.join(examples, 'project.yaml') });
const assessment = assessChecklist(JSON.parse(await readFile(path.join(examples, 'assessment.json'), 'utf8')), checklist);
const score = checklistScore(checklist, assessment);
assert.deepEqual(score, { total: 3, passed: 2, failed: 1, unknown: 0, loss: 1 / 3, status: 'scored', reason: null });
assert.equal(EvaluatorSchema.parse(JSON.parse(await readFile(path.join(examples, 'human.json'), 'utf8'))).kind, 'human');
console.log(JSON.stringify({ ok: true, skill, checklist_hash: checklist.sha256, loss: score.loss, live_model_calls: 0 }));
