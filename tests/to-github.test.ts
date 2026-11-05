import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  FORUM_READ_GAP_MS,
  LINK_COMMENT_PREFIX,
  activityCutoff,
  markerOf,
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

/* Function: a person's forum reply reaches GitHub once, within the API budget, and one bad topic does not block the rest. */
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
          body: `${LINK_COMMENT_PREFIX}https://forum.example.com/t/crash/${topicId}`,
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
    assert.deepEqual(copiedBodies(3), ['First', '@\u200bluffy second']);
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
      body: `${LINK_COMMENT_PREFIX}https://forum.example.com/t/crash/42`,
      html_url: 'u',
    });
    for (const id of [40, 41])
      linkedTopic(id, 99, [], { bumped_at: hoursAgo(1) });
    const replies = Array.from({ length: 150 }, (_, i) => personReply(`r${i}`));
    linkedTopic(42, 3, replies, { bumped_at: hoursAgo(2) });
    /* All but the last are already copied, so the one left is in the second batch of post ids. */
    comments.push({
      id: 5,
      user: { login: BOT_LOGIN, type: 'Bot' },
      body: replies
        .slice(0, -1)
        .map(({ id }) => markerOf(id))
        .join('\n'),
      html_url: 'u',
    });
    const run = await runMode('to-github', fake);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(copiedBodies(3), ['r149']);
  });

  test('a topic older than the window is not read, and paging stops there', async () => {
    linkedIssue(3, 42);
    linkedTopic(42, 3, [personReply('Old')], { bumped_at: hoursAgo(72) });
    for (const id of [43, 44, 45])
      linkedTopic(id, 9, [], { bumped_at: hoursAgo(80 + id) });
    const run = await runMode('to-github', fake);
    assert.equal(run.code, 0, run.stderr);
    assert.ok(!fake.hits.some(({ url }) => url.startsWith('/t/42')));
    assert.ok(
      !fake.hits.some(({ url }) => url.startsWith('/c/5/l/latest.json?page=1')),
    );
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
    assert.ok(
      !fake.hits.some(({ url }) => url.startsWith('/repos/o/r/issues')),
    );
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

  test('a topic the forum keeps failing is skipped while later topics sync, and the run fails', async () => {
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
    assert.doesNotMatch(run.stderr, /Stopped before/);
    assert.deepEqual(copiedBodies(4), ['Kept']);
  });

  for (const [name, headers, stops] of [
    [
      '403 for a secondary rate limit with Retry-After stops the run',
      { 'retry-after': '60' },
      true,
    ],
    [
      '403 for a primary rate limit with no requests left stops the run',
      { 'x-ratelimit-remaining': '0' },
      true,
    ],
    [
      '403 that is not a rate limit skips one topic',
      { 'x-ratelimit-remaining': '4999' },
      false,
    ],
  ] as [string, Record<string, string>, boolean][])
    test(`a GitHub ${name}`, async () => {
      linkedIssue(3, 42);
      linkedTopic(42, 3, [personReply('Lost')], { bumped_at: hoursAgo(1) });
      linkedIssue(4, 43);
      linkedTopic(43, 4, [personReply('Kept')], { bumped_at: hoursAgo(2) });
      fake.fail({ path: '/repos/o/r/issues/3', status: 403, headers });
      const run = await runMode('to-github', fake);
      assert.notEqual(run.code, 0);
      assert.equal(/Stopped before 1 more topic/.test(run.stderr), stops);
      assert.deepEqual(copiedBodies(4), stops ? [] : ['Kept']);
    });

  for (const [name, status, headers] of [
    ['a 403 with only a rate limit message', 403, {}],
    ['a 429 without Retry-After', 429, {}],
    ['a 429 with a Retry-After above the cap', 429, { 'retry-after': '120' }],
  ] as [string, number, Record<string, string>][])
    test(`${name} from GitHub stops the run at once`, async () => {
      linkedIssue(3, 42);
      linkedTopic(42, 3, [personReply('Lost')], { bumped_at: hoursAgo(1) });
      linkedIssue(4, 43);
      linkedTopic(43, 4, [personReply('Kept')], { bumped_at: hoursAgo(2) });
      fake.fail({
        path: '/repos/o/r/issues/3',
        status,
        headers,
        body: { message: 'You have exceeded a secondary rate limit.' },
      });
      const started = performance.now();
      const run = await runMode('to-github', fake);
      assert.notEqual(run.code, 0);
      assert.match(run.stderr, /Stopped before 1 more topic/);
      assert.equal(
        fake.hits.filter(({ url }) => url === '/repos/o/r/issues/3').length,
        1,
      );
      assert.ok(
        performance.now() - started < 10_000,
        'the run waited on a rate limit',
      );
    });

  test('a GitHub rate limit after a redirect still stops the run', async () => {
    fake.addIssue({ number: 3, transferred: true });
    linkedTopic(42, 3, [personReply('Lost')], { bumped_at: hoursAgo(1) });
    linkedIssue(4, 43);
    linkedTopic(43, 4, [personReply('Kept')], { bumped_at: hoursAgo(2) });
    fake.fail({
      path: /^\/repositories\//,
      status: 403,
      headers: { 'retry-after': '60' },
    });
    const run = await runMode('to-github', fake);
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /Stopped before 1 more topic/);
  });

  test('a 403 on the latest list names the topics read_lists scope', async () => {
    fake.fail({ path: '/c/5/l/latest.json', status: 403 });
    const run = await runMode('to-github', fake);
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /needs the "topics: read_lists" scope/);
  });

  test('waits a second between comments it posts', async () => {
    linkedIssue(3, 42);
    linkedTopic(42, 3, [personReply('First'), personReply('Second')]);
    const run = await runMode('to-github', fake);
    assert.equal(run.code, 0, run.stderr);
    const posts = fake.hits.filter(({ method }) => method === 'POST');
    assert.equal(posts.length, 2);
    assert.ok(
      posts[1]!.at - posts[0]!.at >= 1_000,
      'GitHub comments were posted less than a second apart',
    );
  });

  test('a forum rate limit longer than a minute stops the run', async () => {
    const github = await startFakeApis();
    try {
      linkedTopic(42, 3, [personReply('Lost')], { bumped_at: hoursAgo(1) });
      linkedTopic(43, 4, [personReply('Kept')], { bumped_at: hoursAgo(2) });
      fake.fail({
        path: '/t/42.json',
        status: 429,
        headers: { 'retry-after': '120' },
      });
      const run = await runMode(
        'to-github',
        fake,
        {},
        { GITHUB_API_URL: github.origin },
      );
      assert.notEqual(run.code, 0);
      assert.match(run.stderr, /Stopped before 1 more topic/);
      assert.ok(!fake.hits.some(({ url }) => url.startsWith('/t/43')));
    } finally {
      await github.close();
    }
  });

  test('a run after a successful one reads only the topics bumped since then', async () => {
    linkedIssue(3, 42);
    linkedTopic(42, 3, [personReply('Old')], { bumped_at: hoursAgo(3) });
    linkedIssue(4, 43);
    linkedTopic(43, 4, [personReply('New')], { bumped_at: hoursAgo(0.1) });
    fake.addSuccessfulRun(hoursAgo(1));
    const run = await runMode('to-github', fake);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(copiedBodies(4), ['New']);
    assert.ok(
      !fake.hits.some(({ url }) => url.startsWith('/t/42')),
      'a topic with nothing new was read',
    );
  });

  test('without a successful run, the run reads the whole lookback window', async () => {
    linkedIssue(3, 42);
    linkedTopic(42, 3, [personReply('Old')], { bumped_at: hoursAgo(40) });
    const run = await runMode('to-github', fake);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(copiedBodies(3), ['Old']);
  });

  test('when the last run cannot be read, the run warns and reads the whole window', async () => {
    linkedIssue(3, 42);
    linkedTopic(42, 3, [personReply('Old')], { bumped_at: hoursAgo(40) });
    fake.fail({ path: /\/actions\//, status: 403 });
    const run = await runMode('to-github', fake);
    assert.equal(run.code, 0, run.stderr);
    assert.match(
      run.stdout,
      /::warning::Could not read the last successful run/,
    );
    assert.deepEqual(copiedBodies(3), ['Old']);
  });

  for (const [name, setup] of [
    [
      'a successful run on another branch',
      (f: FakeApis) => f.addSuccessfulRun(hoursAgo(1), { branch: 'feature' }),
    ],
    [
      'a successful run whose job was skipped',
      (f: FakeApis) =>
        f.addSuccessfulRun(hoursAgo(1), { jobConclusion: 'skipped' }),
    ],
  ] as const)
    test(`${name} does not move the cutoff`, async () => {
      linkedIssue(3, 42);
      linkedTopic(42, 3, [personReply('Old')], { bumped_at: hoursAgo(40) });
      setup(fake);
      const run = await runMode('to-github', fake);
      assert.equal(run.code, 0, run.stderr);
      assert.deepEqual(copiedBodies(3), ['Old']);
    });

  test('an older run whose job ran sets the cutoff when a newer one was skipped', async () => {
    linkedIssue(3, 42);
    linkedTopic(42, 3, [personReply('Between')], { bumped_at: hoursAgo(2) });
    linkedIssue(4, 43);
    linkedTopic(43, 4, [personReply('Older')], { bumped_at: hoursAgo(10) });
    fake.addSuccessfulRun(hoursAgo(1), { jobConclusion: 'skipped' });
    fake.addSuccessfulRun(hoursAgo(3));
    const run = await runMode('to-github', fake);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(copiedBodies(3), ['Between']);
    assert.ok(!fake.hits.some(({ url }) => url.startsWith('/t/43')));
  });

  for (const [name, setup, env] of [
    [
      'a last run that starts in the future',
      (f: FakeApis) =>
        f.addSuccessfulRun(new Date(Date.now() + 3_600_000).toISOString()),
      {},
    ],
    [
      'a tag workflow ref',
      (f: FakeApis) => f.addSuccessfulRun(hoursAgo(1)),
      {
        GITHUB_WORKFLOW_REF:
          'o/r/.github/workflows/discourse-topic-to-issue.yml@refs/tags/v1',
      },
    ],
    [
      'no workflow ref',
      (f: FakeApis) => f.addSuccessfulRun(hoursAgo(1)),
      { GITHUB_WORKFLOW_REF: '' },
    ],
  ] as [string, (f: FakeApis) => void, Record<string, string>][])
    test(`${name} warns and reads the whole window`, async () => {
      linkedIssue(3, 42);
      linkedTopic(42, 3, [personReply('Old')], { bumped_at: hoursAgo(40) });
      setup(fake);
      const run = await runMode('to-github', fake, {}, env);
      assert.equal(run.code, 0, run.stderr);
      assert.match(
        run.stdout,
        /::warning::Could not read the last successful run/,
      );
      assert.deepEqual(copiedBodies(3), ['Old']);
    });

  test('a forum rate limit within a minute is waited out, not reported', async () => {
    linkedIssue(3, 42);
    linkedTopic(42, 3, [personReply('First')]);
    fake.fail({
      path: '/t/42.json',
      status: 429,
      headers: { 'retry-after': '1' },
    });
    const run = await runMode('to-github', fake);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(copiedBodies(3), ['First']);
  });

  test('a forum rate limit without Retry-After is retried, not reported', async () => {
    linkedIssue(3, 42);
    linkedTopic(42, 3, [personReply('First')]);
    fake.fail({ path: '/t/42.json', status: 429 });
    const run = await runMode('to-github', fake);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(copiedBodies(3), ['First']);
  });

  test('a read gap above a minute is refused', async () => {
    const run = await runMode(
      'to-github',
      fake,
      {},
      { SYNC_FORUM_GAP_MS: '2147483648' },
    );
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /SYNC_FORUM_GAP_MS/);
  });

  test('forum reads are spaced by the read gap', async () => {
    linkedTopic(42, 3, []);
    linkedTopic(43, 4, []);
    const run = await runMode(
      'to-github',
      fake,
      {},
      { SYNC_FORUM_GAP_MS: '300' },
    );
    assert.equal(run.code, 0, run.stderr);
    const reads = fake.hits.filter(({ url }) => !url.startsWith('/repos/'));
    assert.ok(reads.length >= 5);
    for (const [i, hit] of reads.slice(1).entries())
      assert.ok(
        hit.at - reads[i]!.at >= 290,
        `forum requests ${i} and ${i + 1} were not spaced`,
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

/* Function: paging reads every topic inside the window and stops after it. */
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

/* Function: Discourse allows 60 admin API requests a minute for the whole site by default. */
describe('forum pacing', () => {
  test('to-github reads the forum at no more than 40 requests a minute, leaving room for event runs', () => {
    assert.ok(60_000 / FORUM_READ_GAP_MS <= 40);
  });
});

/* Function: a run reads only what changed since the last successful one, within the lookback window. */
describe('the activity cutoff', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  test('is the last successful start less 15 minutes', () => {
    assert.equal(
      activityCutoff(now, Date.parse('2026-11-05T11:45:00Z')),
      Date.parse('2026-11-05T11:30:00Z'),
    );
  });
  test('is never later than now less 15 minutes', () => {
    assert.equal(activityCutoff(now, now + 3_600_000), now - 900_000);
  });
  test('is 48 hours back without a successful run or when that run is older', () => {
    const window = now - 48 * 3_600_000;
    assert.equal(activityCutoff(now, null), window);
    assert.equal(
      activityCutoff(now, Date.parse('2026-10-01T00:00:00Z')),
      window,
    );
  });
});
