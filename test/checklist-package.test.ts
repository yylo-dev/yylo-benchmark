import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('standalone checklist skill ownership', () => {
  it('keeps skills out of the runtime source and npm package', async () => {
    const { stdout } = await promisify(execFile)('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: root, timeout: 20000 });
    const files: string[] = JSON.parse(stdout)[0].files.map((item: { path: string }) => item.path);
    expect(files.some(file => file.startsWith('skills/') || /(^|\/)SKILL\.md$/.test(file))).toBe(false);
    await expect(access(path.join(root, 'skills'))).rejects.toThrow();
    expect(files).toContain('scripts/verify-v2-packed-acceptance.mjs');
  });

  it('directs skill users to the independent repository rather than a runtime-owned copy', async () => {
    const readme = await readFile(path.join(root, 'README.md'), 'utf8');
    expect(readme).toContain('https://github.com/yylo-dev/yylo-skills/tree/main/skills/benchmark-yylo');
    expect(readme).toContain('not shipped inside this npm package');
    expect(readme).not.toContain('skills/benchmark-checklist');
  });
});
