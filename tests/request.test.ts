import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { STATUS_SCOPE, request } from '../scripts/discourse-sync.mjs';
import { startFakeApis, type FakeApis } from './fake-apis.ts';

/* Security: fetch would send the Api-Key header to any host a redirect names. Function: retries. */
describe('request', () => {
  let fake: FakeApis;
  beforeEach(async () => {
    fake = await startFakeApis();
    fake.addTopic({ id: 42, title: 't', posts: [] });
  });
  afterEach(() => fake.close());
  const paths = () => fake.hits.map(({ url }) => url);

  test('a same-origin GET redirect is followed', async () => {
    fake.fail({
      path: '/t/old.json',
      status: 301,
      headers: { location: '/t/42.json' },
    });
    const response = await request(`${fake.origin}/t/old.json`, {});
    assert.equal((await response.json()).id, 42);
    assert.deepEqual(paths(), ['/t/old.json', '/t/42.json']);
  });

  test('a redirect to another host is refused before any request reaches it', async () => {
    const other = await startFakeApis();
    try {
      fake.fail({
        path: '/t/42.json',
        status: 302,
        headers: { location: `${other.origin}/steal` },
      });
      await assert.rejects(
        request(`${fake.origin}/t/42.json`, {
          headers: { 'Api-Key': 'secret' },
        }),
        /redirected off/,
      );
      assert.deepEqual(other.hits, [], 'the other host saw the request');
    } finally {
      await other.close();
    }
  });

  test('a redirect loop stops after 3 hops', async () => {
    fake.fail({
      path: '/again',
      status: 301,
      headers: { location: '/again' },
      times: 10,
    });
    await assert.rejects(
      request(`${fake.origin}/again`, {}),
      /more than 3 times/,
    );
    assert.equal(fake.hits.length, 4);
  });

  test('a POST is never redirected', async () => {
    fake.fail({
      path: '/posts.json',
      status: 301,
      headers: { location: '/elsewhere' },
    });
    await assert.rejects(
      request(`${fake.origin}/posts.json`, { method: 'POST', body: '{}' }),
      /not followed/,
    );
    assert.deepEqual(paths(), ['/posts.json']);
  });

  for (const [name, status] of [
    ['a 5xx answer', 503],
    ['a dropped connection', 'drop'],
    ['a 429 answer', 429],
  ] as const)
    test(`a GET retries ${name}`, async () => {
      fake.fail({
        path: '/t/42.json',
        status,
        headers: { 'retry-after': '1' },
      });
      const response = await request(`${fake.origin}/t/42.json`, {});
      assert.equal((await response.json()).id, 42);
      assert.deepEqual(paths(), ['/t/42.json', '/t/42.json']);
    });

  test('a GET gives up after 5 attempts', async () => {
    fake.fail({
      path: '/t/42.json',
      status: 503,
      headers: { 'retry-after': '1' },
      times: 10,
    });
    await assert.rejects(
      request(`${fake.origin}/t/42.json`, {}),
      /answered 503/,
    );
    assert.equal(fake.hits.length, 5);
  });

  for (const [name, status] of [
    ['a 5xx answer', 502],
    ['a dropped connection', 'drop'],
  ] as const)
    test(`a POST does not retry ${name}, so it never posts twice`, async () => {
      fake.fail({ path: '/posts.json', status });
      await assert.rejects(
        request(`${fake.origin}/posts.json`, { method: 'POST', body: '{}' }),
      );
      assert.deepEqual(paths(), ['/posts.json']);
    });

  test('a request that could never succeed, such as a bad header, is not retried', async () => {
    const started = performance.now();
    await assert.rejects(
      request(`${fake.origin}/t/42.json`, {
        headers: { 'Api-Key': 'bad\nkey' },
      }),
      /header/i,
    );
    assert.deepEqual(fake.hits, []);
    /* The first retry waits BACKOFF_BASE_MS, 2 s. */
    assert.ok(performance.now() - started < 2_000, 'a bad header was retried');
  });

  test('a POST is not retried sooner than its Retry-After', async () => {
    fake.fail({
      path: '/posts.json',
      status: 429,
      headers: { 'retry-after': '120' },
    });
    await assert.rejects(
      request(`${fake.origin}/posts.json`, { method: 'POST', body: '{}' }),
      /answered 429/,
    );
    assert.deepEqual(paths(), ['/posts.json']);
  });

  for (const value of ['0', '-1', ''])
    test(`a GitHub 429 with Retry-After "${value}" counts as having none, so it is not retried at once`, async () => {
      fake.fail({
        path: '/t/42.json',
        status: 429,
        headers: { 'retry-after': value },
      });
      await assert.rejects(
        request(`${fake.origin}/t/42.json`, {}),
        /answered 429/,
      );
      assert.deepEqual(paths(), ['/t/42.json']);
    });

  test('a 403 names the missing scope', async () => {
    fake.fail({ path: '/posts.json', status: 403 });
    await assert.rejects(
      request(
        `${fake.origin}/posts.json`,
        { method: 'POST', body: '{}' },
        'topics: write',
      ),
      (error: Error) =>
        error.message.includes('needs the "topics: write" scope') &&
        !/trust level 4/.test(error.message),
    );
  });

  test('a 403 on a status change also names the user rights it needs', async () => {
    fake.fail({ path: '/t/42/status.json', status: 403 });
    await assert.rejects(
      request(
        `${fake.origin}/t/42/status.json`,
        { method: 'PUT', body: '{}' },
        STATUS_SCOPE,
      ),
      new RegExp(`needs the "${STATUS_SCOPE}" scope.*trust level 4`),
    );
  });
});
