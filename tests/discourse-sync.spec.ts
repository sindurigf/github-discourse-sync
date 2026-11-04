import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { load } from 'js-yaml';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import {
  BOT_LOGIN,
  FORUM_MAX_POST_CHARS,
  GITHUB_MAX_COMMENT_CHARS,
  GITHUB_TRUNCATED_NOTE,
  LINK_COMMENT_PREFIX,
  PR_LINK_COMMENT_PREFIX,
  RUN_DEADLINE_MS,
  SETUP_MARGIN_MS,
  STATUS_SCOPE,
  TRUNCATED_NOTE,
  acceptDecision,
  defuseText,
  earlierReplyId,
  forumReplyBody,
  githubCommentBody,
  markerOf,
  mirroredPostIds,
  newTopic,
  parseCategoryId,
  repoKey,
  request,
  shouldMirrorComment,
  shouldMirrorPost,
  shouldOpenTopic,
  splitByActivity,
  stateSteps,
  topicExternalId,
  topicIdFromComments,
  topicStateChange,
  topicTarget,
} from '../scripts/discourse-sync.mjs';

/* Function: the issue and forum mirror never loops, never posts twice and never pings anyone. */
const API_USER = 'forum-bot';
const reply = {
  id: 501,
  post_number: 2,
  post_type: 1,
  username: 'robin',
  raw: 'Seen it too.',
};
const human = {
  id: 9,
  user: { login: 'robin', type: 'User' },
  body: 'Same here, @nami.',
  html_url: 'https://github.com/o/r/issues/3#issuecomment-9',
};
const linkComment = {
  user: { login: BOT_LOGIN, type: 'Bot' },
  body: `${LINK_COMMENT_PREFIX}https://forum.example.com/t/github-issue-3-crash/42`,
};

test('the topic id comes only from the bot link comment', () => {
  expect(topicIdFromComments([human, linkComment])).toBe(42);
  expect(
    topicIdFromComments([{ ...linkComment, user: { login: 'robin' } }]),
    'a person quoting the link text must not bind a topic',
  ).toBeNull();
  expect(topicIdFromComments([human])).toBeNull();
});

test('a topic title names its issue or pull request number', () => {
  expect(topicTarget('GitHub issue #322: Test: issue to Discourse')).toEqual({
    number: 322,
    pullRequest: false,
  });
  expect(topicTarget('GitHub pull request #12: Fix the menu')).toEqual({
    number: 12,
    pullRequest: true,
  });
  expect(topicTarget('Re: GitHub issue #322: x')).toBeNull();
  expect(topicTarget(undefined)).toBeNull();
});

test('a comment from a person goes to the forum, a bot or mirrored one does not', () => {
  expect(shouldMirrorComment(human)).toBe(true);
  expect(shouldMirrorComment(linkComment)).toBe(false);
  expect(
    shouldMirrorComment({
      ...human,
      user: { login: 'dependabot[bot]', type: 'Bot' },
    }),
  ).toBe(false);
  expect(
    shouldMirrorComment({
      ...human,
      body: githubCommentBody(reply, 'https://forum.example.com/t/x/42/2'),
    }),
    'a mirrored forum reply must not go back to the forum',
  ).toBe(false);
});

test('a forum reply goes to GitHub once, never the first post, the API user or a mirror', () => {
  const none = new Set<number>();
  expect(shouldMirrorPost(reply, API_USER, none)).toBe(true);
  expect(shouldMirrorPost({ ...reply, post_number: 1 }, API_USER, none)).toBe(
    false,
  );
  expect(
    shouldMirrorPost({ ...reply, username: API_USER }, API_USER, none),
  ).toBe(false);
  expect(shouldMirrorPost({ ...reply, post_type: 3 }, API_USER, none)).toBe(
    false,
  );
  expect(shouldMirrorPost({ ...reply, hidden: true }, API_USER, none)).toBe(
    false,
  );
  expect(
    shouldMirrorPost({ ...reply, raw: forumReplyBody(human) }, API_USER, none),
    'a mirrored GitHub comment must not come back',
  ).toBe(false);
  const done = mirroredPostIds([
    {
      user: { login: BOT_LOGIN },
      body: githubCommentBody(reply, 'https://forum.example.com/t/x/42/2'),
    },
  ]);
  expect(shouldMirrorPost(reply, API_USER, done)).toBe(false);
});

test('mirrored text names the author without an @ and defuses mentions', () => {
  const toForum = forumReplyBody(human);
  expect(toForum.startsWith('robin wrote on GitHub:')).toBe(true);
  expect(toForum).not.toMatch(/(^|[^\w`/])@[\w-]/);
  const toGithub = githubCommentBody(
    { ...reply, raw: '@luffy look' },
    'https://forum.example.com/t/x/42/2',
  );
  expect(toGithub.startsWith('robin wrote on the forum:')).toBe(true);
  expect(toGithub).not.toMatch(/(^|[^\w`/])@[\w-]/);
});

test('only the bot can mark a forum post as mirrored', () => {
  const forged = mirroredPostIds([
    { user: { login: 'mallory' }, body: '<!-- discourse-post:501 -->' },
  ]);
  expect(shouldMirrorPost(reply, API_USER, forged)).toBe(true);
  const copied = githubCommentBody(
    { ...reply, id: 600, raw: 'hi <!-- discourse-post:501 -->' },
    'https://forum.example.com/t/x/42/3',
  );
  expect(
    [...mirroredPostIds([{ user: { login: BOT_LOGIN }, body: copied }])],
    'a marker inside copied text must not count',
  ).toEqual([600]);
});

test('the API user is matched without regard to case', () => {
  expect(
    shouldMirrorPost({ ...reply, username: 'Forum-Bot' }, API_USER, new Set()),
  ).toBe(false);
});

test('a comment longer than a forum post is shortened, keeping its link', () => {
  const long = forumReplyBody({ ...human, body: 'x'.repeat(70_000) });
  expect(long.length).toBeLessThanOrEqual(32_000);
  expect(long.endsWith(human.html_url)).toBe(true);
});

test('paging stops at the first older unpinned topic, past an old pinned one', () => {
  const cutoff = Date.parse('2026-10-29T00:00:00Z');
  const page = [
    { id: 1, pinned: true, bumped_at: '2020-01-01T00:00:00Z' },
    { id: 2, bumped_at: '2026-10-30T00:00:00Z' },
  ];
  expect(splitByActivity(page, cutoff)).toEqual({
    recent: [page[1]],
    older: false,
  });
  expect(
    splitByActivity(
      [...page, { id: 3, bumped_at: '2026-10-01T00:00:00Z' }],
      cutoff,
    ).older,
  ).toBe(true);
});

/* Security: fetch would send the Api-Key header to any host a redirect names. */
const serve = (
  handler: (url: string) => {
    status: number;
    location?: string;
    body?: unknown;
  },
): Promise<{ server: Server; origin: string; hits: string[] }> =>
  new Promise((resolve) => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? '');
      const { status, location, body } = handler(req.url ?? '');
      res.writeHead(status, {
        'content-type': 'application/json',
        ...(location ? { location } : {}),
      });
      res.end(JSON.stringify(body ?? { ok: true }));
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        hits,
      }),
    );
  });

test('a same-origin GET redirect is followed', async () => {
  const forum = await serve((url) =>
    url === '/c/54/l/latest.json'
      ? { status: 301, location: '/c/github/54/l/latest.json' }
      : { status: 200 },
  );
  try {
    const response = await request(`${forum.origin}/c/54/l/latest.json`, {});
    expect(await response.json()).toEqual({ ok: true });
    expect(forum.hits).toEqual([
      '/c/54/l/latest.json',
      '/c/github/54/l/latest.json',
    ]);
  } finally {
    forum.server.close();
  }
});

