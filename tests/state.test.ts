import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  LINK_COMMENT_PREFIX,
  earlierReplyId,
  stateSteps,
  topicStateChange,
} from '../scripts/discourse-sync.mjs';
import {
  API_USER,
  BOT_LOGIN,
  runMode,
  startFakeApis,
  type FakeApis,
  type Topic,
} from './fake-apis.ts';

const CLOSED_AT = '2026-11-01T07:00:00Z';
const REOPENED_AT = '2026-11-01T07:02:00Z';
const issueEvent = (
  action: string,
  stateReason: string | null = 'completed',
  closedAt = CLOSED_AT,
) => ({
  action,
  sender: { login: 'robin' },
  issue: {
    number: 3,
    html_url: 'https://github.com/o/r/issues/3',
    state_reason: stateReason,
    closed_at: closedAt,
    updated_at: REOPENED_AT,
  },
});
const pullRequestEvent = (
  merged: boolean,
  mergedBy: string | null = 'nami',
) => ({
  action: 'closed',
  sender: { login: 'robin' },
  pull_request: {
    number: 3,
    merged,
    merged_by: mergedBy ? { login: mergedBy } : null,
    html_url: 'https://github.com/o/r/pull/3',
    closed_at: CLOSED_AT,
  },
});
const replyOf = (event: object) => topicStateChange(event)!.reply;

/* Function: a close, merge or reopen on GitHub replies once and sets the topic's state and solution. */
describe('the state reply', () => {
  for (const [name, event, firstLine, solve] of [
    [
      'an issue closed as completed',
      issueEvent('closed'),
      'Closed on GitHub as completed by robin.',
      true,
    ],
    [
      'an issue closed as not planned',
      issueEvent('closed', 'not_planned'),
      'Closed on GitHub as not planned by robin.',
      false,
    ],
    [
      'an issue closed as a duplicate',
      issueEvent('closed', 'duplicate'),
      'Closed on GitHub as a duplicate by robin.',
      false,
    ],
    [
      'an issue closed without a reason',
      issueEvent('closed', null),
      'Closed on GitHub by robin.',
      false,
    ],
    [
      'a merged pull request',
      pullRequestEvent(true),
      'Merged on GitHub by nami.',
      true,
    ],
    [
      'a merged pull request without merged_by',
      pullRequestEvent(true, null),
      'Merged on GitHub by robin.',
      true,
    ],
    [
      'an unmerged pull request',
      pullRequestEvent(false),
      'Closed on GitHub without merging by robin.',
      false,
    ],
  ] as const)
    test(`${name}: "${firstLine}" closes the topic${solve ? ' as solved' : ''}`, () => {
      const change = topicStateChange(event);
      assert.equal(change?.reply.split('\n')[0], firstLine);
      assert.equal(change?.solve, solve);
      assert.equal(change?.close, true);
    });

  test('a reopen reopens the topic without a solution', () => {
    const change = topicStateChange(issueEvent('reopened'));
    assert.equal(change?.reply.split('\n')[0], 'Reopened on GitHub by robin.');
    assert.equal(change?.solve, false);
    assert.equal(change?.close, false);
  });

  test('other actions change nothing', () => {
    assert.equal(topicStateChange(issueEvent('edited')), null);
  });

  test('close, reopen and close again give three different replies, and one event always the same reply', () => {
    const replies = [
      replyOf(issueEvent('closed')),
      replyOf(issueEvent('reopened')),
      replyOf(issueEvent('closed', 'completed', '2026-11-01T07:03:00Z')),
    ];
    assert.equal(new Set(replies).size, 3);
    assert.equal(replyOf(issueEvent('closed')), replies[0]);
  });

  test('a close event without its time fails instead of posting', () => {
    assert.throws(
      () => topicStateChange(issueEvent('closed', 'completed', '')),
      /closed_at/,
    );
  });
});

