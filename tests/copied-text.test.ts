import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  BOT_LOGIN,
  FORUM_MAX_POST_CHARS,
  GITHUB_MAX_COMMENT_CHARS,
  GITHUB_TRUNCATED_NOTE,
  LINK_COMMENT_PREFIX,
  PR_LINK_COMMENT_PREFIX,
  TRUNCATED_NOTE,
  defuseMentions,
  defuseReferences,
  forumReplyBody,
  githubCommentBody,
  markerOf,
  mirroredPostIds,
  newTopic,
  parseCategoryId,
  repoKey,
  shouldMirrorComment,
  shouldMirrorPost,
  topicExternalId,
  topicIdFromComments,
  topicStateChange,
  topicTarget,
} from '../scripts/discourse-sync.mjs';
import { API_USER } from './fake-apis.ts';

const ZWSP = '​';
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const POST_URL = 'https://forum.example/t/crash/42/2';
const reply = {
  id: 501,
  post_number: 2,
  post_type: 1,
  username: 'robin',
  raw: 'Seen it too.',
};
const comment = {
  id: 9,
  user: { login: 'robin', type: 'User' },
  body: 'Same here.',
  html_url: 'https://github.com/o/r/issues/3#issuecomment-9',
};
const none = new Set<number>();
const codePoints = (text: string) => Array.from(text).length;

describe('mentions', () => {
  const cases: [string, string, string][] = [
    ['at the start of a line', '@nami look', `@${ZWSP}nami look`],
    ['after a space', 'ping @nami', `ping @${ZWSP}nami`],
    ['in emphasis', '_@nami_', `_@${ZWSP}nami_`],
    ['a team', '@org/team', `@${ZWSP}org/team`],
    ['a non-ASCII name', 'hi @ñandú', `hi @${ZWSP}ñandú`],
    ['an email address, left alone', 'mail a@b.example', 'mail a@b.example'],
    [
      'after a backtick, since a lone one opens no code span',
      '`@nami',
      `\`@${ZWSP}nami`,
    ],
    ['after a slash', 'a/@nami', `a/@${ZWSP}nami`],
    ['as a numeric HTML entity', '&#64;nami', '&amp;#64;nami'],
    ['as a named HTML entity', '&commat;nami', '&amp;commat;nami'],
    [
      'in a link, left whole',
      'https://forum.example.com/u/@nami',
      'https://forum.example.com/u/@nami',
    ],
    ['other entities, left alone', 'a &lt; b &amp; c', 'a &lt; b &amp; c'],
    [
      'inside a code span after a space, defused too',
      '`npm i @scope/x`',
      `\`npm i @${ZWSP}scope/x\``,
    ],
  ];
  for (const [name, input, expected] of cases)
    test(name, () => assert.equal(defuseMentions(input), expected));
});

describe('references in forum text copied to GitHub', () => {
  test('a github.com link points to redirect.github.com, so it adds no backlink', () => {
    assert.equal(
      defuseReferences('See https://github.com/other/repo/issues/1.'),
      'See https://redirect.github.com/other/repo/issues/1.',
    );
  });

  test('owner/repo#N is broken with a zero-width space, a plain #N is kept', () => {
    assert.equal(
      defuseReferences('other/repo#2 and #3'),
      `other/repo#${ZWSP}2 and #3`,
    );
  });

  for (const [name, input, expected] of [
    ['a reference with an entity for #', 'cli/cli&#35;2', 'cli/cli&amp;#35;2'],
    [
      'a link with an entity for :',
      '[x](https&#58;//github.com/cli/cli/issues/3)',
      '[x](https&amp;#58;//github.com/cli/cli/issues/3)',
    ],
    [
      'a www.github.com link',
      'www.github.com/cli/cli/issues/3',
      'https://redirect.github.com/cli/cli/issues/3',
    ],
    [
      'a link with a numeric fragment, left whole',
      'https://forum.example.com/t/x/123#4',
      'https://forum.example.com/t/x/123#4',
    ],
    [
      'a link to another site with owner/repo#N in its path, left whole',
      'https://docs.example.com/a/b#3',
      'https://docs.example.com/a/b#3',
    ],
  ] as const)
    test(name, () => assert.equal(defuseReferences(input), expected));

  test('long text is processed in linear time', () => {
    const started = performance.now();
    defuseReferences('a/'.repeat(30_000) + 'x'.repeat(70_000));
    assert.ok(
      performance.now() - started < 1_000,
      'the reference pattern backtracks on long text',
    );
  });
});

