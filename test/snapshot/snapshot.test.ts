import { lstat, mkdtemp, readFile, readlink, rename, writeFile, mkdir, unlink, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSnapshot, doctorSnapshot, captureRepositoryResult } from '../../src/snapshot/index.js';
import { git, makeSourceRepository } from './real-git.js';

async function destination(name: string): Promise<string> {
  return path.join(await mkdtemp(path.join(os.tmpdir(), `juno-benchmark-${name}-`)), 'candidate');
}

describe('exact-tree snapshot with a real Git repository', () => {
  it('preserves bytes, executable modes, symlinks and deterministic identities', async () => {
    const source = await makeSourceRepository();
    const firstPath = await destination('one');
    const secondPath = await destination('two');
    const options = { sourceRepository: source.root, baseCommit: source.commit, excludedPaths: ['.juno_task', 'hidden-reference'] } as const;
    const first = await buildSnapshot({ ...options, destination: firstPath });
    const second = await buildSnapshot({ ...options, destination: secondPath });

    expect(first.content_identity).toBe(second.content_identity);
    expect(first.synthetic_commit).toBe(second.synthetic_commit);
    expect(first.entries.map((entry) => [entry.path, entry.mode, entry.type])).toEqual([
      ['plain-link', '120000', 'symlink'], ['plain.txt', '100644', 'file'], ['run.sh', '100755', 'file'],
    ]);
    expect(await readFile(path.join(firstPath, 'plain.txt'))).toEqual(Buffer.from([0, 1, 2, 10, 255]));
    expect((await lstat(path.join(firstPath, 'run.sh'))).mode & 0o111).not.toBe(0);
    expect(await readlink(path.join(firstPath, 'plain-link'))).toBe('plain.txt');
    expect(first.isolation).toEqual({ git_objects: 'isolated', host_filesystem: 'trusted', container: 'none' });
    await expect(doctorSnapshot({ repository: firstPath, manifest: first, sourceRepository: source.root })).resolves.toMatchObject({ ok: true });
  });

  it('cannot reach objects created in the source after the selected commit', async () => {
    const source = await makeSourceRepository();
    const candidate = await destination('future-object');
    const manifest = await buildSnapshot({ sourceRepository: source.root, baseCommit: source.commit, destination: candidate, excludedPaths: ['.juno_task', 'hidden-reference'] });
    await writeFile(path.join(source.root, 'future-secret.txt'), 'not reachable from candidate');
    await git(source.root, 'add', 'future-secret.txt');
    await git(source.root, 'commit', '--quiet', '-m', 'future');
    const futureBlob = await git(source.root, 'rev-parse', 'HEAD:future-secret.txt');
    await expect(git(candidate, 'cat-file', '-e', futureBlob)).rejects.toThrow();
    await expect(doctorSnapshot({ repository: candidate, manifest, sourceRepository: source.root })).resolves.toMatchObject({ ok: true });
  });

  it('fails closed on refs, remotes, alternates, reflogs and linked worktrees', async () => {
    const source = await makeSourceRepository();
    const make = async (name: string) => {
      const repository = await destination(name);
      const manifest = await buildSnapshot({ sourceRepository: source.root, baseCommit: source.commit, destination: repository, excludedPaths: ['.juno_task', 'hidden-reference'] });
      return { repository, manifest };
    };

    const extraRef = await make('extra-ref');
    await git(extraRef.repository, 'branch', 'leak');
    await expect(doctorSnapshot({ ...extraRef, sourceRepository: source.root })).rejects.toThrow(/unexpected refs/u);

    const remote = await make('remote');
    await git(remote.repository, 'remote', 'add', 'origin', source.root);
    await expect(doctorSnapshot({ ...remote, sourceRepository: source.root })).rejects.toThrow(/remotes/u);

    const alternate = await make('alternate');
    await mkdir(path.join(alternate.repository, '.git', 'objects', 'info'), { recursive: true });
    await writeFile(path.join(alternate.repository, '.git', 'objects', 'info', 'alternates'), `${path.join(source.root, '.git', 'objects')}\n`);
    await expect(doctorSnapshot({ ...alternate, sourceRepository: source.root })).rejects.toThrow(/alternates/u);

    const reflog = await make('reflog');
    await mkdir(path.join(reflog.repository, '.git', 'logs'), { recursive: true });
    await writeFile(path.join(reflog.repository, '.git', 'logs', 'HEAD'), 'source path');
    await expect(doctorSnapshot({ ...reflog, sourceRepository: source.root })).rejects.toThrow(/logs/u);

    const linked = await make('linked');
    await rename(path.join(linked.repository, '.git'), path.join(linked.repository, '.git-private'));
    await writeFile(path.join(linked.repository, '.git'), `gitdir: ${path.join(linked.repository, '.git-private')}\n`);
    await expect(doctorSnapshot({ ...linked, sourceRepository: source.root })).rejects.toThrow(/private directory/u);

    const extraObject = await make('extra-object');
    const loose = path.join(extraObject.repository, 'loose-object.txt');
    await writeFile(loose, 'unreachable future object');
    await git(extraObject.repository, 'hash-object', '-w', 'loose-object.txt');
    await unlink(loose);
    await expect(doctorSnapshot({ ...extraObject, sourceRepository: source.root })).rejects.toThrow(/extra Git objects/u);
  });

  it('rejects reference/controller bytes, credentials, routing environment and dirty trees', async () => {
    const source = await makeSourceRepository();
    const leaked = await destination('leaked');
    const leakedManifest = await buildSnapshot({ sourceRepository: source.root, baseCommit: source.commit, destination: leaked, excludedPaths: ['.juno_task'] });
    await expect(doctorSnapshot({ repository: leaked, manifest: leakedManifest, prohibitedByteSequences: ['future answer'] })).rejects.toThrow(/prohibited reference bytes/u);

    const credentialSource = await makeSourceRepository();
    await writeFile(path.join(credentialSource.root, 'credential.txt'), 'api_key=abcdefghijklmnop');
    await git(credentialSource.root, 'add', 'credential.txt');
    await git(credentialSource.root, 'commit', '--quiet', '-m', 'credential fixture');
    const credentialRepo = await destination('credential');
    const credentialManifest = await buildSnapshot({ sourceRepository: credentialSource.root, baseCommit: 'HEAD', destination: credentialRepo, excludedPaths: ['.juno_task', 'hidden-reference'] });
    await expect(doctorSnapshot({ repository: credentialRepo, manifest: credentialManifest })).rejects.toThrow(/credential-like/u);

    const pathLeakSource = await makeSourceRepository();
    await writeFile(path.join(pathLeakSource.root, 'source-path.txt'), pathLeakSource.root);
    await git(pathLeakSource.root, 'add', 'source-path.txt');
    await git(pathLeakSource.root, 'commit', '--quiet', '-m', 'source path leak');
    const pathLeakRepo = await destination('source-path');
    const pathLeakManifest = await buildSnapshot({ sourceRepository: pathLeakSource.root, baseCommit: 'HEAD', destination: pathLeakRepo, excludedPaths: ['.juno_task', 'hidden-reference'] });
    await expect(doctorSnapshot({ repository: pathLeakRepo, manifest: pathLeakManifest, sourceRepository: pathLeakSource.root })).rejects.toThrow(/prohibited reference bytes/u);

    const clean = await destination('routing');
    const cleanManifest = await buildSnapshot({ sourceRepository: source.root, baseCommit: source.commit, destination: clean, excludedPaths: ['.juno_task', 'hidden-reference'] });
    await expect(doctorSnapshot({ repository: clean, manifest: cleanManifest, candidateEnvironment: { JUNO_TASK_ROOT: '/canonical' } })).rejects.toThrow(/routing environment/u);
    await expect(doctorSnapshot({ repository: clean, manifest: cleanManifest, candidateEnvironment: { YYLO_BENCHMARK_REGISTRY: '/private/registry' } })).rejects.toThrow(/routing environment/u);
    await expect(doctorSnapshot({ repository: clean, manifest: cleanManifest, candidateEnvironment: { YYLO_BENCHMARK_WORK_ROOT: '/private/work' } })).rejects.toThrow(/routing environment/u);
    await expect(doctorSnapshot({ repository: clean, manifest: cleanManifest, canonicalControllerPaths: [source.root], candidateEnvironment: { SAFE_VALUE: source.root } })).rejects.toThrow(/controller reference/u);
    await writeFile(path.join(clean, 'candidate-change.txt'), 'dirty');
    await expect(doctorSnapshot({ repository: clean, manifest: cleanManifest })).rejects.toThrow(/worktree differs/u);
  });

  it('classifies environment lookups without exempting literal credentials or the rest of a line', async () => {
    const source = await makeSourceRepository();
    const repository = await destination('environment-expression');
    const manifest = await buildSnapshot({ sourceRepository: source.root, baseCommit: source.commit, destination: repository,
      excludedPaths: ['.juno_task', 'hidden-reference'] });
    const file = path.join(repository, 'source.py');
    const verify = async () => doctorSnapshot({ repository, manifest, resultManifest: await captureRepositoryResult(repository) });
    for (const text of [
      '        api_key = os.environ.get("GEMINI_API_KEY", "")',
      "access_token = os.environ.get('ACCESS_TOKEN')",
      "password = os.environ.get('PASSWORD', '') # read at runtime",
    ]) {
      await writeFile(file, text);
      await expect(verify(), text).resolves.toMatchObject({ ok: true });
    }
    for (const text of [
      'api_key=abcdefghijklmnop', 'api_key="abcdefghijklmnop"',
      'api_key="os.environ.get"', 'api_key=os.environ.getevil',
      'api_key = os.environ.get("KEY", "abcdefghijklmnop")',
      'api_key = os.environ.get("KEY") or "abcdefghijklmnop"',
      'api_key = os.environ.get("KEY"); password=abcdefghijklmnop',
      'api_key = os.environ.get("KEY") # password=abcdefghijklmnop',
      '"api_key = os.environ.get(\'KEY\')"',
      'api_key = os.environ.get("KEY")\n-----BEGIN PRIVATE KEY-----',
      'api_key = os.environ.get("KEY")\n' + 'ghp_' + 'a'.repeat(30),
      'api_key = os.environ.get("KEY")\nhttps://user:abcdefghijklmnop@example.invalid',
    ]) {
      await writeFile(file, text);
      await expect(verify(), text).rejects.toThrow(/credential-like/u);
    }
  });

  it('distinguishes nested candidate-own logs from source, sibling, traversal and explicit protected references', async () => {
    const source = await makeSourceRepository();
    const repository = path.join(source.root, 'attempts', 'candidate');
    await mkdir(path.dirname(repository));
    const manifest = await buildSnapshot({ sourceRepository: source.root, baseCommit: source.commit, destination: repository,
      excludedPaths: ['.juno_task', 'hidden-reference'] });
    const log = path.join(repository, 'build.log');
    await writeFile(log, `cwd="${repository}"\nfile='${repository}/run.sh'`);
    const verify = async (extra = {}) => doctorSnapshot({ repository, manifest, sourceRepository: source.root,
      resultManifest: await captureRepositoryResult(repository), ...extra });
    await expect(verify()).resolves.toMatchObject({ ok: true });
    await expect(verify({ canonicalControllerPaths: [source.root] })).rejects.toThrow(/prohibited reference/u);
    await expect(verify({ prohibitedByteSequences: [repository] })).rejects.toThrow(/prohibited reference/u);
    for (const leak of [source.root, `${source.root}/hidden-reference`, `${source.root}/attempts/sibling`,
      `${repository}/../../hidden-reference`, `${repository}-suffix`, `${repository}/missing/../../../hidden-reference`]) {
      await writeFile(log, `cwd="${repository}"\nleak="${leak}"`);
      await expect(verify()).rejects.toThrow(/prohibited reference/u);
    }
    await writeFile(log, `cwd="${repository}" api_key=abcdefghijklmnop`);
    await expect(verify()).rejects.toThrow(/credential-like/u);
    await writeFile(log, `cwd="${repository}"`);
    const resultManifest = await captureRepositoryResult(repository);
    await writeFile(log, 'changed after manifest');
    await expect(doctorSnapshot({ repository, manifest, resultManifest, sourceRepository: source.root })).rejects.toThrow(/drift/u);
  });

  it('refuses unsafe source paths, existing destinations and escaping symlinks', async () => {
    const source = await makeSourceRepository();
    await expect(buildSnapshot({ sourceRepository: source.root, baseCommit: source.commit, destination: source.root })).rejects.toThrow(/must not already exist/u);
    await expect(buildSnapshot({ sourceRepository: source.root, baseCommit: source.commit, destination: await destination('unsafe-exclusion'), excludedPaths: ['../hidden'] })).rejects.toThrow(/unsafe path component/u);
    await unlink(path.join(source.root, 'plain-link'));
    await symlink('../host-secret', path.join(source.root, 'plain-link'));
    await git(source.root, 'add', 'plain-link');
    await git(source.root, 'commit', '--quiet', '-m', 'unsafe symlink');
    await expect(buildSnapshot({ sourceRepository: source.root, baseCommit: 'HEAD', destination: await destination('unsafe-link'), excludedPaths: ['.juno_task', 'hidden-reference'] })).rejects.toThrow(/unsafe candidate symlink/u);
  });
});