test('a redirect to another host is refused before any request reaches it', async () => {
  const other = await serve(() => ({ status: 200 }));
  const forum = await serve(() => ({
    status: 302,
    location: `${other.origin}/steal`,
  }));
  try {
    await expect(
      request(`${forum.origin}/t/1.json`, {
        headers: { 'Api-Key': 'secret' },
      }),
    ).rejects.toThrow(/redirected off/);
    expect(other.hits, 'the other host must not see the key').toEqual([]);
  } finally {
    forum.server.close();
    other.server.close();
  }
});

test('a redirect loop stops after a few hops', async () => {
  const forum = await serve(() => ({ status: 301, location: '/again' }));
  try {
    await expect(request(`${forum.origin}/again`, {})).rejects.toThrow(
      /more than 3 times/,
    );
    expect(forum.hits.length).toBeLessThanOrEqual(4);
  } finally {
    forum.server.close();
  }
});

test('a POST is never redirected', async () => {
  const forum = await serve(() => ({ status: 301, location: '/elsewhere' }));
  try {
    await expect(
      request(`${forum.origin}/posts.json`, { method: 'POST', body: '{}' }),
    ).rejects.toThrow(/not followed/);
    expect(forum.hits).toEqual(['/posts.json']);
  } finally {
    forum.server.close();
  }
});

test('a pull request topic links back through its own link comment', () => {
  expect(
    topicIdFromComments([
      {
        user: { login: BOT_LOGIN },
        body: `${PR_LINK_COMMENT_PREFIX}https://forum.example.com/t/github-pull-request-12-fix/77`,
      },
    ]),
  ).toBe(77);
});

test('a draft or bot pull request opens no topic', () => {
  const ready = { draft: false, user: { login: 'robin', type: 'User' } };
  expect(shouldOpenTopic(ready)).toBe(true);
  expect(shouldOpenTopic({ ...ready, draft: true })).toBe(false);
  expect(
    shouldOpenTopic({
      ...ready,
      user: { login: 'dependabot[bot]', type: 'Bot' },
    }),
  ).toBe(false);
  expect(
    shouldOpenTopic({
      ...ready,
      user: { login: 'renovate[bot]', type: 'Bot' },
    }),
  ).toBe(false);
});

test('a pull request topic fits Discourse limits and pings no one', () => {
  const topic = newTopic(
    {
      number: 12,
      title: 'x'.repeat(400),
      body: '@luffy please review',
      html_url: 'https://github.com/o/r/pull/12',
      user: { login: 'robin' },
    },
    true,
  );
  expect(topic.title.startsWith('GitHub pull request #12: ')).toBe(true);
  expect(Array.from(topic.title).length).toBeLessThanOrEqual(255);
  const emoji = newTopic(
    {
      number: 12,
      title: '🐈'.repeat(300),
      body: '',
      html_url: 'u',
      user: { login: 'r' },
    },
    true,
  ).title;
  expect(emoji, 'a cut must not leave half an emoji').not.toMatch(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/,
  );
  expect(topic.raw).toContain('https://github.com/o/r/pull/12');
  expect(topic.raw).not.toMatch(/(^|[^\w`/])@[\w-]/);
  expect(
    newTopic(
      {
        number: 1,
        title: 't',
        body: null,
        html_url: 'u',
        user: { login: 'r' },
      },
      true,
    ).raw,
  ).toContain('_No description provided._');
});

const closedIssue = (stateReason: string | null) => ({
  action: 'closed',
  sender: { login: 'robin' },
  issue: {
    number: 3,
    html_url: 'https://github.com/o/r/issues/3',
    state_reason: stateReason,
    closed_at: '2026-11-01T07:00:00Z',
    updated_at: '2026-11-01T07:02:00Z',
  },
});

test('a completed issue closes its topic with the reply as the solution', () => {
  const change = topicStateChange(closedIssue('completed'));
  expect(change).toMatchObject({ solve: true, close: true });
  expect(
    change?.reply.startsWith('Closed on GitHub as completed by robin.'),
  ).toBe(true);
  expect(change?.reply).toContain('https://github.com/o/r/issues/3');
});

test('an issue closed as not planned closes its topic without a solution', () => {
  const change = topicStateChange(closedIssue('not_planned'));
  expect(change).toMatchObject({ solve: false, close: true });
  expect(
    change?.reply.startsWith('Closed on GitHub as not planned by robin.'),
  ).toBe(true);
  expect(
    topicStateChange(closedIssue(null))?.reply.startsWith(
      'Closed on GitHub by robin.',
    ),
  ).toBe(true);
});

test('a merged pull request solves and closes its topic, an unmerged one only closes', () => {
  const pr = (merged: boolean) => ({
    action: 'closed',
    sender: { login: 'robin' },
    pull_request: {
      number: 12,
      merged,
      merged_by: merged ? { login: 'nami' } : null,
      html_url: 'https://github.com/o/r/pull/12',
      closed_at: '2026-11-01T07:00:00Z',
    },
  });
  const merged = topicStateChange(pr(true));
  expect(merged).toMatchObject({ solve: true, close: true });
  expect(merged?.reply.startsWith('Merged on GitHub by nami.')).toBe(true);
  const unmerged = topicStateChange(pr(false));
  expect(unmerged).toMatchObject({ solve: false, close: true });
  expect(
    unmerged?.reply.startsWith('Closed on GitHub without merging by robin.'),
  ).toBe(true);
});

test('a reopen reopens the topic without a solution, other actions do nothing', () => {
  const reopened = topicStateChange({
    ...closedIssue('completed'),
    action: 'reopened',
  });
  expect(reopened).toMatchObject({ solve: false, close: false });
  expect(reopened?.reply.startsWith('Reopened on GitHub by robin.')).toBe(true);
  expect(
    topicStateChange({ ...closedIssue('completed'), action: 'edited' }),
  ).toBeNull();
});

test('a pull request link comment from a person binds no topic', () => {
  expect(
    topicIdFromComments([
      {
        user: { login: 'mallory' },
        body: `${PR_LINK_COMMENT_PREFIX}https://forum.example.com/t/x/77`,
      },
    ]),
  ).toBeNull();
});

for (const kind of ['issue', 'pull request'] as const) {
  test(`a ${kind} body longer than a forum post is shortened with the note`, () => {
    for (const body of ['x'.repeat(70_000), '😀'.repeat(70_000)]) {
      const { raw } = newTopic(
        {
          number: 12,
          title: 't',
          body,
          html_url: 'https://github.com/o/r/pull/12',
          user: { login: 'robin' },
        },
        kind === 'pull request',
      );
      expect(Array.from(raw).length).toBeLessThanOrEqual(FORUM_MAX_POST_CHARS);
      expect(raw).toContain('https://github.com/o/r/pull/12');
      expect(raw.endsWith(TRUNCATED_NOTE)).toBe(true);
      expect(raw, 'a cut must not split a surrogate pair').not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/,
      );
    }
  });
}

/* Security: pull_request_target runs with secrets, so it must never check out the pull request. */
test('every pull_request_target checkout has no ref or the default branch ref', () => {
  const dir = '.github/workflows';
  type Step = { uses?: string; with?: { ref?: string; repository?: string } };
  type Workflow = { on?: unknown; jobs?: Record<string, { steps?: Step[] }> };
  const targets = readdirSync(dir)
    .filter((name) => name.endsWith('.yml'))
    .map((name) => ({
      name,
      workflow: load(readFileSync(`${dir}/${name}`, 'utf8')) as Workflow,
    }))
    .filter(({ workflow }) =>
      JSON.stringify(workflow.on ?? {}).includes('pull_request_target'),
    );
  expect(
    targets.length,
    'no pull_request_target workflow found',
  ).toBeGreaterThan(0);
  for (const { name, workflow } of targets) {
    for (const step of Object.values(workflow.jobs ?? {}).flatMap(
      (job) => job.steps ?? [],
    )) {
      if (!step.uses?.startsWith('actions/checkout@')) continue;
      // No ref checks out the base branch: trusted code, never the pull request head.
      expect(
        [undefined, '${{ github.event.repository.default_branch }}'],
        `${name} checks out ${step.with?.ref}, not the default branch`,
      ).toContain(step.with?.ref);
      expect(
        step.with?.repository,
        `${name} checks out another repository`,
      ).toBeUndefined();
    }
  }
});