describe('markers', () => {
  test('only the bot can mark a forum post as mirrored', () => {
    const forged = mirroredPostIds([
      { user: { login: 'mallory' }, body: markerOf(501) },
    ]);
    assert.deepEqual([...forged], []);
  });

  for (const [name, raw] of [
    ['a plain marker', 'hi <!-- discourse-post:777 -->'],
    [
      'a nested marker',
      'x <!-- discourse-post:<!-- discourse-post:1 -->777 --> y',
    ],
    [
      'a doubly nested marker',
      '<!-- discourse-post:<!-- discourse-post:<!-- discourse-post:1 -->2 -->777 -->',
    ],
    [
      'a marker nested 10,000 deep',
      '<!-- discourse-post:'.repeat(10_000) + '1 -->' + '7 -->'.repeat(10_000),
    ],
  ])
    test(`${name} in forum text cannot mark another post as mirrored, in linear time`, () => {
      const started = performance.now();
      const body = githubCommentBody({ ...reply, id: 600, raw }, POST_URL);
      assert.ok(
        performance.now() - started < 1_000,
        'marker defusing is not linear',
      );
      assert.deepEqual(
        [...mirroredPostIds([{ user: { login: BOT_LOGIN }, body }])],
        [600],
      );
    });
});

describe('a forum reply copied to GitHub', () => {
  test('names the author without an @, links the post and ends with its marker', () => {
    assert.equal(
      githubCommentBody({ ...reply, raw: '@luffy look' }, POST_URL),
      `robin wrote on the forum:\n\n@${ZWSP}luffy look\n\n${POST_URL}\n${markerOf(501)}`,
    );
  });

  for (const [name, raw] of [
    ['ASCII', 'x'.repeat(70_000)],
    ['emoji', '😀'.repeat(70_000)],
  ])
    test(`longer than a GitHub comment (${name}) is shortened with a note, keeping its link and marker`, () => {
      const body = githubCommentBody({ ...reply, raw }, POST_URL);
      assert.ok(codePoints(body) <= GITHUB_MAX_COMMENT_CHARS);
      assert.ok(
        body.includes(
          `${GITHUB_TRUNCATED_NOTE}\n\n${POST_URL}\n${markerOf(501)}`,
        ),
      );
      assert.doesNotMatch(body, LONE_SURROGATE);
    });
});

describe('a GitHub comment copied to the forum', () => {
  test('names the author without an @ and ends with the comment link', () => {
    assert.equal(
      forumReplyBody({ ...comment, body: 'Same, @nami.' }),
      `robin wrote on GitHub:\n\nSame, @${ZWSP}nami.\n\n${comment.html_url}`,
    );
  });

  for (const [name, body] of [
    ['ASCII', 'x'.repeat(70_000)],
    ['emoji', '😀'.repeat(70_000)],
  ])
    test(`longer than a forum post (${name}) is shortened with a note, keeping its link`, () => {
      const raw = forumReplyBody({ ...comment, body });
      assert.ok(codePoints(raw) <= FORUM_MAX_POST_CHARS);
      assert.ok(raw.endsWith(`${TRUNCATED_NOTE}\n\n${comment.html_url}`));
      assert.doesNotMatch(raw, LONE_SURROGATE);
    });
});

