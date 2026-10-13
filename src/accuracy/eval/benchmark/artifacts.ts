/** Private filesystem boundary. No environment, database or provider imports. */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

/** Canonical JSON for input, checkpoint and review-content identities. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).filter(k => row[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(row[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
/** SHA-256 binds contents, not merely caller-supplied identity labels. */
export function artifactDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
/** Escape spreadsheet formulas as well as RFC4180 quotes/newlines. */
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
/** Format a rectangular analysis table safely for spreadsheet import. */
export function analysisCsv(rows: unknown[][]): string { return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'; }

/** One exclusive private batch owner; callers must close in finally. */
export class PrivateBatchStorage {
  private readonly ignoredNames = new Set(['.lock', 'manifest.json', 'interim.json', 'final.json', 'interim-report.md', 'runs.csv', 'findings.csv', 'attempts.csv', 'jobs.csv']);
  private constructor(readonly root: string, readonly directory: string, private lockToken: string) {}
  /** Verify actual Git exclusion and path components before any source write.
   * Lock files are exclusive; a stale crash lock requires local operator recovery.
   */
  static async acquire(root: string, relative: string): Promise<PrivateBatchStorage> {
    if (!/^data\/runtime\/benchmark\/[A-Za-z0-9_-]+$/.test(relative)) throw new Error('Unsafe storage path');
    const resolvedRoot = await realpath(root);
    const directory = path.resolve(resolvedRoot, relative);
    if (!directory.startsWith(resolvedRoot + path.sep)) throw new Error('Storage containment failed');
    // An ignored directory excludes its newly created descendants, including fresh
    // exclusive temporary files. Verify named artifacts too, catching force-tracked files.
    await promisify(execFile)('git', ['check-ignore', '--quiet', '--', relative + '/'], { cwd: resolvedRoot, timeout: 10_000 });
    const names = ['.lock', 'manifest.json', 'interim.json', 'final.json', 'interim-report.md', 'runs.csv', 'findings.csv', 'attempts.csv', 'jobs.csv'].map(n => `${relative}/${n}`);
    const ignored = await promisify(execFile)('git', ['check-ignore', '--', ...names], { cwd: resolvedRoot, timeout: 10_000 });
    const verified = new Set(ignored.stdout.trim().split('\n'));
    if (names.some(n => !verified.has(n))) throw new Error('Artifact is not excluded from Git');
    let cursor = resolvedRoot;
    for (const part of relative.split('/')) {
      cursor = path.join(cursor, part);
      try { await mkdir(cursor, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(cursor) !== cursor) throw new Error('Symlink storage traversal rejected');
      if (cursor === directory && (stat.mode & 0o077)) throw new Error('Private directory permissions required');
    }
    const token = randomUUID();
    const handle = await open(path.join(directory, '.lock'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify({ token, pid: process.pid })); await handle.sync(); } finally { await handle.close(); }
    return new PrivateBatchStorage(resolvedRoot, directory, token);
  }
  /** Check all ancestors again for each operation; never follow an artifact symlink. */
  private async checked(name: string): Promise<string> {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('Unsafe artifact name');
    let cursor = this.root;
    for (const part of path.relative(this.root, this.directory).split(path.sep)) {
      cursor = path.join(cursor, part);
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(cursor) !== cursor || cursor === this.directory && (stat.mode & 0o077)) throw new Error('Storage changed');
    }
    const target = path.join(this.directory, name);
    if (!this.ignoredNames.has(name) && !/\.[0-9a-f-]{36}\.tmp$/.test(name)) {
      await promisify(execFile)('git', ['check-ignore', '--quiet', '--', path.relative(this.root, target)], { cwd: this.root, timeout: 10_000 });
      this.ignoredNames.add(name);
    }
    try { const stat = await lstat(target); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)) throw new Error('Unsafe artifact'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    return target;
  }
  /** Read a private regular file without following symlinks; missing is null. */
  async read(name: string): Promise<string | null> {
    const target = await this.checked(name);
    let handle;
    try { handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    try { return await handle.readFile('utf8'); } finally { await handle.close(); }
  }
  /** fsync an exclusive temporary file, then atomically replace the artifact. */
  async write(name: string, contents: string): Promise<void> {
    const target = await this.checked(name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await this.checked(path.basename(temporary));
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    try { await this.checked(name); await rename(temporary, target); const dir = await open(this.directory, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); } }
    finally { await unlink(temporary).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }); }
  }
  /** Release only this owner's lock; concurrent owners never delete one another. */
  async close(): Promise<void> {
    const lock = await this.read('.lock');
    if (!lock || JSON.parse(lock).token !== this.lockToken) throw new Error('Batch ownership changed');
    await unlink(path.join(this.directory, '.lock'));
  }
}