test('an issue closed as a duplicate says so and is not solved', () => {
  const change = topicStateChange(closedIssue('duplicate'));
  expect(change).toMatchObject({ solve: false, close: true });
  expect(
    change?.reply.startsWith('Closed on GitHub as a duplicate by robin.'),
  ).toBe(true);
});

test('a merged pull request without merged_by credits the sender', () => {
  const change = topicStateChange({
    action: 'closed',
    sender: { login: 'robin' },
    pull_request: {
      number: 12,
      merged: true,
      merged_by: null,
      html_url: 'u',
      closed_at: '2026-11-01T07:00:00Z',
    },
  });
  expect(change?.reply.startsWith('Merged on GitHub by robin.')).toBe(true);
});

/* Function: Discourse refuses a non-staff user's identical post within 5 minutes. */
test('close, reopen and close again give three different replies, the same event the same reply', () => {
  const first = topicStateChange(closedIssue('completed'))!.reply;
  const reopen = topicStateChange({
    ...closedIssue('completed'),
    action: 'reopened',
  })!.reply;
  const again = closedIssue('completed');
  again.issue.closed_at = '2026-11-01T07:03:00Z';
  const second = topicStateChange(again)!.reply;
  expect(new Set([first, reopen, second]).size).toBe(3);
  expect(first).toContain('2026-11-01T07:00:00Z');
  expect(reopen).toContain('2026-11-01T07:02:00Z');
  expect(
    topicStateChange(closedIssue('completed'))!.reply,
    'a re-run of one event must give the same text, so its earlier reply can be found',
  ).toBe(first);
});

test('a close event without its time fails instead of posting', () => {
  const event = closedIssue('completed');
  event.issue.closed_at = '';
  expect(() => topicStateChange(event)).toThrow(/closed_at/);
});

const API = 'forum-bot';
const posts = (...extra: object[]) => [
  { id: 1, post_number: 1, username: API },
  ...extra,
];

test('a close replies, accepts that reply, then closes', () => {
  const change = topicStateChange(closedIssue('completed'))!;
  expect(stateSteps(change, posts()).map((s) => s.step)).toEqual([
    'reply',
    'accept-reply',
    'close',
  ]);
});

test('a close keeps an answer a person already accepted', () => {
  const change = topicStateChange(closedIssue('completed'))!;
  const steps = stateSteps(
    change,
    posts({ id: 5, username: 'nami', accepted_answer: true }),
  ).map((s) => s.step);
  expect(steps).toEqual(['reply', 'close']);
});

test('a reopen reopens first and unaccepts only close replies, from any API user, not a person or a mirrored comment', () => {
  const change = topicStateChange({
    ...closedIssue('completed'),
    action: 'reopened',
  })!;
  const closeReply = topicStateChange(closedIssue('completed'))!.reply;
  expect(
    stateSteps(
      change,
      posts(
        {
          id: 5,
          username: 'nami',
          raw: 'Closed on GitHub as completed by robin. Thanks, it works now.',
          accepted_answer: true,
        },
        {
          id: 7,
          username: API,
          raw: 'robin wrote on GitHub:\n\nThe fix is in #12.',
          accepted_answer: true,
        },
        {
          id: 9,
          username: 'Forum-Bot',
          raw: closeReply,
          accepted_answer: true,
        },
        {
          id: 10,
          username: 'old-bot',
          raw: closeReply,
          accepted_answer: true,
        },
        {
          id: 12,
          username: 'nami',
          raw: 'Closed on GitHub via #12:\n\nhttps://github.com/o/r/pull/12',
          accepted_answer: true,
        },
        {
          id: 14,
          username: 'old-bot',
          raw: change.reply,
          accepted_answer: true,
        },
      ),
    ),
  ).toEqual([
    { step: 'reopen' },
    { step: 'unaccept', postId: 9 },
    { step: 'unaccept', postId: 10 },
    { step: 'reply' },
  ]);
});

/* Function: a re-run after a failed accept or close must not post its reply twice. */
test("a re-run reuses its earlier reply from any API user, even after a mirrored comment, but not a person's post", () => {
  const { reply } = topicStateChange(closedIssue('completed'))!;
  const earlier = {
    id: 11,
    post_number: 4,
    username: 'Forum-Bot',
    raw: reply,
  };
  expect(earlierReplyId(posts(earlier), reply)).toBe(11);
  expect(
    earlierReplyId(
      posts(earlier, {
        id: 13,
        post_number: 6,
        username: API,
        raw: 'nami wrote on GitHub:\n\nStill broken for me.',
      }),
      reply,
    ),
    'a comment the bot mirrored after the reply must not hide it',
  ).toBe(11);
  expect(
    earlierReplyId(posts({ ...earlier, username: 'old-bot' }), reply),
    'a reply an earlier API user posted must be reused, not posted again',
  ).toBe(11);
  expect(
    earlierReplyId(
      posts({
        ...earlier,
        username: 'nami',
        raw: reply.split('\n')[0],
      }),
      reply,
    ),
    "a person quoting the reply's first line is not the bot's reply",
  ).toBeNull();
  expect(
    earlierReplyId(
      posts({
        ...earlier,
        raw: reply.replace('2026-11-01T07:00:00Z', '2026-11-01T06:00:00Z'),
      }),
      reply,
    ),
    'a close before a reopen is not this close, so it posts again',
  ).toBeNull();
  expect(earlierReplyId(posts(), reply)).toBeNull();
});

test('a reply Discourse will not let the bot accept takes the notice path', () => {
  expect(acceptDecision({ can_accept_answer: true })).toBe('accept');
  expect(acceptDecision({ can_accept_answer: false })).toBe('notice');
  expect(acceptDecision(undefined)).toBe('notice');
});

/* Function: GitHub cancels all but the newest pending run in a group unless queue is max. */
const PER_ISSUE_WORKFLOWS = [
  'issue-to-discourse.yml',
  'pr-to-discourse.yml',
  'discourse-comment-to-topic.yml',
  'discourse-state.yml',
];

test('every forum workflow per issue queues its runs without dropping one', () => {
  type Workflow = { concurrency?: { group?: string; queue?: string } };
  for (const name of PER_ISSUE_WORKFLOWS) {
    const { concurrency } = load(
      readFileSync(`.github/workflows/${name}`, 'utf8'),
    ) as Workflow;
    expect(
      concurrency?.group,
      `${name} runs outside the per-issue forum queue`,
    ).toBe(
      'discourse-${{ github.event.issue.number || github.event.pull_request.number }}',
    );
    expect(
      concurrency?.queue,
      `${name} drops pending runs in its concurrency group`,
    ).toBe('max');
  }
});

/* Function: a run that opened the topic but failed to comment must link it on a re-run, not 422 on the title. */
type Hit = { method: string; url: string; body: string };