describe('a new topic', () => {
  const item = {
    number: 12,
    title: 'Fix the menu',
    body: 'Fixes it, @nami.',
    html_url: 'https://github.com/o/r/pull/12',
    user: { login: 'robin' },
  };

  test('names an issue or a pull request in its title', () => {
    assert.equal(newTopic(item, false).title, 'GitHub issue #12: Fix the menu');
    assert.equal(
      newTopic(item, true).title,
      'GitHub pull request #12: Fix the menu',
    );
  });

  test('opens with the author and link, then the defused body', () => {
    assert.equal(
      newTopic(item, true).raw,
      `Opened by robin on GitHub:\n\n${item.html_url}\n\n---\n\nFixes it, @${ZWSP}nami.`,
    );
  });

  test('says so when the body is empty', () => {
    assert.ok(
      newTopic({ ...item, body: null }, false).raw.endsWith(
        '_No description provided._',
      ),
    );
  });

  test('a title longer than 255 characters ends in an ellipsis without splitting an emoji', () => {
    const title = newTopic({ ...item, title: '🐈'.repeat(300) }, true).title;
    assert.equal(codePoints(title), 255);
    assert.ok(title.endsWith('…'));
    assert.doesNotMatch(title, LONE_SURROGATE);
  });

  for (const [name, body] of [
    ['ASCII', 'x'.repeat(70_000)],
    ['emoji', '😀'.repeat(70_000)],
  ])
    test(`a body longer than a forum post (${name}) is shortened with a note`, () => {
      const { raw } = newTopic({ ...item, body }, false);
      assert.ok(codePoints(raw) <= FORUM_MAX_POST_CHARS);
      assert.ok(
        raw.startsWith(`Opened by robin on GitHub:\n\n${item.html_url}`),
      );
      assert.ok(raw.endsWith(TRUNCATED_NOTE));
      assert.doesNotMatch(raw, LONE_SURROGATE);
    });
});

describe('external ids', () => {
  test('repositories that share a forum get different ids that Discourse accepts', () => {
    const ids = [
      topicExternalId('o/r', 1, false),
      topicExternalId('o/other', 1, false),
      topicExternalId('o/r', 1, true),
      topicExternalId(
        `${'o'.repeat(39)}/${'r'.repeat(100)}`,
        2_147_483_647,
        true,
      ),
    ];
    assert.equal(
      new Set(ids).size,
      ids.length,
      'two topics share an external_id',
    );
    for (const id of ids) assert.match(id, /^[\w-]{1,50}$/);
  });

  test('the repository key is the first 12 hex characters of its SHA-256', () => {
    assert.equal(repoKey('o/r'), '964584196b5c');
  });
});

describe('the topic link comment', () => {
  const link = (prefix: string, login = BOT_LOGIN) => ({
    user: { login },
    body: `${prefix}https://forum.example/t/crash/42`,
  });

  test('binds the topic for an issue or a pull request when the bot posted it', () => {
    assert.equal(topicIdFromComments([comment, link(LINK_COMMENT_PREFIX)]), 42);
    assert.equal(topicIdFromComments([link(PR_LINK_COMMENT_PREFIX)]), 42);
  });

  test('binds nothing when a person posted the same text', () => {
    assert.equal(
      topicIdFromComments([link(LINK_COMMENT_PREFIX, 'robin')]),
      null,
    );
    assert.equal(topicIdFromComments([comment]), null);
  });

  test('a topic title names its issue or pull request', () => {
    assert.deepEqual(topicTarget('GitHub issue #322: Crash'), {
      number: 322,
      pullRequest: false,
    });
    assert.deepEqual(topicTarget('GitHub pull request #12: Fix'), {
      number: 12,
      pullRequest: true,
    });
    assert.equal(topicTarget('Re: GitHub issue #322: Crash'), null);
    assert.equal(topicTarget(undefined), null);
  });
});

