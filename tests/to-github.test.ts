import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  LINK_COMMENT_PREFIX,
  splitByActivity,
} from '../scripts/discourse-sync.mjs';
import {
  API_USER,
  BOT_LOGIN,
  runMode,
  startFakeApis,
  type FakeApis,
  type Post,
} from './fake-apis.ts';

const HOUR_MS = 3_600_000;
const hoursAgo = (hours: number) =>
  new Date(Date.now() - hours * HOUR_MS).toISOString();
const opened: Post = {
  id: 1,
  post_number: 1,
  post_type: 1,
  username: API_USER,
  raw: 'Opened',
};
let nextPostId = 500;
const personReply = (raw: string, username = 'nami'): Post => {
  nextPostId += 1;
  return { id: nextPostId, post_number: 0, post_type: 1, username, raw };
};
const numbered = (posts: Post[]) =>
  posts.map((post, i) => ({ ...post, post_number: i + 1 }));

describe('to-github', () => {
  let fake: FakeApis;
  beforeEach(async () => {
    fake = await startFakeApis({ latestPerPage: 2, commentsPerPage: 2 });
  });
  afterEach(() => fake.close());

  const linkedIssue = (number: number, topicId: number, pullRequest = false) =>
    fake.addIssue({
      number,
      pullRequest,
      comments: [
        {
          id: number * 10,
          user: { login: BOT_LOGIN, type: 'Bot' },
          body: `${LINK_COMMENT_PREFIX}https://forum.example/t/crash/${topicId}`,
          html_url: 'u',
        },
      ],
    });
  const linkedTopic = (
    id: number,
    issue: number,
    replies: Post[],
    extra: object = {},
  ) =>
    fake.addTopic({
      id,
      title: `GitHub issue #${issue}: Crash`,
      posts: numbered([opened, ...replies]),
      ...extra,
    });
  const copiedBodies = (issue: number) =>
    fake.issues
      .get(issue)!
      .comments.filter(({ body }) => body.includes('wrote on the forum'))
      .map(({ body }) => body.split('\n')[2]);

  test('a reply from a person is copied with its link and marker, in post order', async () => {
    linkedIssue(3, 42);
    linkedTopic(42, 3, [personReply('First'), personReply('@luffy second')]);
    const run = await runMode('to-github', fake);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(copiedBodies(3), ['First', '@​luffy second']);
    assert.match(run.stdout, /Copied 2 forum replies to GitHub\./);
  });

  test('a second run copies nothing', async () => {
    linkedIssue(3, 42);
    linkedTopic(42, 3, [personReply('First')]);
    await runMode('to-github', fake);
    const before = fake.writes().length;
    const run = await runMode('to-github', fake);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(fake.writes().length, before);
  });

  test('a GitHub comment the bot copied to the forum does not come back, under any API user', async () => {
    linkedIssue(3, 42);
    const mirror =
      'robin wrote on GitHub:\n\nHi\n\nhttps://github.com/o/r/issues/3#issuecomment-9';
    linkedTopic(42, 3, [
      personReply(mirror, API_USER),
      personReply(mirror, 'old-bot'),
    ]);
    const run = await runMode('to-github', fake);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(copiedBodies(3), []);
  });

  test('a reply copied to GitHub and that copy fed back to to-forum post nothing more', async () => {
    linkedIssue(3, 42);
    const topic = linkedTopic(42, 3, [personReply('Round trip')]);
    await runMode('to-github', fake);
    const copy = fake.issues.get(3)!.comments.at(-1)!;
    const run = await runMode('to-forum', fake, {
      comment: copy,
      issue: { number: 3 },
    });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(topic.posts.length, 2, 'the copy went back to the forum');
  });

  test('a comment copied to the forum does not come back on the next to-github run', async () => {
    linkedIssue(3, 42);
    const topic = linkedTopic(42, 3, []);
    const comment = {
      id: 9,
      user: { login: 'robin', type: 'User' },
      body: 'From GitHub',
      html_url: 'https://github.com/o/r/issues/3#issuecomment-9',
    };
    await runMode('to-forum', fake, { comment, issue: { number: 3 } });
    assert.equal(topic.posts.length, 2);
    const run = await runMode('to-github', fake);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(copiedBodies(3), []);
  });

  test('replies and link comments are found across pages of both APIs', async () => {
    const comments = fake.addIssue({ number: 3 }).comments;
    for (const id of [1, 2, 3])
      comments.push({
        id,
        user: { login: 'nami', type: 'User' },
        body: `c${id}`,
        html_url: 'u',
      });
    comments.push({
      id: 4,
      user: { login: BOT_LOGIN, type: 'Bot' },
      body: `${LINK_COMMENT_PREFIX}https://forum.example/t/crash/42`,
      html_url: 'u',
    });
    for (const id of [40, 41])
      linkedTopic(id, 99, [], { bumped_at: hoursAgo(1) });
    const replies = Array.from({ length: 150 }, (_, i) => personReply(`r${i}`));
    linkedTopic(42, 3, replies, { bumped_at: hoursAgo(2) });
    const run = await runMode('to-github', fake);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(copiedBodies(3).length, 150);
    const batches = fake.hits.filter(({ url }) =>
      url.startsWith('/t/42/posts.json'),
    );
    assert.equal(batches.length, 2, 'posts are read in batches of at most 100');
  });

  test('a topic older than the window is not read, and paging stops there', async () => {
    linkedIssue(3, 42);
    linkedTopic(42, 3, [personReply('Old')], { bumped_at: hoursAgo(72) });
    for (const id of [43, 44, 45])
      linkedTopic(id, 9, [], { bumped_at: hoursAgo(80 + id) });
    const run = await runMode('to-github', fake);
    assert.equal(run.code, 0, run.stderr);
    assert.ok(!fake.hits.some(({ url }) => url.startsWith('/t/42')));
    assert.ok(!fake.hits.some(({ url }) => url.includes('page=1')));
  });

  test('a pinned topic bumped inside the window syncs', async () => {
    linkedIssue(3, 42);
    linkedTopic(42, 3, [personReply('Pinned reply')], { pinned: true });
    const run = await runMode('to-github', fake);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(copiedBodies(3), ['Pinned reply']);
  });

  test('a topic with no reply from a person costs no GitHub request', async () => {
    linkedIssue(3, 42);
    linkedTopic(42, 3, [
      personReply(
        'Closed on GitHub by robin.\n\nEvent time: 2026-11-01T07:00:00Z',
        API_USER,
      ),
    ]);
    const run = await runMode('to-github', fake);
    assert.equal(run.code, 0, run.stderr);
    assert.ok(!fake.hits.some(({ url }) => url.startsWith('/repos/')));
  });

  for (const [name, setup] of [
    [
      'a deleted issue',
      (f: FakeApis) => f.addIssue({ number: 3, deleted: true }),
    ],
    [
      'an issue moved to another repository',
      (f: FakeApis) => f.addIssue({ number: 3, transferred: true }),
    ],
    [
      'a pull request under an issue title',
      (f: FakeApis) => f.addIssue({ number: 3, pullRequest: true }),
    ],
    [
      'an issue linked to another topic',
      (f: FakeApis) => {
        linkedIssue(3, 77);
        return f;
      },
    ],
  ] as const)
    test(`${name} is skipped while later topics still sync`, async () => {
      setup(fake);
      linkedTopic(42, 3, [personReply('Lost')], { bumped_at: hoursAgo(1) });
      linkedIssue(4, 43);
      linkedTopic(43, 4, [personReply('Kept')], { bumped_at: hoursAgo(2) });
      const run = await runMode('to-github', fake);
      assert.equal(run.code, 0, run.stderr);
      assert.deepEqual(copiedBodies(4), ['Kept']);
      assert.ok(
        !fake
          .writes()
          .some(({ url }) => url.startsWith('/repos/o/r/issues/3/')),
      );
    });

  test('one failing topic is reported and fails the run, and later topics still sync', async () => {
    linkedIssue(3, 42);
    linkedTopic(42, 3, [personReply('Lost')], { bumped_at: hoursAgo(1) });
    linkedIssue(4, 43);
    linkedTopic(43, 4, [personReply('Kept')], { bumped_at: hoursAgo(2) });
    fake.fail({ path: '/t/42.json', status: 403 });
    const run = await runMode('to-github', fake);
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /Could not sync topic 42/);
    assert.deepEqual(copiedBodies(4), ['Kept']);
  });

  test('a forum that keeps failing stops the run instead of retrying every topic', async () => {
    linkedIssue(3, 42);
    linkedTopic(42, 3, [personReply('Lost')], { bumped_at: hoursAgo(1) });
    linkedIssue(4, 43);
    linkedTopic(43, 4, [personReply('Kept')], { bumped_at: hoursAgo(2) });
    fake.fail({
      path: '/t/42.json',
      status: 503,
      headers: { 'retry-after': '1' },
      times: 10,
    });
    const run = await runMode('to-github', fake);
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /Could not sync topic 42/);
    assert.match(run.stderr, /Stopped before 1 more topic/);
    assert.ok(!fake.hits.some(({ url }) => url.startsWith('/t/43')));
  });

  test('a GitHub rate limit stops the run instead of calling GitHub again', async () => {
    linkedIssue(3, 42);
    linkedTopic(42, 3, [personReply('Lost')], { bumped_at: hoursAgo(1) });
    linkedIssue(4, 43);
    linkedTopic(43, 4, [personReply('Kept')], { bumped_at: hoursAgo(2) });
    fake.fail({ path: '/repos/o/r/issues/3', status: 403 });
    const run = await runMode('to-github', fake);
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /Stopped before 1 more topic/);
    assert.ok(
      !fake.hits.some(({ url }) => url.startsWith('/repos/o/r/issues/4')),
    );
  });

  test('a failing topic prints the cause of a network error', async () => {
    linkedIssue(3, 42);
    linkedTopic(42, 3, [personReply('Lost')]);
    fake.fail({ method: 'POST', path: /comments$/, status: 'drop' });
    const run = await runMode('to-github', fake);
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /Could not sync topic 42: fetch failed \(.+\)/);
  });

  test('a 5xx on a read is retried', async () => {
    linkedIssue(3, 42);
    linkedTopic(42, 3, [personReply('First')]);
    fake.fail({ path: /^\/c\//, status: 502, headers: { 'retry-after': '1' } });
    const run = await runMode('to-github', fake);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(copiedBodies(3), ['First']);
  });

  test('a 429 on commenting waits and retries', async () => {
    linkedIssue(3, 42);
    linkedTopic(42, 3, [personReply('First')]);
    fake.fail({
      method: 'POST',
      path: /comments$/,
      status: 429,
      headers: { 'retry-after': '1' },
    });
    const run = await runMode('to-github', fake);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(copiedBodies(3), ['First']);
  });
});

describe('the latest list', () => {
  const cutoff = Date.parse('2026-10-29T00:00:00Z');
  const recent = '2026-10-30T00:00:00Z';
  const old = '2020-01-01T00:00:00Z';

  test('keeps recent topics, pinned or not, and drops old pinned ones without ending paging', () => {
    const page = [
      { id: 1, pinned: true, bumped_at: recent },
      { id: 2, pinned: true, bumped_at: old },
      { id: 3, bumped_at: recent },
    ];
    assert.deepEqual(splitByActivity(page, cutoff), {
      recent: [page[0], page[2]],
      older: false,
    });
  });

  test('an old unpinned topic ends paging', () => {
    assert.equal(
      splitByActivity([{ id: 3, bumped_at: old }], cutoff).older,
      true,
    );
  });
});
