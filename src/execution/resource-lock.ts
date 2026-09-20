import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, sha256Hex } from '../contracts/canonical.js';

export interface TypedResource { readonly type: string; readonly id: string }
export interface ResourceLockOwner {
  readonly schema_version: 'juno_benchmark_resource_lock.v1';
  readonly resource_hash: `sha256:${string}`;
  readonly pid: number;
  readonly host: string;
  readonly nonce: string;
  readonly created_at: string;
}
export interface PersistentResourceLockOptions {
  readonly root: string;
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** A dead owner is not reclaimed until this age; a live owner is never reclaimed. */
  readonly staleOwnerMs?: number;
  readonly now?: () => number;
}
export interface AcquiredResourceLocks { readonly resources: readonly TypedResource[]; release(): Promise<void> }

function normalized(resource: TypedResource): TypedResource {
  const type = resource.type.trim(); const id = resource.id.trim();
  if (!type || !id || type.length > 128 || id.length > 512 || /[\u0000-\u001f\u007f]/u.test(`${type}${id}`)) throw new Error('typed resource identity is invalid');
  return Object.freeze({ type, id });
}
function resourceKey(resource: TypedResource): string { return `${resource.type}\u0000${resource.id}`; }
function digest(resource: TypedResource): string { return sha256Hex(canonicalJson(resource)); }
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
function parseOwner(value: unknown, expected: string): ResourceLockOwner {
  if (value === null || typeof value !== 'object') throw new Error('resource lock owner metadata is invalid');
  const owner = value as Partial<ResourceLockOwner>;
  if (owner.schema_version !== 'juno_benchmark_resource_lock.v1' || owner.resource_hash !== `sha256:${expected}`
      || !Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) < 1 || typeof owner.host !== 'string' || owner.host.length > 255
      || typeof owner.nonce !== 'string' || !/^[0-9a-f]{32}$/u.test(owner.nonce) || typeof owner.created_at !== 'string' || !Number.isFinite(Date.parse(owner.created_at))) {
    throw new Error('resource lock owner metadata is invalid');
  }
  return owner as ResourceLockOwner;
}

export class PersistentTypedResourceLocks {
  readonly #root: string; readonly #wait: number; readonly #poll: number; readonly #stale: number; readonly #now: () => number;
  public constructor(options: PersistentResourceLockOptions) {
    this.#root = path.resolve(options.root); this.#wait = options.waitTimeoutMs ?? 10_000; this.#poll = options.pollIntervalMs ?? 25;
    this.#stale = options.staleOwnerMs ?? 30_000; this.#now = options.now ?? Date.now;
    if (![this.#wait, this.#poll, this.#stale].every((item) => Number.isSafeInteger(item) && item >= 0) || this.#poll < 1) throw new Error('resource lock timing is invalid');
  }
  private async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 }); await chmod(this.#root, 0o700);
    const metadata = await lstat(this.#root); if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('resource lock root is unsafe');
  }
  private async owner(lock: string, expected: string): Promise<ResourceLockOwner | null> {
    try {
      const lockMetadata = await lstat(lock); if (!lockMetadata.isDirectory() || lockMetadata.isSymbolicLink()) throw new Error('resource lock path is unsafe');
      const ownerPath = path.join(lock, 'owner.json'); const ownerMetadata = await lstat(ownerPath);
      if (!ownerMetadata.isFile() || ownerMetadata.isSymbolicLink() || ownerMetadata.size > 4096) throw new Error('resource lock owner path is unsafe');
      return parseOwner(JSON.parse(await readFile(ownerPath, 'utf8')) as unknown, expected);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private async acquireOne(resource: TypedResource, deadline: number): Promise<{ owner: ResourceLockOwner; lock: string }> {
    const hash = digest(resource); const lock = path.join(this.#root, `${hash}.lock`);
    while (true) {
      const nonce = randomBytes(16).toString('hex');
      try {
        await mkdir(lock, { mode: 0o700 });
        const owner: ResourceLockOwner = { schema_version: 'juno_benchmark_resource_lock.v1', resource_hash: `sha256:${hash}`, pid: process.pid,
          host: os.hostname().slice(0, 255), nonce, created_at: new Date(this.#now()).toISOString() };
        // Publish complete metadata atomically. Contenders may observe the lock
        // directory while this write is pending, but never a partial JSON file.
        const pendingOwner = path.join(lock, `.owner-${nonce}.json`);
        await writeFile(pendingOwner, `${canonicalJson(owner)}\n`, { flag: 'wx', mode: 0o600 });
        await rename(pendingOwner, path.join(lock, 'owner.json'));
        return { owner, lock };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { await rm(lock, { recursive: true, force: true }).catch(() => undefined); throw error; }
      }
      const observed = await this.owner(lock, hash);
      if (observed !== null) {
        const age = Math.max(0, this.#now() - Date.parse(observed.created_at));
        if (!alive(observed.pid) && age >= this.#stale) {
          const quarantine = path.join(this.#root, `.stale-${hash}-${observed.nonce}-${randomBytes(4).toString('hex')}`);
          try {
            await rename(lock, quarantine);
            const moved = await this.owner(quarantine, hash);
            if (moved?.nonce !== observed.nonce) {
              await rename(quarantine, lock).catch(() => undefined); throw new Error('resource lock owner changed during stale-owner recovery');
            }
            await rm(quarantine, { recursive: true, force: true }); continue;
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
      if (this.#now() >= deadline) {
        const detail = observed === null ? 'owner=initializing' : `owner_pid=${observed.pid} owner_host=${observed.host} age_ms=${Math.max(0, this.#now() - Date.parse(observed.created_at))}`;
        throw new Error(`timed out waiting for typed resource ${resource.type}:${resource.id}; ${detail}`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.#poll));
    }
  }
  public async acquire(resources: readonly TypedResource[]): Promise<AcquiredResourceLocks> {
    await this.initialize();
    const ordered = [...new Map(resources.map(normalized).map((item) => [resourceKey(item), item])).values()].sort((a, b) => resourceKey(a).localeCompare(resourceKey(b)));
    const held: Array<{ owner: ResourceLockOwner; lock: string }> = []; const deadline = this.#now() + this.#wait;
    try { for (const resource of ordered) held.push(await this.acquireOne(resource, deadline)); }
    catch (error) { await this.releaseHeld(held); throw error; }
    let released = false;
    return { resources: Object.freeze(ordered), release: async () => { if (!released) { released = true; await this.releaseHeld(held); } } };
  }
  private async releaseHeld(held: Array<{ owner: ResourceLockOwner; lock: string }>): Promise<void> {
    for (const item of [...held].reverse()) {
      const current = await this.owner(item.lock, item.owner.resource_hash.slice(7)).catch(() => null);
      if (current?.nonce === item.owner.nonce && current.pid === item.owner.pid) await rm(item.lock, { recursive: true, force: true });
    }
  }
  public async withResources<T>(resources: readonly TypedResource[], operation: () => Promise<T>): Promise<T> {
    const acquired = await this.acquire(resources); try { return await operation(); } finally { await acquired.release(); }
  }
}
