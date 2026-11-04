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
  defuseText,
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
const POST_URL = 'https://forum.example.com/t/crash/42/2';
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

/* Defusing time over one simple pass on the same text: about 10 to 30 when linear, over 20,000 for a repeated strip. */
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

/* Security: a copy must never notify anyone, link an issue, add a backlink or claim a post. */
describe('copied text', () => {
  const cases: [string, string, string][] = [
    ['a mention at the start of a line', '@nami look', `@${ZWSP}nami look`],
    ['a mention in emphasis', '_@nami_', `_@${ZWSP}nami_`],
    ['a team', '@org/team', `@${ZWSP}org/team`],
    ['a non-ASCII name', 'hi @ñandú', `hi @${ZWSP}ñandú`],
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
    ['a mention after a backtick', '`@nami', `\`@${ZWSP}nami`],
    ['an email address', 'a@b.example.com', `a@${ZWSP}b.example.com`],
    ['owner/repo#N', 'other/repo#2', `other/repo#${ZWSP}2`],
    ['a plain #N', '#3', `#${ZWSP}3`],
    [
      'a reference after a link',
      '[x](https://forum.example.com)octocat/Hello-World#1',
      `[x](https://forum.example.com)octocat/Hello-World#${ZWSP}1`,
    ],
    [
      'a github.com link',
      'See https://github.com/other/repo/issues/1.',
      `See https://redirect.github.com/other/repo/issues/${ZWSP}1.`,
    ],
    [
      'a GitHub link after a link',
      '[t](https://forum.example.com)https://github.com/o/r/issues/1',
      `[t](https://forum.example.com)https://redirect.github.com/o/r/issues/${ZWSP}1`,
    ],
    [
      'a GH- reference',
      'GH-1 gh-0001 (Gh-2)',
      `GH-${ZWSP}1 gh-${ZWSP}0001 (Gh-${ZWSP}2)`,
    ],
    [
      'a cross-repository issue path',
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
    [
      'a www.github.com link',
      'www.github.com/o/r',
      'www.redirect.github.com/o/r',
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
      'an entity in a link',
      '[x](https&#58;//github.com/a)',
      `[x](https&amp;#${ZWSP}58;//redirect.github.com/a)`,
    ],
    [
      'a redirect link, kept',
      'https://redirect.github.com/a',
      'https://redirect.github.com/a',
    ],
    [
      'a marker',
      '<!-- discourse-post:5 -->',
      `<!-- discourse-post${ZWSP}:5 -->`,
    ],
  ];
  for (const [name, input, expected] of cases)
    test(`defuses ${name}`, () => assert.equal(defuseText(input), expected));

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
      assert.doesNotMatch(out, /@(?!​)/, input);
      assert.doesNotMatch(out, /#\d/, input);
      assert.doesNotMatch(out, /\bgh-\d/i, input);
      assert.doesNotMatch(out, /\b(?:issues|pulls?|discussions)\/\d/, input);
      assert.doesNotMatch(out, /\[quote(?!\u200b)/i, input);
      assert.doesNotMatch(out, /&#|&(?!amp;)[A-Za-z]+;/, input);
      assert.doesNotMatch(out, /(?<!redirect\.)github\.com/i, input);
      assert.doesNotMatch(out, /discourse-post:/, input);
    }
  });

  for (const [name, make] of [
    [
      'nested markers',
      (n: number) =>
        '<!-- discourse-post:'.repeat(n) + '1 -->' + '7 -->'.repeat(n),
    ],
    [
      'mixed text',
      (n: number) => 'a/@#1&#64;github.com GH-1 issues/1 [quote '.repeat(n),
    ],
  ] as const)
    test(`defusing ${name} takes linear time`, () => {
      assert.ok(costOverOnePass(make(20_000)) < 300, 'defusing is not linear');
    });
});

/* Security: a forum username cannot notify anyone or link an issue on GitHub. */
describe('the forum username in a copied reply', () => {
  test('is defused when it reads as a reference', () => {
    assert.ok(
      githubCommentBody({ ...reply, username: 'gh-12' }, POST_URL).startsWith(
        `gh-${ZWSP}12 wrote on the forum:`,
      ),
    );
  });
});

/* Security: only the bot can mark a forum post as copied. */
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
    test(`${name} in forum text cannot mark another post as mirrored`, () => {
      const body = githubCommentBody({ ...reply, id: 600, raw }, POST_URL);
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
    body: `${prefix}https://forum.example.com/t/crash/42`,
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
    [
      'a reply from the API user, matched in any case',
      { ...reply, username: 'Forum-Bot' },
    ],
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
