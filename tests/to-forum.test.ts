import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { LINK_COMMENT_PREFIX, markerOf } from '../scripts/discourse-sync.mjs';
import {
  API_USER,
  BOT_LOGIN,
  runMode,
  startFakeApis,
  type FakeApis,
  type Topic,
} from './fake-apis.ts';

const comment = {
  id: 9,
  user: { login: 'robin', type: 'User' },
  body: 'Still broken, @nami.',
  html_url: 'https://github.com/o/r/issues/3#issuecomment-9',
};
const event = (body = comment.body) => ({
  comment: { ...comment, body },
  issue: { number: 3 },
});

/* Function: a person's comment reaches its topic once, and no copy loops back. */
describe('to-forum', () => {
  let fake: FakeApis;
  let topic: Topic;
  beforeEach(async () => {
    fake = await startFakeApis({ latestPerPage: 30, commentsPerPage: 2 });
    topic = fake.addTopic({
      id: 42,
      title: 'GitHub issue #3: Crash',
      posts: [
        {
          id: 1,
          post_number: 1,
          post_type: 1,
          username: API_USER,
          raw: 'Opened',
        },
      ],
    });
    fake.addIssue({
      number: 3,
      comments: [
        {
          id: 1,
          user: { login: 'nami', type: 'User' },
          body: 'First',
          html_url: 'u1',
        },
        {
          id: 2,
          user: { login: 'nami', type: 'User' },
          body: 'Second',
          html_url: 'u2',
        },
        {
          id: 3,
          user: { login: BOT_LOGIN, type: 'Bot' },
          body: `${LINK_COMMENT_PREFIX}https://forum.example.com/t/crash/42`,
          html_url: 'u3',
        },
      ],
    });
  });
  afterEach(() => fake.close());

  test('a comment from a person becomes a reply, found through a link comment on a later page', async () => {
    const run = await runMode('to-forum', fake, event());
    assert.equal(run.code, 0, run.stderr);
    assert.equal(
      topic.posts.at(-1)?.raw,
      `robin wrote on GitHub:\n\nStill broken, @\u200bnami.\n\n${comment.html_url}`,
    );
  });

  test('a second run of the same comment posts nothing', async () => {
    await runMode('to-forum', fake, event());
    const run = await runMode('to-forum', fake, event());
    assert.equal(run.code, 0, run.stderr);
    assert.equal(topic.posts.length, 2);
  });

  test('a forum reply the bot copied to GitHub does not come back', async () => {
    const copied = `nami wrote on the forum:\n\nHello\n\nhttps://forum.example.com/t/crash/42/2\n${markerOf(7)}`;
    const run = await runMode('to-forum', fake, event(copied));
    assert.equal(run.code, 0, run.stderr);
    assert.equal(topic.posts.length, 1);
  });

  test('a person quoting the comment link in the topic does not stop the comment', async () => {
    topic.posts.push({
      id: 7,
      post_number: 2,
      post_type: 1,
      username: 'nami',
      raw: `See\n\n${comment.html_url}`,
    });
    const run = await runMode('to-forum', fake, event());
    assert.equal(run.code, 0, run.stderr);
    assert.equal(topic.posts.length, 3);
  });

  test('a mirror-shaped post from someone other than the API user does not stop the comment', async () => {
    topic.posts.push({
      id: 7,
      post_number: 2,
      post_type: 1,
      username: 'mallory',
      raw: `robin wrote on GitHub:\n\nForged\n\n${comment.html_url}`,
    });
    const run = await runMode('to-forum', fake, event());
    assert.equal(run.code, 0, run.stderr);
    assert.equal(topic.posts.length, 3);
  });

  test('a forum that never answers fails the run at its deadline with a clear error', async () => {
    fake.fail({ path: '/t/42.json', status: 'hang' });
    const started = performance.now();
    const run = await runMode('to-forum', fake, event(), {
      SYNC_DEADLINE_MS: '1500',
    });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /passed its 1\.5 s run deadline/);
    assert.ok(performance.now() - started < 10_000);
  });

  test('a GitHub next-page link to another host is not followed, so the token stays on GitHub', async () => {
    const other = await startFakeApis();
    try {
      fake.fail({
        method: 'GET',
        path: '/repos/o/r/issues/3/comments',
        status: 200,
        headers: { link: `<${other.origin}/steal?page=2>; rel="next"` },
        body: [],
      });
      const run = await runMode('to-forum', fake, event());
      assert.notEqual(run.code, 0);
      assert.match(run.stderr, /not followed/);
      assert.deepEqual(other.hits, [], 'the other host saw the token');
    } finally {
      await other.close();
    }
  });

  for (const [name, env, setting] of [
    [
      'an API key with a control character',
      { DISCOURSE_API_KEY: `${'a'.repeat(63)}\n` },
      'DISCOURSE_API_KEY',
    ],
    [
      'an API key that is not 64 hex characters',
      { DISCOURSE_API_KEY: 'not-a-key-but-secret' },
      'DISCOURSE_API_KEY',
    ],
    [
      'an API username with a control character',
      { DISCOURSE_API_USERNAME: 'bot\u0007name' },
      'DISCOURSE_API_USERNAME',
    ],
    [
      'an API username outside Latin-1',
      { DISCOURSE_API_USERNAME: '中文' },
      'DISCOURSE_API_USERNAME',
    ],
    [
      'a forum URL over http',
      { DISCOURSE_URL: 'http://forum.example.com' },
      'DISCOURSE_URL',
    ],
    [
      'a forum URL with credentials',
      { DISCOURSE_URL: 'https://user:pass@forum.example.com' },
      'DISCOURSE_URL',
    ],
    [
      'a forum URL with a query',
      { DISCOURSE_URL: 'https://forum.example.com/?a=1' },
      'DISCOURSE_URL',
    ],
    [
      'a forum URL with a fragment',
      { DISCOURSE_URL: 'https://forum.example.com/#x' },
      'DISCOURSE_URL',
    ],
    [
      'a forum URL that does not parse',
      { DISCOURSE_URL: 'not a url' },
      'DISCOURSE_URL',
    ],
  ] as [string, Record<string, string>, string][])
    test(`${name} is refused before any request, without printing the value`, async () => {
      const run = await runMode('to-forum', fake, event(), env);
      assert.notEqual(run.code, 0);
      assert.match(run.stderr, new RegExp(setting));
      for (const value of Object.values(env))
        assert.ok(
          !run.stderr.includes(value),
          'the error prints the setting value',
        );
      assert.deepEqual(fake.hits, []);
    });

  test('a forum rate limit of up to a minute is waited out, not reported, until the deadline', async () => {
    fake.fail({
      path: '/t/42.json',
      status: 429,
      headers: { 'retry-after': '45' },
      times: 10,
    });
    const run = await runMode('to-forum', fake, event(), {
      SYNC_DEADLINE_MS: '1500',
    });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /run deadline/);
    assert.doesNotMatch(run.stderr, /answered 429/);
  });

  test('an issue with no topic is skipped', async () => {
    fake.issues.get(3)!.comments.pop();
    const run = await runMode('to-forum', fake, event());
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(fake.writes(), []);
  });

  test('a 403 on posting names the missing scope', async () => {
    fake.fail({ method: 'POST', path: '/posts.json', status: 403 });
    const run = await runMode('to-forum', fake, event());
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /needs the "topics: write" scope/);
  });

  test('a 5xx or dropped connection on a read is retried', async () => {
    fake.fail({
      path: '/t/42.json',
      status: 503,
      headers: { 'retry-after': '1' },
    });
    fake.fail({ path: /^\/repos\//, status: 'drop' });
    const run = await runMode('to-forum', fake, event());
    assert.equal(run.code, 0, run.stderr);
    assert.equal(topic.posts.length, 2);
  });
});