const fakeForumAndGithub = (
  topicExists: boolean,
): Promise<{ server: Server; origin: string; hits: Hit[] }> =>
  new Promise((resolve) => {
    const hits: Hit[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const url = req.url ?? '';
        hits.push({ method: req.method ?? '', url, body });
        const json = (status: number, data: unknown, location?: string) => {
          res.writeHead(status, {
            'content-type': 'application/json',
            ...(location ? { location } : {}),
          });
          res.end(JSON.stringify(data));
        };
        if (url.startsWith('/repos/o/r/issues/12/comments'))
          return req.method === 'POST' ? json(201, {}) : json(200, []);
        if (url === `/t/external_id/${topicExternalId('o/r', 12, true)}.json`)
          return topicExists
            ? json(301, {}, '/t/fix-the-menu/77.json')
            : json(404, { errors: ['Not found'] });
        if (url === '/t/fix-the-menu/77.json')
          return json(200, { id: 77, slug: 'fix-the-menu' });
        if (url === '/posts.json' && req.method === 'POST')
          return json(200, { topic_id: 78, topic_slug: 'fix-the-menu' });
        json(500, { unexpected: url });
      });
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        hits,
      }),
    );
  });

const runOpenTopic = async (origin: string) => {
  const event = join(mkdtempSync(join(tmpdir(), 'discourse-')), 'event.json');
  writeFileSync(
    event,
    JSON.stringify({
      pull_request: {
        number: 12,
        draft: false,
        title: 'Fix the menu',
        body: 'Fixes the menu.',
        html_url: 'https://github.com/o/r/pull/12',
        user: { login: 'robin', type: 'User' },
      },
    }),
  );
  await promisify(execFile)(
    process.execPath,
    ['scripts/discourse-sync.mjs', 'open-topic'],
    {
      env: {
        PATH: process.env.PATH,
        GITHUB_EVENT_PATH: event,
        GITHUB_API_URL: origin,
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_TOKEN: 'gh-token',
        DISCOURSE_URL: origin,
        DISCOURSE_CATEGORY_ID: '5',
        DISCOURSE_API_KEY: 'key',
        DISCOURSE_API_USERNAME: 'forum-bot',
      },
    },
  );
};

const linkComments = (hits: Hit[]) =>
  hits
    .filter(({ method, url }) => method === 'POST' && url.includes('/comments'))
    .map(({ body }) => JSON.parse(body).body);

test('a re-run links the topic an earlier run opened instead of opening another', async () => {
  const fake = await fakeForumAndGithub(true);
  try {
    await runOpenTopic(fake.origin);
    expect(
      fake.hits.some(({ url }) => url === '/posts.json'),
      'a topic with this external_id exists, so no new one may be created',
    ).toBe(false);
    expect(linkComments(fake.hits)).toEqual([
      `${PR_LINK_COMMENT_PREFIX}${fake.origin}/t/fix-the-menu/77`,
    ]);
  } finally {
    fake.server.close();
  }
});

test('a new pull request topic carries its external_id and is linked', async () => {
  const fake = await fakeForumAndGithub(false);
  try {
    await runOpenTopic(fake.origin);
    const created = fake.hits.find(({ url }) => url === '/posts.json');
    expect(JSON.parse(created?.body ?? '{}').external_id).toBe(
      topicExternalId('o/r', 12, true),
    );
    expect(linkComments(fake.hits)).toEqual([
      `${PR_LINK_COMMENT_PREFIX}${fake.origin}/t/fix-the-menu/78`,
    ]);
  } finally {
    fake.server.close();
  }
});

test('repositories that share a forum get different external_ids that Discourse accepts', () => {
  const longest = `${'o'.repeat(39)}/${'r'.repeat(100)}`;
  const ids = [
    topicExternalId('o/r', 1, false),
    topicExternalId('o/other', 1, false),
    topicExternalId('o/r', 1, true),
    topicExternalId(longest, 2_147_483_647, true),
  ];
  expect(new Set(ids).size, 'two topics share an external_id').toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^[\w-]{1,50}$/);
  expect(repoKey('o/r')).toMatch(/^[0-9a-f]{12}$/);
});

test('a state reply posted by an earlier API user stays on the forum', () => {
  const none = new Set<number>();
  const replies = [
    topicStateChange(closedIssue('completed'))!.reply,
    topicStateChange({ ...closedIssue('completed'), action: 'reopened' })!
      .reply,
    topicStateChange({
      action: 'closed',
      sender: { login: 'robin' },
      pull_request: {
        number: 12,
        html_url: 'https://github.com/o/r/pull/12',
        merged: true,
        merged_by: { login: 'robin' },
        closed_at: '2026-11-01T07:00:00Z',
      },
    })!.reply,
    'Closed on GitHub as completed by robin.\n\nhttps://github.com/o/r/issues/3',
  ];
  for (const raw of replies)
    expect(
      shouldMirrorPost({ ...reply, username: 'old-bot', raw }, API_USER, none),
      `"${raw.split('\n')[0]}" must not be copied to GitHub`,
    ).toBe(false);
});

test("a person's reply that starts like a state reply still goes to GitHub", () => {
  const none = new Set<number>();
  expect(
    shouldMirrorPost(
      {
        ...reply,
        raw: 'Closed on GitHub as completed by robin. Thanks, it works now.',
      },
      API_USER,
      none,
    ),
  ).toBe(true);
  expect(
    shouldMirrorPost(
      {
        ...reply,
        raw: 'Closed on GitHub via #12:\n\nhttps://github.com/o/r/pull/12',
      },
      API_USER,
      none,
    ),
    'a reply ending in a GitHub link is not a state reply without the "by <login>." line',
  ).toBe(true);
});

test('a 403 on a topic status change names both the missing scope and the missing user rights', async () => {
  const forum = await serve(() => ({ status: 403 }));
  try {
    const failure = request(
      `${forum.origin}/t/42/status`,
      { method: 'PUT', body: '{}' },
      STATUS_SCOPE,
    );
    await expect(failure).rejects.toThrow(`needs the "${STATUS_SCOPE}" scope`);
    await expect(failure).rejects.toThrow(/trust level 4/);
    await expect(
      request(
        `${forum.origin}/posts.json`,
        { method: 'POST' },
        'topics: write',
      ),
      'only closing and reopening depend on user rights',
    ).rejects.not.toThrow(/trust level 4/);
  } finally {
    forum.server.close();
  }
});

test('a forum topic whose issue was deleted is skipped instead of failing the run', async () => {
  const fake = await serve((url) => {
    if (url.startsWith('/c/5/l/latest.json'))
      return {
        status: 200,
        body: {
          topic_list: {
            topics: [
              {
                id: 90,
                title: 'GitHub issue #42: Deleted',
                category_id: 5,
                bumped_at: new Date().toISOString(),
              },
            ],
          },
        },
      };
    if (url === '/t/90.json')
      return {
        status: 200,
        body: { id: 90, slug: 'deleted', post_stream: { stream: [1, 501] } },
      };
    if (url.startsWith('/t/90/posts.json'))
      return {
        status: 200,
        body: { post_stream: { posts: [firstPost, reply] } },
      };
    if (url === '/repos/o/r/issues/42')
      return { status: 410, body: { message: 'This issue was deleted' } };
    return { status: 500, body: { unexpected: url } };
  });
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['scripts/discourse-sync.mjs', 'to-github'],
      {
        env: {
          PATH: process.env.PATH,
          GITHUB_API_URL: fake.origin,
          GITHUB_REPOSITORY: 'o/r',
          GITHUB_TOKEN: 'gh-token',
          DISCOURSE_URL: fake.origin,
          DISCOURSE_CATEGORY_ID: '5',
          DISCOURSE_API_KEY: 'key',
          DISCOURSE_API_USERNAME: 'forum-bot',
        },
      },
    );
    expect(stdout).toContain('Copied 0 forum replies to GitHub.');
    expect(
      fake.hits,
      'a deleted issue has no comments to read',
    ).not.toContainEqual(expect.stringMatching(/comments/));
  } finally {
    fake.server.close();
  }
});

type Step = { name?: string; uses?: string; run?: string };
type Job = { steps?: Step[] };
type Workflow = { on?: unknown; jobs?: Record<string, Job> };
const WORKFLOW_DIR = '.github/workflows';
const workflows = (): { name: string; workflow: Workflow }[] =>
  readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml'))
    .map((name) => ({
      name,
      workflow: load(
        readFileSync(`${WORKFLOW_DIR}/${name}`, 'utf8'),
      ) as Workflow,
    }));
