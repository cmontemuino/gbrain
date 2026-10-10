/**
 * #6383 (and the driver desync behind #6352): a statement that fails to build
 * (`UNDEFINED_VALUE`, `MAX_PARAMETERS_EXCEEDED`) used to join the connection's
 * queue before it was built, so when another statement was already in flight
 * the failure rejected that head statement with the wrong error, left the
 * culprit queued with nothing on the wire, and every later reply on the socket
 * was delivered one statement late. A describe-first statement then never got
 * its ParameterDescription, so its Bind/Execute/Sync was never sent and the
 * backend sat `active / ClientRead` until the process restarted.
 *
 * Protects: only the culprit rejects, with its own error; the head and every
 * later statement resolve with their own rows; the backend returns to idle; a
 * transaction with a bad member rolls back cleanly; the pool reports each
 * build failure through `onbuilderror` with the statement's text and no
 * parameter values. Regression that fails it on master: `next` and `later`
 * never settle (the 5 s race below reports `hung`), and the backend stays
 * `active`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const url = process.env.DATABASE_URL;
const opened: Array<{ end: (o?: { timeout?: number }) => Promise<void> }> = [];

afterEach(async () => {
  while (opened.length) await opened.pop()!.end({ timeout: 1 }).catch(() => {});
});

type Settled = { rows: unknown[] } | { code: string } | { hung: true };

function settle(query: PromiseLike<unknown>, ms = 5000): Promise<Settled> {
  return Promise.race([
    Promise.resolve(query).then(rows => ({ rows: rows as unknown[] }), (e: { code?: string; message?: string }) => ({ code: e.code ?? e.message ?? 'error' })),
    new Promise<Settled>(resolve => setTimeout(() => resolve({ hung: true }), ms)),
  ]);
}

function pool(max: number, builds: Array<[string, string]>, driver: typeof postgres = postgres) {
  assertSafeE2eDatabaseUrl(url!);
  const appName = `gbrain-6383-${Math.random().toString(36).slice(2)}`;
  const sql = driver(url!, {
    max,
    prepare: false,
    shared_types: true,
    onnotice: () => {},
    connection: { application_name: appName },
    onbuilderror: (code: string, statement: string) => { builds.push([code, statement]); },
  } as Parameters<typeof postgres>[1]);
  opened.push(sql);
  return { sql, appName };
}

async function backendStates(appName: string): Promise<string[]> {
  const observer = postgres(url!, { max: 1, onnotice: () => {} });
  opened.push(observer);
  const rows = await observer<{ state: string }[]>`SELECT state FROM pg_stat_activity WHERE application_name = ${appName}`;
  return rows.map(r => r.state);
}

describe.skipIf(!url)('#6383 a statement that fails to build never desyncs its connection', () => {
  test('a culprit pipelined behind a head statement rejects alone; head, a describe-first follower and later statements resolve', async () => {
    const builds: Array<[string, string]> = [];
    const { sql, appName } = pool(1, builds);
    await sql`SELECT 1`;
    const head = settle(sql`SELECT pg_sleep(0.3), 'head' AS who`);
    const culprit = settle(sql`SELECT ${undefined as unknown as string}::text AS who`);
    const next = settle(sql`SELECT 'next' AS who, ${1}::int AS n`);
    expect(await head).toEqual({ rows: [{ pg_sleep: '', who: 'head' }] });
    expect(await culprit).toEqual({ code: 'UNDEFINED_VALUE' });
    expect(await next).toEqual({ rows: [{ who: 'next', n: 1 }] });
    expect(await settle(sql`SELECT 'later' AS who`)).toEqual({ rows: [{ who: 'later' }] });
    expect(await backendStates(appName)).toEqual(['idle']);
    expect(builds).toEqual([['UNDEFINED_VALUE', 'SELECT $1::text AS who']]);
  });

  test('a culprit as the head statement of an idle connection leaves it usable, and so does one on a reserved connection', async () => {
    const builds: Array<[string, string]> = [];
    const { sql } = pool(1, builds);
    expect(await settle(sql`SELECT ${undefined as unknown as string}::text`)).toEqual({ code: 'UNDEFINED_VALUE' });
    expect(await settle(sql`SELECT 'after' AS who`)).toEqual({ rows: [{ who: 'after' }] });
    const reserved = await sql.reserve();
    expect(await settle(reserved`SELECT ${undefined as unknown as string}::text`)).toEqual({ code: 'UNDEFINED_VALUE' });
    expect(await settle(reserved`SELECT 'reserved' AS who`)).toEqual({ rows: [{ who: 'reserved' }] });
    reserved.release();
    expect(await settle(sql`SELECT 'pooled' AS who`)).toEqual({ rows: [{ who: 'pooled' }] });
    expect(builds.map(b => b[0])).toEqual(['UNDEFINED_VALUE', 'UNDEFINED_VALUE']);
  });

  test('a transaction with a bad member rolls back and the backend is idle, not left in the transaction', async () => {
    const builds: Array<[string, string]> = [];
    const { sql, appName } = pool(1, builds);
    const tx = await settle(sql.begin(async tx => Promise.allSettled([
      tx`SELECT 1 AS a`,
      tx`SELECT ${undefined as unknown as string}::text`,
      tx`SELECT 2 AS b, ${3}::int AS c`,
    ])));
    expect(tx).toEqual({ code: 'UNDEFINED_VALUE' });
    expect(await settle(sql`SELECT 'after' AS who`)).toEqual({ rows: [{ who: 'after' }] });
    expect(await backendStates(appName)).toEqual(['idle']);
  });

  test('MAX_PARAMETERS_EXCEEDED behind a head statement is rejected alone too', async () => {
    const builds: Array<[string, string]> = [];
    const { sql } = pool(1, builds);
    await sql`SELECT 1`;
    const head = settle(sql`SELECT pg_sleep(0.2), 'head' AS who`);
    const tooMany = settle(sql.unsafe(`SELECT ${Array.from({ length: 65534 }, (_, i) => `$${i + 1}::int`).join(',')}`, Array.from({ length: 65534 }, (_, i) => i)));
    const next = settle(sql`SELECT 'next' AS who, ${1}::int AS n`);
    expect(await head).toEqual({ rows: [{ pg_sleep: '', who: 'head' }] });
    expect(await tooMany).toEqual({ code: 'MAX_PARAMETERS_EXCEEDED' });
    expect(await next).toEqual({ rows: [{ who: 'next', n: 1 }] });
    expect(builds.map(b => b[0])).toEqual(['MAX_PARAMETERS_EXCEEDED']);
  });

  test('CommonJS build behaves the same', async () => {
    const cjs = createRequire(import.meta.url)('#postgres') as typeof postgres;
    expect(cjs).not.toBe(postgres);
    const builds: Array<[string, string]> = [];
    const { sql } = pool(1, builds, cjs);
    await sql`SELECT 1`;
    const head = settle(sql`SELECT pg_sleep(0.2), 'head' AS who`);
    const culprit = settle(sql`SELECT ${undefined as unknown as string}::text AS who`);
    const next = settle(sql`SELECT 'next' AS who, ${1}::int AS n`);
    expect(await head).toEqual({ rows: [{ pg_sleep: '', who: 'head' }] });
    expect(await culprit).toEqual({ code: 'UNDEFINED_VALUE' });
    expect(await next).toEqual({ rows: [{ who: 'next', n: 1 }] });
    expect(builds).toEqual([['UNDEFINED_VALUE', 'SELECT $1::text AS who']]);
  });
});
