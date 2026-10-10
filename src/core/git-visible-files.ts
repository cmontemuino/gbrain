import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'child_process';
import { lstatSync } from 'fs';
import { dirname, join, resolve } from 'path';

interface GitScope {
  /** Successful listings; a failure is not memoized (an outside-repo failure is, below, until a `.git` changes). */
  listings: Map<string, string>;
  /** Directories git reported outside any repository, each with the `.git` markers it saw then. */
  outside: Map<string, string>;
}

const gitScope = new AsyncLocalStorage<GitScope>();

/**
 * Run `fn` with `git ls-files` listings memoized per directory and arguments
 * for every `gitLsFiles` call inside it, plus the "not a git repository"
 * verdict per directory. Doctor wraps its check run in one so the checks that
 * each list or probe the same source checkout (frontmatter scan, fence census,
 * slug collisions, the frontmatter hook) spawn git once instead of once per
 * check; code outside the scope always spawns. A git command that changes a
 * repository (sync-git.ts) drops the scope's memo (`invalidateGitListingCache`),
 * and an outside-repo verdict lapses as soon as a `.git` appears, changes or
 * goes away in the directory or above it.
 */
export function withGitListingCache<T>(fn: () => Promise<T>): Promise<T> {
  return gitScope.run({ listings: new Map(), outside: new Map() }, fn);
}

/** Drop every listing and verdict memoized in the current scope (no-op outside one): call after changing a checkout inside it. */
export function invalidateGitListingCache(): void {
  const scope = gitScope.getStore();
  scope?.listings.clear();
  scope?.outside.clear();
}

/** The `.git` entries from `dir` up to the filesystem root: what decides whether git finds a repository there. */
function gitMarkers(dir: string): string {
  const seen: string[] = [];
  for (let at = dir; ; at = dirname(at)) {
    try {
      const st = lstatSync(join(at, '.git'));
      seen.push(`${at}\0${st.ino}\0${st.mtimeMs}`);
    } catch { /* no marker here */ }
    if (dirname(at) === at) return seen.join('\n');
  }
}

/** True when the current scope saw git report `dir` outside any repository and no `.git` marker changed since. */
export function knownOutsideGitRepo(dir: string): boolean {
  const scope = gitScope.getStore();
  const key = resolve(dir);
  const markers = scope?.outside.get(key);
  if (markers === undefined) return false;
  if (markers === gitMarkers(key)) return true;
  scope!.outside.delete(key);
  return false;
}

/** Record a failed git command run in `dir`: its stderr saying "not a git repository" is remembered for the current scope. */
export function noteGitFailure(dir: string, error: unknown): void {
  const scope = gitScope.getStore();
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  if (!scope || !/not a git repository/i.test(String(stderr ?? ''))) return;
  const key = resolve(dir);
  scope.outside.set(key, gitMarkers(key));
}

/** `git -C <dir> ls-files <args>` stdout, or null when git fails (memoized inside withGitListingCache). */
export function gitLsFiles(dir: string, args: string[]): string | null {
  const cache = gitScope.getStore()?.listings;
  const key = `${dir}\0${args.join('\0')}`;
  const hit = cache?.get(key);
  if (hit !== undefined) return hit;
  if (knownOutsideGitRepo(dir)) return null;
  try {
    const stdout = execFileSync('git', ['-C', dir, 'ls-files', ...args], {
      encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    cache?.set(key, stdout);
    return stdout;
  } catch (error) {
    noteGitFailure(dir, error);
    return null;
  }
}

/**
 * Return files visible to git from `dir`, respecting .gitignore,
 * .git/info/exclude, and global git excludes. Returns null when `dir` is not
 * inside a git work tree or git is unavailable, so callers can keep their
 * existing filesystem-walk fallback.
 */
export function collectGitVisibleFiles(
  dir: string,
  acceptRelPath: (relPath: string) => boolean,
): string[] | null {
  const stdout = gitLsFiles(dir, ['--cached', '--others', '--exclude-standard', '-z']);
  if (stdout === null) return null;

  const ignoredTracked = new Set<string>();
  for (const rel of (gitLsFiles(dir, ['-ci', '--exclude-standard', '-z']) ?? '').split('\0')) {
    if (rel) ignoredTracked.add(rel);
  }

  const files: string[] = [];
  for (const rel of stdout.split('\0')) {
    if (!rel) continue;
    if (ignoredTracked.has(rel)) continue;
    const normalizedRel = rel.replace(/\\/g, '/');
    if (!acceptRelPath(normalizedRel)) continue;

    const full = join(dir, rel);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    files.push(full);
  }

  return files.sort();
}