const steps = (workflow: Workflow): Step[] =>
  Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);

test('a category id that is not a positive whole number is refused', () => {
  expect(parseCategoryId('5')).toBe(5);
  for (const value of ['github', '0', '-1', '5.5', '', undefined]) {
    expect(
      () => parseCategoryId(value),
      `${String(value)} was accepted`,
    ).toThrow(/DISCOURSE_CATEGORY_ID/);
  }
});

/* Security: a run step reads untrusted text from env, never from an expression. */
test('no run step interpolates a ${{ }} expression', () => {
  for (const { name, workflow } of workflows()) {
    for (const step of steps(workflow)) {
      expect(
        step.run ?? '',
        `${name} step "${step.name}" puts an expression in its script`,
      ).not.toContain('${{');
    }
  }
});

/* Security: a tag can be moved to other code; a commit SHA cannot. */
test('every action is pinned to a full commit SHA', () => {
  for (const { name, workflow } of workflows()) {
    for (const step of steps(workflow)) {
      if (!step.uses) continue;
      expect(step.uses, `${name} uses an action by tag or branch`).toMatch(
        /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/,
      );
    }
  }
});

/* Security: a pull_request_target job has the secrets, so no step may fetch the pull request's code. */
test('no pull_request_target run step fetches the pull request', () => {
  const fetchesPullRequest =
    /gh pr checkout|refs\/pull\/|pull\/[^/\s]+\/(?:head|merge)|head\.(?:ref|sha)/;
  for (const { name, workflow } of workflows()) {
    if (!JSON.stringify(workflow.on ?? {}).includes('pull_request_target'))
      continue;
    for (const step of steps(workflow)) {
      expect(
        step.run ?? '',
        `${name} step "${step.name}" fetches the pull request`,
      ).not.toMatch(fetchesPullRequest);
    }
  }
});

type Route = (
  method: string,
  url: string,
  body: string,
) =>
  { status: number; body?: unknown; headers?: Record<string, string> } | 'drop';

const fakeApi = (
  route: Route,
): Promise<{ server: Server; origin: string; hits: Hit[] }> =>
  new Promise((resolve) => {
    const hits: Hit[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const method = req.method ?? '';
        const url = req.url ?? '';
        hits.push({ method, url, body });
        const answer = route(method, url, body);
        if (answer === 'drop') return req.socket.destroy();
        res.writeHead(answer.status, {
          'content-type': 'application/json',
          ...answer.headers,
        });
        res.end(JSON.stringify(answer.body ?? {}));
      });
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        hits,
      }),
    );
  });

const runMode = async (
  mode: string,
  origin: string,
  event?: unknown,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const eventPath = join(mkdtempSync(join(tmpdir(), 'discourse-')), 'e.json');
  writeFileSync(eventPath, JSON.stringify(event ?? {}));
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ['scripts/discourse-sync.mjs', mode],
      {
        env: {
          PATH: process.env.PATH,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_API_URL: origin,
          GITHUB_REPOSITORY: 'o/r',
          GITHUB_TOKEN: 'gh-token',
          DISCOURSE_URL: origin,
          DISCOURSE_CATEGORY_ID: '5',
          DISCOURSE_API_KEY: 'key',
          DISCOURSE_API_USERNAME: API_USER,
          ...env,
        },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
};

const recentTopic = (id: number, issue: number) => ({
  id,
  title: `GitHub issue #${issue}: Crash`,
  category_id: 5,
  bumped_at: new Date().toISOString(),
});
const topicLink = (topicId: number) => ({
  user: { login: BOT_LOGIN, type: 'Bot' },
  body: `${LINK_COMMENT_PREFIX}https://forum.example.com/t/crash/${topicId}`,
});
const firstPost = {
  id: 1,
  post_number: 1,
  post_type: 1,
  username: API_USER,
  raw: 'Opened',
};

test('a nested marker in forum text cannot mark another post as mirrored', () => {
  const copied = githubCommentBody(
    {
      ...reply,
      id: 600,
      raw: 'x <!-- discourse-post:<!-- discourse-post:1 -->777 --> y',
    },
    'https://forum.example.com/t/x/42/3',
  );
  expect([
    ...mirroredPostIds([{ user: { login: BOT_LOGIN }, body: copied }]),
  ]).toEqual([600]);
});

test('a pinned topic bumped inside the window syncs, an old pinned one neither syncs nor ends paging', () => {
  const cutoff = Date.parse('2026-10-29T00:00:00Z');
  const page = [
    { id: 1, pinned: true, bumped_at: '2026-10-30T00:00:00Z' },
    { id: 2, pinned: true, bumped_at: '2020-01-01T00:00:00Z' },
    { id: 3, bumped_at: '2026-10-30T00:00:00Z' },
  ];
  expect(splitByActivity(page, cutoff)).toEqual({
    recent: [page[0], page[2]],
    older: false,
  });
});

test('a forum reply longer than a GitHub comment is shortened, keeping its link and marker', () => {
  const url = 'https://forum.example.com/t/x/42/2';
  for (const raw of ['x'.repeat(70_000), '😀'.repeat(70_000)]) {
    const body = githubCommentBody({ ...reply, raw }, url);
    expect(Array.from(body).length).toBeLessThanOrEqual(
      GITHUB_MAX_COMMENT_CHARS,
    );
    expect(body).toContain(GITHUB_TRUNCATED_NOTE);
    expect(body).toContain(url);
    expect(body.endsWith(markerOf(reply.id))).toBe(true);
    expect(body, 'a cut must not split a surrogate pair').not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/,
    );
  }
});

test('one failing topic is reported while later topics still sync, and the run fails', async () => {
  const fake = await fakeApi((method, url) => {
    if (url.startsWith('/c/5/l/latest.json'))
      return {
        status: 200,
        body: {
          topic_list: { topics: [recentTopic(90, 4), recentTopic(91, 3)] },
        },
      };
    if (url === '/t/90.json') return { status: 403, body: { errors: ['no'] } };
    if (url === '/t/91.json')
      return {
        status: 200,
        body: { id: 91, slug: 'crash', post_stream: { stream: [1, 501] } },
      };
    if (url.startsWith('/t/91/posts.json'))
      return {
        status: 200,
        body: { post_stream: { posts: [firstPost, reply] } },
      };
    if (url === '/repos/o/r/issues/3')
      return {
        status: 200,
        body: { number: 3, repository_url: `${fake.origin}/repos/o/r` },
      };
    if (url.startsWith('/repos/o/r/issues/3/comments'))
      return method === 'POST'
        ? { status: 201 }
        : { status: 200, body: [topicLink(91)] };
    return { status: 500, body: { unexpected: url } };
  });
  try {
    const run = await runMode('to-github', fake.origin);
    expect(run.code, 'a failed topic must fail the run').not.toBe(0);
    expect(run.stderr).toContain('topic 90');
    expect(
      fake.hits.filter(
        ({ method, url }) =>
          method === 'POST' && url.startsWith('/repos/o/r/issues/3/comments'),
      ),
      'topic 91 still syncs after topic 90 fails',
    ).toHaveLength(1);
  } finally {
    fake.server.close();
  }
});

