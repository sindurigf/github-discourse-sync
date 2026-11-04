import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  LINK_COMMENT_PREFIX,
  PR_LINK_COMMENT_PREFIX,
  topicExternalId,
} from '../scripts/discourse-sync.mjs';
import {
  REPOSITORY,
  runMode,
  startFakeApis,
  type FakeApis,
} from './fake-apis.ts';

const issueEvent = {
  issue: {
    number: 3,
    title: 'Crash',
    body: 'Ping @nami about it.',
    html_url: 'https://github.com/o/r/issues/3',
    user: { login: 'robin', type: 'User' },
  },
};
const pullRequestEvent = (overrides: object = {}) => ({
  pull_request: {
    number: 12,
    draft: false,
    title: 'Fix the menu',
    body: 'Fixes the menu.',
    html_url: 'https://github.com/o/r/pull/12',
    user: { login: 'robin', type: 'User' },
    ...overrides,
  },
});

describe('open-topic', () => {
  let fake: FakeApis;
  beforeEach(async () => {
    fake = await startFakeApis();
  });
  afterEach(() => fake.close());

  test('a new issue opens a topic with its own external_id and links it from the issue', async () => {
    fake.addIssue({ number: 3 });
    const run = await runMode('open-topic', fake, issueEvent);
    assert.equal(run.code, 0, run.stderr);
    const [topic] = fake.topics;
    assert.equal(topic?.title, 'GitHub issue #3: Crash');
    assert.equal(topic?.category_id, 5);
    assert.equal(topic?.external_id, topicExternalId(REPOSITORY, 3, false));
    assert.ok(topic?.posts[0]?.raw.includes('Ping @​nami'));
    assert.deepEqual(
      fake.issues.get(3)?.comments.map(({ body }) => body),
      [`${LINK_COMMENT_PREFIX}${fake.origin}/t/topic/${topic?.id}`],
    );
  });

  test('a ready pull request opens a topic and links it with the pull request text', async () => {
    fake.addIssue({ number: 12, pullRequest: true });
    const run = await runMode('open-topic', fake, pullRequestEvent());
    assert.equal(run.code, 0, run.stderr);
    const [topic] = fake.topics;
    assert.equal(topic?.external_id, topicExternalId(REPOSITORY, 12, true));
    assert.deepEqual(
      fake.issues.get(12)?.comments.map(({ body }) => body),
      [`${PR_LINK_COMMENT_PREFIX}${fake.origin}/t/topic/${topic?.id}`],
    );
  });

  test('an issue opened by a bot opens no topic', async () => {
    const run = await runMode('open-topic', fake, {
      issue: {
        ...issueEvent.issue,
        user: { login: 'renovate[bot]', type: 'Bot' },
      },
    });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(fake.hits, []);
  });

  test('a mode name inherited from Object, such as constructor, is refused', async () => {
    const run = await runMode('constructor', fake);
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /Usage: discourse-sync\.mjs/);
  });

  for (const [name, event] of [
    ['a draft', pullRequestEvent({ draft: true })],
    [
      'a bot',
      pullRequestEvent({ user: { login: 'renovate[bot]', type: 'Bot' } }),
    ],
  ] as const)
    test(`a pull request from ${name} opens no topic`, async () => {
      const run = await runMode('open-topic', fake, event);
      assert.equal(run.code, 0, run.stderr);
      assert.deepEqual(fake.hits, []);
    });

  test('a second run posts nothing', async () => {
    fake.addIssue({ number: 3 });
    await runMode('open-topic', fake, issueEvent);
    const before = fake.writes().length;
    const run = await runMode('open-topic', fake, issueEvent);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(fake.writes().length, before);
  });

  for (const [kind, number, event] of [
    ['an issue', 3, issueEvent],
    ['a pull request', 12, pullRequestEvent()],
  ] as const)
    test(`a run for ${kind} that opened the topic but failed to comment links that topic on a re-run`, async () => {
      fake.addIssue({ number, pullRequest: number === 12 });
      fake.fail({
        method: 'POST',
        path: `/repos/o/r/issues/${number}/comments`,
        status: 422,
      });
      assert.notEqual((await runMode('open-topic', fake, event)).code, 0);
      const run = await runMode('open-topic', fake, event);
      assert.equal(run.code, 0, run.stderr);
      assert.equal(fake.topics.length, 1, 'the re-run opened a second topic');
      assert.equal(
        fake.hits.filter(({ url }) => url === '/posts.json').length,
        1,
      );
      assert.equal(fake.issues.get(number)?.comments.length, 1);
    });

  test('a bad category id fails before anything is posted', async () => {
    fake.addIssue({ number: 3 });
    const run = await runMode('open-topic', fake, issueEvent, {
      DISCOURSE_CATEGORY_ID: '5abc',
    });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /Set DISCOURSE_CATEGORY_ID/);
    assert.deepEqual(fake.writes(), []);
  });

  test('a 403 on posting names the missing scope', async () => {
    fake.addIssue({ number: 3 });
    fake.fail({ method: 'POST', path: '/posts.json', status: 403 });
    const run = await runMode('open-topic', fake, issueEvent);
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /needs the "topics: write" scope/);
  });

  test('a 5xx on posting is not retried, so a topic is never posted twice', async () => {
    fake.addIssue({ number: 3 });
    fake.fail({ method: 'POST', path: '/posts.json', status: 502 });
    const run = await runMode('open-topic', fake, issueEvent);
    assert.notEqual(run.code, 0);
    assert.equal(
      fake.hits.filter(({ url }) => url === '/posts.json').length,
      1,
    );
  });

  test('a 429 on posting waits and retries', async () => {
    fake.addIssue({ number: 3 });
    fake.fail({
      method: 'POST',
      path: '/posts.json',
      status: 429,
      headers: { 'retry-after': '1' },
    });
    const run = await runMode('open-topic', fake, issueEvent);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(fake.topics.length, 1);
  });
});