/* Function: a close or reopen runs its forum steps in order and keeps a person's accepted answer. */
describe('the state steps', () => {
  const opened = { id: 1, post_number: 1, username: API_USER };
  const closeReply = replyOf(issueEvent('closed'));
  const reopen = topicStateChange(issueEvent('reopened'))!;
  const close = topicStateChange(issueEvent('closed'))!;

  test('a close replies, accepts that reply, then closes', () => {
    assert.deepEqual(
      stateSteps(close, [opened]).map(({ step }) => step),
      ['reply', 'accept-reply', 'close'],
    );
  });

  test('a close keeps an answer a person already accepted', () => {
    const accepted = { id: 5, username: 'nami', accepted_answer: true };
    assert.deepEqual(
      stateSteps(close, [opened, accepted]).map(({ step }) => step),
      ['reply', 'close'],
    );
  });

  for (const [name, post, unaccepted] of [
    [
      'a close reply from the API user',
      { id: 9, username: 'Forum-Bot', raw: closeReply },
      true,
    ],
    [
      'a close reply from an earlier API user',
      { id: 9, username: 'old-bot', raw: closeReply },
      true,
    ],
    [
      'a person quoting a close reply',
      {
        id: 9,
        username: 'nami',
        raw: 'Closed on GitHub as completed by robin. Thanks.',
      },
      false,
    ],
    [
      'a copied GitHub comment',
      {
        id: 9,
        username: API_USER,
        raw: 'robin wrote on GitHub:\n\nFixed in #12.',
      },
      false,
    ],
    [
      'a reopen reply',
      { id: 9, username: 'old-bot', raw: reopen.reply },
      false,
    ],
  ] as const)
    test(`a reopen ${unaccepted ? 'unaccepts' : 'keeps'} an accepted post: ${name}`, () => {
      assert.deepEqual(
        stateSteps(reopen, [opened, { ...post, accepted_answer: true }]),
        [
          { step: 'reopen' },
          ...(unaccepted ? [{ step: 'unaccept', postId: 9 }] : []),
          { step: 'reply' },
        ],
      );
    });

  const earlier = {
    id: 11,
    post_number: 4,
    username: 'Forum-Bot',
    raw: closeReply,
  };
  for (const [name, posts, expected] of [
    ['its own earlier reply', [opened, earlier], 11],
    [
      'its earlier reply after a copied comment',
      [
        opened,
        earlier,
        {
          id: 13,
          username: API_USER,
          raw: 'nami wrote on GitHub:\n\nStill broken.',
        },
      ],
      11,
    ],
    [
      "an earlier API user's reply",
      [opened, { ...earlier, username: 'old-bot' }],
      11,
    ],
    [
      'a person quoting the first line',
      [
        opened,
        { ...earlier, username: 'nami', raw: closeReply.split('\n')[0] },
      ],
      null,
    ],
    [
      'a close before a reopen',
      [
        opened,
        {
          ...earlier,
          raw: closeReply.replace(CLOSED_AT, '2026-11-01T06:00:00Z'),
        },
      ],
      null,
    ],
    ['no reply yet', [opened], null],
  ] as const)
    test(`a re-run, given ${name}, ${expected ? 'reuses the earlier reply' : 'posts a new reply'}`, () => {
      assert.equal(earlierReplyId(posts, closeReply), expected);
    });
});

/* Function: the state mode sets the topic's status and solution through the API, once per event. */
describe('state', () => {
  let fake: FakeApis;
  let topic: Topic;
  beforeEach(async () => {
    fake = await startFakeApis();
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
          user: { login: BOT_LOGIN, type: 'Bot' },
          body: `${LINK_COMMENT_PREFIX}https://forum.example.com/t/crash/42`,
          html_url: 'u',
        },
      ],
    });
  });
  afterEach(() => fake.close());

  const statusBodies = () =>
    fake.hits
      .filter(({ url }) => url === '/t/42/status.json')
      .map(({ body }) => JSON.parse(body));

  test('a completed issue posts its reply, marks it as the solution and closes the topic', async () => {
    const run = await runMode('state', fake, issueEvent('closed'));
    assert.equal(run.code, 0, run.stderr);
    assert.equal(topic.posts.at(-1)?.raw, replyOf(issueEvent('closed')));
    assert.equal(topic.posts.at(-1)?.accepted_answer, true);
    assert.deepEqual(statusBodies(), [{ status: 'closed', enabled: true }]);
    assert.equal(topic.closed, true);
  });

  test('a reopen reopens the topic first, unaccepts the close reply, then replies', async () => {
    await runMode('state', fake, issueEvent('closed'));
    const run = await runMode('state', fake, issueEvent('reopened'));
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(statusBodies().at(-1), {
      status: 'closed',
      enabled: false,
    });
    assert.equal(topic.closed, false);
    assert.ok(topic.posts.every((post) => !post.accepted_answer));
    assert.equal(topic.posts.at(-1)?.raw, replyOf(issueEvent('reopened')));
  });

  test('a re-run after a failed close reuses its reply and still closes', async () => {
    fake.fail({ method: 'PUT', path: '/t/42/status.json', status: 403 });
    const failed = await runMode('state', fake, issueEvent('closed'));
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /trust level 4/);
    const run = await runMode('state', fake, issueEvent('closed'));
    assert.equal(run.code, 0, run.stderr);
    assert.equal(topic.posts.length, 2, 'the re-run posted its reply again');
    assert.equal(topic.closed, true);
  });

  test('with Solved off the topic still closes, with a notice instead of a solution', async () => {
    fake.settings.solved = false;
    const run = await runMode('state', fake, issueEvent('closed'));
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /::notice::.*turn Solved on/);
    assert.ok(!fake.hits.some(({ url }) => url === '/solution/accept.json'));
    assert.equal(topic.closed, true);
  });

  test('an issue with no topic is skipped', async () => {
    fake.issues.get(3)!.comments.length = 0;
    const run = await runMode('state', fake, issueEvent('closed'));
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(fake.writes(), []);
  });
});