test('a GET retries a 5xx answer and a dropped connection, a POST does not', async () => {
  let calls = 0;
  const fake = await fakeApi((method, url) => {
    calls += 1;
    if (url === '/flaky' && calls === 1)
      return { status: 503, headers: { 'retry-after': '1' } };
    if (url === '/dropped' && calls === 3) return 'drop';
    if (url === '/post') return { status: 502 };
    return { status: 200, body: { ok: true } };
  });
  try {
    expect(await (await request(`${fake.origin}/flaky`, {})).json()).toEqual({
      ok: true,
    });
    expect(await (await request(`${fake.origin}/dropped`, {})).json()).toEqual({
      ok: true,
    });
    await expect(
      request(`${fake.origin}/post`, { method: 'POST', body: '{}' }),
    ).rejects.toThrow(/answered 502/);
    expect(fake.hits.map(({ url }) => url)).toEqual([
      '/flaky',
      '/flaky',
      '/dropped',
      '/dropped',
      '/post',
    ]);
  } finally {
    fake.server.close();
  }
});

test('ordinary text that starts like a mirror header is still copied both ways', () => {
  expect(
    shouldMirrorComment({ ...human, body: 'I wrote on the forum: see logs' }),
  ).toBe(true);
  expect(
    shouldMirrorPost(
      { ...reply, raw: 'I wrote on GitHub: see logs' },
      API_USER,
      new Set(),
    ),
  ).toBe(true);
  expect(
    shouldMirrorPost(
      { ...reply, username: 'old-bot', raw: forumReplyBody(human) },
      API_USER,
      new Set(),
    ),
    'a mirror an earlier API user posted is still recognized',
  ).toBe(false);
});

test('a re-run of a comment already on the forum posts nothing', async () => {
  const fake = await fakeApi((method, url) => {
    if (url.startsWith('/repos/o/r/issues/3/comments'))
      return { status: 200, body: [topicLink(42)] };
    if (url === '/t/42.json')
      return {
        status: 200,
        body: { id: 42, slug: 'crash', post_stream: { stream: [1, 7] } },
      };
    if (url.startsWith('/t/42/posts.json'))
      return {
        status: 200,
        body: {
          post_stream: {
            posts: [
              firstPost,
              {
                id: 7,
                post_number: 2,
                post_type: 1,
                username: API_USER,
                raw: forumReplyBody(human),
              },
            ],
          },
        },
      };
    return { status: 500, body: { unexpected: `${method} ${url}` } };
  });
  try {
    const run = await runMode('to-forum', fake.origin, {
      comment: human,
      issue: { number: 3 },
    });
    expect(run.code).toBe(0);
    expect(fake.hits.filter(({ method }) => method === 'POST')).toEqual([]);
  } finally {
    fake.server.close();
  }
});

test('discourse-comment-to-topic.yml skips comments from bots', () => {
  const job = (
    load(
      readFileSync('.github/workflows/discourse-comment-to-topic.yml', 'utf8'),
    ) as {
      jobs: Record<string, { if?: string }>;
    }
  ).jobs['to-forum'];
  expect(job.if).toContain("github.event.comment.user.type != 'Bot'");
});

test('a topic with no reply from a person costs no GitHub request', async () => {
  const fake = await fakeApi((method, url) => {
    if (url.startsWith('/c/5/l/latest.json'))
      return {
        status: 200,
        body: { topic_list: { topics: [recentTopic(91, 3)] } },
      };
    if (url === '/t/91.json')
      return {
        status: 200,
        body: { id: 91, slug: 'crash', post_stream: { stream: [1, 2] } },
      };
    if (url.startsWith('/t/91/posts.json'))
      return {
        status: 200,
        body: {
          post_stream: {
            posts: [
              firstPost,
              {
                id: 2,
                post_number: 2,
                post_type: 1,
                username: API_USER,
                raw: forumReplyBody(human),
              },
            ],
          },
        },
      };
    return { status: 500, body: { unexpected: `${method} ${url}` } };
  });
  try {
    const run = await runMode('to-github', fake.origin);
    expect(run.code).toBe(0);
    expect(fake.hits.filter(({ url }) => url.startsWith('/repos/'))).toEqual(
      [],
    );
  } finally {
    fake.server.close();
  }
});

const openedIssue = {
  issue: {
    number: 3,
    title: 'Crash',
    body: 'Ping @nami about it.',
    html_url: 'https://github.com/o/r/issues/3',
    user: { login: 'robin', type: 'User' },
  },
};

test('a new issue opens a topic with its own external_id and is linked from the issue', async () => {
  const fake = await fakeApi((method, url) => {
    if (url.startsWith('/repos/o/r/issues/3/comments'))
      return method === 'POST' ? { status: 201 } : { status: 200, body: [] };
    if (url === `/t/external_id/${topicExternalId('o/r', 3, false)}.json`)
      return { status: 404, body: { errors: ['Not found'] } };
    if (url === '/posts.json' && method === 'POST')
      return { status: 200, body: { topic_id: 80, topic_slug: 'crash' } };
    return { status: 500, body: { unexpected: `${method} ${url}` } };
  });
  try {
    const run = await runMode('open-topic', fake.origin, openedIssue);
    expect(run.code).toBe(0);
    const created = JSON.parse(
      fake.hits.find(({ url }) => url === '/posts.json')?.body ?? '{}',
    );
    expect(created).toMatchObject({
      title: 'GitHub issue #3: Crash',
      category: 5,
      external_id: topicExternalId('o/r', 3, false),
    });
    expect(created.raw).toContain('https://github.com/o/r/issues/3');
    expect(created.raw).toContain('@\u200bnami');
    expect(linkComments(fake.hits)).toEqual([
      `${LINK_COMMENT_PREFIX}${fake.origin}/t/crash/80`,
    ]);
  } finally {
    fake.server.close();
  }
});

test('open-topic refuses a category id that is not a positive whole number before posting', async () => {
  const fake = await fakeApi((method, url) => {
    if (url.startsWith('/repos/o/r/issues/3/comments'))
      return { status: 200, body: [] };
    if (url.startsWith('/t/external_id/'))
      return { status: 404, body: { errors: ['Not found'] } };
    return { status: 500, body: { unexpected: `${method} ${url}` } };
  });
  try {
    const run = await runMode('open-topic', fake.origin, openedIssue, {
      DISCOURSE_CATEGORY_ID: '5abc',
    });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('Set DISCOURSE_CATEGORY_ID');
    expect(fake.hits.filter(({ method }) => method === 'POST')).toEqual([]);
  } finally {
    fake.server.close();
  }
});

test('a person quoting the comment link in the topic does not stop the comment', async () => {
  const fake = await fakeApi((method, url) => {
    if (url.startsWith('/repos/o/r/issues/3/comments'))
      return { status: 200, body: [topicLink(42)] };
    if (url === '/t/42.json')
      return {
        status: 200,
        body: { id: 42, slug: 'crash', post_stream: { stream: [1, 7] } },
      };
    if (url.startsWith('/t/42/posts.json'))
      return {
        status: 200,
        body: {
          post_stream: {
            posts: [
              firstPost,
              {
                id: 7,
                post_number: 2,
                post_type: 1,
                username: 'nami',
                raw: `See\n\n${human.html_url}`,
              },
            ],
          },
        },
      };
    if (url === '/posts.json' && method === 'POST')
      return { status: 200, body: { id: 8 } };
    return { status: 500, body: { unexpected: `${method} ${url}` } };
  });
  try {
    const run = await runMode('to-forum', fake.origin, {
      comment: human,
      issue: { number: 3 },
    });
    expect(run.code, run.stderr).toBe(0);
    expect(fake.hits.filter(({ method }) => method === 'POST')).toHaveLength(1);
  } finally {
    fake.server.close();
  }
});