describe('what is copied', () => {
  test('a comment from a person goes to the forum', () => {
    assert.equal(shouldMirrorComment(comment), true);
    assert.equal(
      shouldMirrorComment({
        ...comment,
        body: 'I wrote on the forum: see logs',
      }),
      true,
    );
  });

  for (const [name, skipped] of [
    [
      'a bot comment',
      { ...comment, user: { login: 'dependabot[bot]', type: 'Bot' } },
    ],
    [
      'the workflow comment',
      { ...comment, user: { login: BOT_LOGIN, type: 'Bot' } },
    ],
    [
      'a forum reply already copied',
      { ...comment, body: githubCommentBody(reply, POST_URL) },
    ],
  ] as const)
    test(`${name} does not go to the forum`, () =>
      assert.equal(shouldMirrorComment(skipped), false));

  test('a reply from a person goes to GitHub, even when it starts like a mirror header', () => {
    assert.equal(shouldMirrorPost(reply, API_USER, none), true);
    assert.equal(
      shouldMirrorPost(
        { ...reply, raw: 'I wrote on GitHub: see logs' },
        API_USER,
        none,
      ),
      true,
    );
  });

  for (const [name, post] of [
    ['the first post', { ...reply, post_number: 1 }],
    ['the API user, in any case', { ...reply, username: 'Forum-Bot' }],
    ['a moderator action', { ...reply, post_type: 3 }],
    ['a hidden post', { ...reply, hidden: true }],
    ['a deleted post', { ...reply, deleted_at: '2026-11-01T00:00:00Z' }],
    [
      'a GitHub comment an earlier API user copied',
      { ...reply, username: 'old-bot', raw: forumReplyBody(comment) },
    ],
  ] as const)
    test(`${name} does not go to GitHub`, () =>
      assert.equal(shouldMirrorPost(post, API_USER, none), false));

  const closed = {
    action: 'closed',
    sender: { login: 'robin' },
    issue: {
      number: 3,
      html_url: 'https://github.com/o/r/issues/3',
      state_reason: 'completed',
      closed_at: '2026-11-01T07:00:00Z',
      updated_at: '2026-11-01T07:02:00Z',
    },
  };
  const merged = {
    action: 'closed',
    sender: { login: 'robin' },
    pull_request: {
      number: 12,
      html_url: 'https://github.com/o/r/pull/12',
      merged: true,
      merged_by: { login: 'nami' },
      closed_at: '2026-11-01T07:00:00Z',
    },
  };
  for (const [name, raw] of [
    ['a close reply', topicStateChange(closed)!.reply],
    [
      'a reopen reply',
      topicStateChange({ ...closed, action: 'reopened' })!.reply,
    ],
    ['a merge reply', topicStateChange(merged)!.reply],
    [
      'a close reply in the format without the event time',
      'Closed on GitHub as completed by robin.\n\nhttps://github.com/o/r/issues/3',
    ],
  ] as const)
    test(`${name} from an earlier API user does not go to GitHub`, () =>
      assert.equal(
        shouldMirrorPost(
          { ...reply, username: 'old-bot', raw },
          API_USER,
          none,
        ),
        false,
      ));

  for (const raw of [
    'Closed on GitHub as completed by robin. Thanks, it works now.',
    'Closed on GitHub via #12:\n\nhttps://github.com/o/r/pull/12',
  ])
    test(`a person's reply "${raw.split('\n')[0]}" goes to GitHub`, () =>
      assert.equal(shouldMirrorPost({ ...reply, raw }, API_USER, none), true));

  test('a reply already copied does not go to GitHub again', () => {
    const done = mirroredPostIds([
      { user: { login: BOT_LOGIN }, body: githubCommentBody(reply, POST_URL) },
    ]);
    assert.equal(shouldMirrorPost(reply, API_USER, done), false);
  });
});

describe('the category id', () => {
  for (const value of ['5', '54'])
    test(`${value} is accepted`, () =>
      assert.equal(parseCategoryId(value), Number(value)));
  for (const value of ['', '0', '05', '5abc', '-1', '1.5', undefined])
    test(`${JSON.stringify(value)} is refused`, () =>
      assert.throws(() => parseCategoryId(value), /Set DISCOURSE_CATEGORY_ID/));
});
