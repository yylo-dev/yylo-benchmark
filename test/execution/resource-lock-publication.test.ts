import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Force the real write's truncate-to-content interval to be observable. Readers
// must wait for publication, not parse the initializing owner's partial bytes.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const [file, content, options] = args;
      await actual.writeFile(file, '', options);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await actual.writeFile(file, content, { ...(options as object), flag: 'w' });
    },
  };
});

import { PersistentTypedResourceLocks } from '../../src/execution/resource-lock.js';

describe('atomic resource-lock owner publication', () => {
  it('serializes contenders even while owner metadata is being written', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'benchmark-owner-publication-'));
    let active = 0;
    let maximum = 0;
    const completed: number[] = [];
    await Promise.all(Array.from({ length: 8 }, (_, index) => {
      const locks = new PersistentTypedResourceLocks({ root, pollIntervalMs: 1, waitTimeoutMs: 10_000 });
      return locks.withResources([{ type: 'experiment', id: 'same-plan' }], async () => {
        maximum = Math.max(maximum, ++active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        completed.push(index);
        active--;
      });
    }));
    expect(maximum).toBe(1);
    expect(completed.sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