test('a topic the forum keeps failing is skipped while later topics sync, and the run fails', async () => {
  const fake = await fakeApi((method, url) => {
    if (url.startsWith('/c/5/l/latest.json'))
      return {
        status: 200,
        body: {
          topic_list: { topics: [recentTopic(90, 4), recentTopic(91, 3)] },
        },
      };
    if (url === '/t/90.json')
      return { status: 503, headers: { 'retry-after': '1' } };
    if (url === '/t/91.json')
      return {
        status: 200,
        body: { id: 91, slug: 'crash', post_stream: { stream: [1, 501] } },
      };
    if (url.startsWith('/t/91/posts.json'))
      return {
        status: 200,
        body: { post_stream: { posts: [firstPost, reply] } },
      };
    if (url === '/repos/o/r/issues/3')
      return {
        status: 200,
        body: { number: 3, repository_url: `${fake.origin}/repos/o/r` },
      };
    if (url.startsWith('/repos/o/r/issues/3/comments'))
      return method === 'POST'
        ? { status: 201 }
        : { status: 200, body: [topicLink(91)] };
    return { status: 500, body: { unexpected: `${method} ${url}` } };
  });
  try {
    const run = await runMode('to-github', fake.origin);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('Could not sync topic 90');
    expect(run.stderr).not.toContain('Stopped before');
    expect(
      fake.hits.filter(
        ({ method, url }) =>
          method === 'POST' && url.startsWith('/repos/o/r/issues/3/comments'),
      ),
    ).toHaveLength(1);
  } finally {
    fake.server.close();
  }
});

test('a failing topic reports the cause of a network error', async () => {
  const fake = await fakeApi((method, url) => {
    if (url.startsWith('/c/5/l/latest.json'))
      return {
        status: 200,
        body: { topic_list: { topics: [recentTopic(91, 3)] } },
      };
    if (url === '/t/91.json')
      return {
        status: 200,
        body: { id: 91, slug: 'crash', post_stream: { stream: [1, 501] } },
      };
    if (url.startsWith('/t/91/posts.json'))
      return {
        status: 200,
        body: { post_stream: { posts: [firstPost, reply] } },
      };
    if (url === '/repos/o/r/issues/3')
      return {
        status: 200,
        body: { number: 3, repository_url: `${fake.origin}/repos/o/r` },
      };
    if (url.startsWith('/repos/o/r/issues/3/comments'))
      return method === 'POST'
        ? 'drop'
        : { status: 200, body: [topicLink(91)] };
    return { status: 500, body: { unexpected: `${method} ${url}` } };
  });
  try {
    const run = await runMode('to-github', fake.origin);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toMatch(/Could not sync topic 91: fetch failed \(.+\)/);
  } finally {
    fake.server.close();
  }
});

for (const [name, headers, stops] of [
  ['a secondary rate limit (retry-after) stops', { 'retry-after': '60' }, true],
  [
    'a primary rate limit (no requests left) stops',
    { 'x-ratelimit-remaining': '0' },
    true,
  ],
  [
    'a 403 that is not a rate limit skips one topic',
    { 'x-ratelimit-remaining': '4999' },
    false,
  ],
] as [string, Record<string, string>, boolean][])
  test(`in to-github, a GitHub ${name}`, async () => {
    const fake = await fakeApi((method, url) => {
      if (url.startsWith('/c/5/l/latest.json'))
        return {
          status: 200,
          body: {
            topic_list: { topics: [recentTopic(91, 3), recentTopic(92, 4)] },
          },
        };
      const topic = /^\/t\/(9[12])(?:\.json|\/posts\.json)/.exec(url)?.[1];
      if (topic && url.endsWith('.json'))
        return {
          status: 200,
          body: {
            id: Number(topic),
            slug: 'crash',
            post_stream: { stream: [1, 501] },
          },
        };
      if (topic)
        return {
          status: 200,
          body: { post_stream: { posts: [firstPost, reply] } },
        };
      if (url === '/repos/o/r/issues/3')
        return { status: 403, headers, body: { message: 'Forbidden' } };
      if (url === '/repos/o/r/issues/4')
        return {
          status: 200,
          body: { number: 4, repository_url: `${fake.origin}/repos/o/r` },
        };
      if (url.startsWith('/repos/o/r/issues/4/comments'))
        return method === 'POST'
          ? { status: 201 }
          : { status: 200, body: [topicLink(92)] };
      return { status: 500, body: { unexpected: `${method} ${url}` } };
    });
    try {
      const run = await runMode('to-github', fake.origin);
      expect(run.code).not.toBe(0);
      expect(run.stderr.includes('Stopped before 1 more topic')).toBe(stops);
      expect(fake.hits.some(({ url }) => url === '/repos/o/r/issues/4')).toBe(
        !stops,
      );
    } finally {
      fake.server.close();
    }
  });

test('a request GitHub or Discourse never received, such as a bad header, is not retried', async () => {
  const started = performance.now();
  await expect(
    request('http://127.0.0.1:9/t/1.json', {
      headers: { 'Api-Key': 'bad\nkey' },
    }),
  ).rejects.toThrow(/header/i);
  /* The first retry waits BACKOFF_BASE_MS, 2 s. */
  expect(performance.now() - started, 'a bad header was retried').toBeLessThan(
    2_000,
  );
});

test('a re-run for an issue links the topic an earlier run opened instead of posting', async () => {
  const fake = await fakeApi((method, url) => {
    if (url.startsWith('/repos/o/r/issues/3/comments'))
      return method === 'POST' ? { status: 201 } : { status: 200, body: [] };
    if (url === `/t/external_id/${topicExternalId('o/r', 3, false)}.json`)
      return { status: 301, headers: { location: '/t/crash/80.json' } };
    if (url === '/t/crash/80.json')
      return { status: 200, body: { id: 80, slug: 'crash' } };
    return { status: 500, body: { unexpected: `${method} ${url}` } };
  });
  try {
    const run = await runMode('open-topic', fake.origin, openedIssue);
    expect(run.code, run.stderr).toBe(0);
    expect(fake.hits.some(({ url }) => url === '/posts.json')).toBe(false);
    expect(linkComments(fake.hits)).toEqual([
      `${LINK_COMMENT_PREFIX}${fake.origin}/t/crash/80`,
    ]);
  } finally {
    fake.server.close();
  }
});

test('each mode stops at its run deadline, before its job times out', () => {
  const modes = new Set<string>();
  for (const { name, workflow } of workflows()) {
    for (const job of Object.values(workflow.jobs ?? {}) as {
      'timeout-minutes'?: number;
      steps?: Step[];
    }[]) {
      const mode = (job.steps ?? [])
        .map(
          (step) =>
            /node scripts\/discourse-sync\.mjs (\S+)/.exec(step.run ?? '')?.[1],
        )
        .find(Boolean);
      if (!mode) continue;
      modes.add(mode);
      const deadline = (RUN_DEADLINE_MS as Record<string, number>)[mode];
      expect(
        deadline,
        `${name} runs ${mode}, which has no deadline`,
      ).toBeGreaterThan(0);
      expect(
        deadline + SETUP_MARGIN_MS,
        `${name} can time out before ${mode} reaches its deadline`,
      ).toBeLessThanOrEqual((job['timeout-minutes'] ?? 0) * 60_000);
    }
  }
  expect([...modes].sort()).toEqual([
    'open-topic',
    'state',
    'to-forum',
    'to-github',
  ]);
});

