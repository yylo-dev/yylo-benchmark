import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assessChecklist, checklistScore, loadChecklist } from '../src/v2/checklists.js';
import { EvaluatorSchema } from '../src/v2/contracts.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const skill = path.join(root, 'skills/benchmark-checklist');
const assets = ['SKILL.md', 'examples/project.yaml', 'examples/task.yaml', 'examples/assessment.json', 'examples/human.json'];

describe('package-owned checklist guidance', () => {
  it('ships all referenced skill assets in the npm package without lifecycle scripts', async () => {
    const { stdout } = await promisify(execFile)('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: root, timeout: 20000 });
    const files = JSON.parse(stdout)[0].files.map((item: { path: string }) => item.path);
    for (const asset of assets) expect(files).toContain(`skills/benchmark-checklist/${asset}`);
    const markdown = await readFile(path.join(skill, 'SKILL.md'), 'utf8');
    expect(markdown).toMatch(/^---\nname: benchmark-checklist\ndescription: /);
    for (const match of markdown.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      expect(await readFile(path.resolve(skill, match[1]!), 'utf8')).not.toBe('');
    }
    expect(markdown).toContain('not a security sandbox');
    expect(markdown).toContain('operator approval');
    expect(markdown).toContain('alternative implementation');
  });

  it('validates reusable examples against the shipped runtime and computes the documented loss', async () => {
    const checklist = (await loadChecklist({ criteria: path.join(skill, 'examples/task.yaml'), projectCriteria: path.join(skill, 'examples/project.yaml') }))!;
    const response = JSON.parse(await readFile(path.join(skill, 'examples/assessment.json'), 'utf8'));
    const assessment = assessChecklist(response, checklist);
    expect(checklistScore(checklist, assessment)).toMatchObject({ total: 3, passed: 2, failed: 1, unknown: 0, loss: 1 / 3, status: 'scored' });
    const evaluator = EvaluatorSchema.parse(JSON.parse(await readFile(path.join(skill, 'examples/human.json'), 'utf8')));
    expect(evaluator.kind).toBe('human');
  });
});