test('a forum that never answers fails the run at its deadline with a clear error', async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const started = performance.now();
    const run = await runMode(
      'to-forum',
      origin,
      { comment: human, issue: { number: 3 } },
      { SYNC_DEADLINE_MS: '1500' },
    );
    expect(run.code).not.toBe(0);
    expect(run.stderr).toMatch(/passed its 1\.5 s run deadline/);
    expect(performance.now() - started).toBeLessThan(10_000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

const ZWSP = '​';
/* Defusing time over one simple pass on the same text: about 10 to 30 when linear, over 20,000 for the old repeated strip. */
const costOverOnePass = (text: string) => {
  const best = (run: () => void) =>
    Math.min(
      ...[1, 2, 3].map(() => {
        const started = performance.now();
        run();
        return performance.now() - started;
      }),
    );
  return (
    best(() => defuseText(text)) /
    Math.max(
      best(() => text.replace(/x/g, 'y').toUpperCase()),
      0.01,
    )
  );
};

for (const [name, input, expected] of [
  ['a mention', '@octocat look', `@${ZWSP}octocat look`],
  [
    'a mention after a letter',
    'é@octocat 中@octocat',
    `é@${ZWSP}octocat 中@${ZWSP}octocat`,
  ],
  [
    'a mention after a link',
    '[x](https://forum.example.com)@octocat',
    `[x](https://forum.example.com)@${ZWSP}octocat`,
  ],
  [
    'a mention after <',
    'https://forum.example.com<@octocat',
    `https://forum.example.com<@${ZWSP}octocat`,
  ],
  [
    'a mention after a broken link',
    'see http://)@octocat',
    `see http://)@${ZWSP}octocat`,
  ],
  ['an email address', 'a@b.example.com', `a@${ZWSP}b.example.com`],
  [
    'a reference after a link',
    '[x](https://forum.example.com)octocat/Hello-World#1',
    `[x](https://forum.example.com)octocat/Hello-World#${ZWSP}1`,
  ],
  [
    'a GitHub link after a link',
    '[t](https://forum.example.com)https://github.com/octocat/Hello-World/issues/1',
    `[t](https://forum.example.com)https://redirect.github.com/octocat/Hello-World/issues/${ZWSP}1`,
  ],
  [
    'a link fragment',
    'https://forum.example.com/t/x/123#4',
    `https://forum.example.com/t/x/123#${ZWSP}4`,
  ],
  [
    'an entity for @',
    '&#64;octocat &commat;octocat',
    `&amp;#${ZWSP}64;octocat &amp;commat;octocat`,
  ],
  [
    'an entity for # and :',
    'cli/cli&#35;2 [x](https&#58;//github.com/a)',
    `cli/cli&amp;#${ZWSP}35;2 [x](https&amp;#${ZWSP}58;//redirect.github.com/a)`,
  ],
  [
    'a redirect link, kept',
    'https://redirect.github.com/a',
    'https://redirect.github.com/a',
  ],
  ['a marker', '<!-- discourse-post:5 -->', `<!-- discourse-post${ZWSP}:5 -->`],
  [
    'a GH- reference',
    'GH-1 gh-0001 (Gh-2)',
    `GH-${ZWSP}1 gh-${ZWSP}0001 (Gh-${ZWSP}2)`,
  ],
  [
    'an issue path',
    'actions/checkout/issues/1 and /pull/2',
    `actions/checkout/issues/${ZWSP}1 and /pull/${ZWSP}2`,
  ],
  [
    'a relative issue path',
    '/issues/3 ../issues/1 pulls/4 discussions/5',
    `/issues/${ZWSP}3 ../issues/${ZWSP}1 pulls/${ZWSP}4 discussions/${ZWSP}5`,
  ],
  [
    'a scheme-less GitHub link',
    'github.com/o/r/issues/1',
    `redirect.github.com/o/r/issues/${ZWSP}1`,
  ],
  [
    'a Discourse quote',
    '[quote="octocat, post:1, topic:2"] [QUOTE=x]',
    `[quote${ZWSP}="octocat, post:1, topic:2"] [QUOTE${ZWSP}=x]`,
  ],
] as const)
  test(`copied text defuses ${name}`, () => {
    expect(defuseText(input)).toBe(expected);
  });

test('no adversarial input keeps a mention, reference, entity, GitHub link or marker', () => {
  const corpus = [
    '@a',
    '_@a_',
    '`@a',
    'a/@a',
    'é@a',
    '(@a)',
    '&#64;a',
    '&#x40;a',
    '&commat;a',
    'o/r#1',
    'o/r&#35;1',
    'o/r&num;1',
    '#1',
    'GH-1 #1',
    'gh-0001',
    '(GH-1)',
    'actions/checkout/issues/1',
    'o/r/pull/2',
    '/issues/3',
    '../issues/1',
    'pulls/4',
    'discussions/5',
    '[quote="octocat, post:1, topic:2"]',
    'https://github.com/o/r/issues/1',
    'HTTPS://GITHUB.COM/o/r/pull/2',
    'www.github.com/o/r/issues/3',
    'github.com/o/r',
    '[x](https&#58;//github.com/o/r/issues/4)',
    '<!-- discourse-post:<!-- discourse-post:1 -->7 -->',
    '&amp;#64;a',
    '&&#64;a',
  ];
  for (const input of corpus) {
    const out = defuseText(input);
    expect(out, input).not.toMatch(/@(?!​)/);
    expect(out, input).not.toMatch(/#\d/);
    expect(out, input).not.toMatch(/\bgh-\d/i);
    expect(out, input).not.toMatch(/\b(?:issues|pulls?|discussions)\/\d/);
    expect(out, input).not.toMatch(/\[quote(?!\u200b)/i);
    expect(out, input).not.toMatch(/&#|&(?!amp;)[A-Za-z]+;/);
    expect(out, input).not.toMatch(/(?<!redirect\.)github\.com/i);
    expect(out, input).not.toMatch(/discourse-post:/);
  }
});

test('copied text is defused in linear time, nested markers included', () => {
  const nested = (n: number) =>
    '<!-- discourse-post:'.repeat(n) + '1 -->' + '7 -->'.repeat(n);
  const mixed = (n: number) => 'a/@#1&#64;github.com '.repeat(n);
  for (const make of [nested, mixed])
    expect(
      costOverOnePass(make(20_000)),
      'defusing is not linear',
    ).toBeLessThan(300);
});

test('a mode name inherited from Object, such as constructor, is refused', async () => {
  const run = await runMode('constructor', 'http://127.0.0.1:9');
  expect(run.code).not.toBe(0);
  expect(run.stderr).toContain('Usage: discourse-sync.mjs');
});

test('a mirror-shaped post from someone other than the API user does not stop the comment', async () => {
  const fake = await fakeApi((method, url) => {
    if (url.startsWith('/repos/o/r/issues/3/comments'))
      return { status: 200, body: [topicLink(42)] };
    if (url === '/t/42.json')
      return {
        status: 200,
        body: { id: 42, slug: 'crash', post_stream: { stream: [1, 7] } },
      };
    if (url.startsWith('/t/42/posts.json'))
      return {
        status: 200,
        body: {
          post_stream: {
            posts: [
              firstPost,
              {
                id: 7,
                post_number: 2,
                post_type: 1,
                username: 'mallory',
                raw: forumReplyBody(human),
              },
            ],
          },
        },
      };
    if (url === '/posts.json' && method === 'POST')
      return { status: 200, body: { id: 8 } };
    return { status: 500, body: { unexpected: `${method} ${url}` } };
  });
  try {
    const run = await runMode('to-forum', fake.origin, {
      comment: human,
      issue: { number: 3 },
    });
    expect(run.code, run.stderr).toBe(0);
    expect(fake.hits.filter(({ method }) => method === 'POST')).toHaveLength(1);
  } finally {
    fake.server.close();
  }
});

test('an issue opened by a bot opens no topic', async () => {
  const fake = await fakeApi((method, url) => ({
    status: 500,
    body: { unexpected: `${method} ${url}` },
  }));
  try {
    const run = await runMode('open-topic', fake.origin, {
      issue: {
        ...openedIssue.issue,
        user: { login: 'renovate[bot]', type: 'Bot' },
      },
    });
    expect(run.code, run.stderr).toBe(0);
    expect(fake.hits).toEqual([]);
  } finally {
    fake.server.close();
  }
});

test('a forum username that reads as a reference is defused in the GitHub comment header', () => {
  const body = githubCommentBody(
    { ...reply, username: 'gh-12' },
    'https://forum.example.com/t/x/42/2',
  );
  expect(body.startsWith(`gh-${ZWSP}12 wrote on the forum:`)).toBe(true);
});
