#!/usr/bin/env node
/*
 * Mirrors issue and pull request comments and forum replies between GitHub and their topics.
 * `open-topic`, `to-forum` and `state` read GITHUB_EVENT_PATH; `to-github` copies recent replies (README.md).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* Must match the comment issue-to-discourse.yml posts. */
export const LINK_COMMENT_PREFIX =
  'Discussion for this issue is open on the forum: ';
export const PR_LINK_COMMENT_PREFIX =
  'Discussion for this pull request is open on the forum: ';
const LINK_PREFIXES = [LINK_COMMENT_PREFIX, PR_LINK_COMMENT_PREFIX];
export const BOT_LOGIN = 'github-actions[bot]';
const GITHUB_HEADER = /^\S+ wrote on GitHub:\n/;
const GITHUB_COMMENT_FOOTER = /\n\S+#issuecomment-\d+$/;
const MARKER = /<!-- discourse-post:(\d+) -->/g;
const TOPIC_TITLE = /^GitHub (issue|pull request) #(\d+):/;
const TOPIC_URL = /\/t\/[^/\s]+\/(\d+)\b/;
/* Discourse's regular post type; moderator actions, small actions and whispers are others. */
const REGULAR_POST = 1;

const LOOKBACK_HOURS = 48;
const MS_PER_HOUR = 3_600_000;
const POSTS_PER_REQUEST = 100;
const GITHUB_PAGE_SIZE = 100;
const MAX_ATTEMPTS = 5;
/* One request with four waits and five 30 s timeouts takes at most 4.5 minutes. */
const MAX_RETRY_AFTER_S = 30;
const BACKOFF_BASE_MS = 2_000;
const MS_PER_S = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_GONE = 410;
const ERROR_BODY_CHARS = 500;
/* Discourse's default max_post_length; GitHub allows 65,536. */
/* issue-to-discourse.yml passes the same limit and note to jq. */
export const FORUM_MAX_POST_CHARS = 32_000;
export const TRUNCATED_NOTE = '\n\n(Shortened; the full text is on GitHub.)';
export const GITHUB_MAX_COMMENT_CHARS = 65_536;
export const GITHUB_TRUNCATED_NOTE =
  '\n\n(Shortened; the full text is on the forum.)';
/* Discourse's default max_topic_title_length. */
const FORUM_MAX_TITLE_CHARS = 255;
const TITLE_ELLIPSIS = '…';
const HTTP_TOO_MANY = 429;

export const markerOf = (postId) => `<!-- discourse-post:${postId} -->`;

/**
 * Copied text, in either direction, without context parsing: every marker keyword, @ and #digit
 * gets a zero-width space, entities that could decode to them are escaped, and github.com becomes
 * redirect.github.com. So no copy notifies anyone, links an issue or claims a post (README.md#limits-and-privacy).
 */
export const defuseText = (text) =>
  text
    .replaceAll('discourse-post:', 'discourse-post\u200b:')
    .replace(/&(?=#|[A-Za-z]+;)/g, '&amp;')
    .replaceAll('@', '@\u200b')
    .replace(/#(?=\d)/g, '#\u200b')
    .replace(/(?<!redirect\.)github\.com/gi, 'redirect.github.com');

/** Forum post ids already mirrored, read from the bot's comments only. */
export const mirroredPostIds = (comments) =>
  new Set(
    comments
      .filter(({ user }) => user?.login === BOT_LOGIN)
      .flatMap(({ body }) =>
        [...(body ?? '').matchAll(MARKER)].map((match) => Number(match[1])),
      ),
  );

/** The issue or pull request a topic title names, or null. */
export const topicTarget = (title) => {
  const match = TOPIC_TITLE.exec(title ?? '');
  return match
    ? { number: Number(match[2]), pullRequest: match[1] === 'pull request' }
    : null;
};

/** Whether a pull request event should open a topic: ready for review, from a person. */
export const shouldOpenTopic = (pullRequest) =>
  !pullRequest.draft && pullRequest.user?.type !== 'Bot';

const REPO_KEY_HEX_CHARS = 12;

/** The first 12 hex characters of the SHA-256 of owner/name; must match issue-to-discourse.yml. */
export const repoKey = (repository) =>
  createHash('sha256')
    .update(repository)
    .digest('hex')
    .slice(0, REPO_KEY_HEX_CHARS);

/* external_id is unique across the forum, so it carries the repository; Discourse allows 50 of [\w-]. */
export const topicExternalId = (repository, number, pullRequest) =>
  `gh-${repoKey(repository)}-${pullRequest ? 'pr' : 'issue'}-${number}`;

const CLOSED_PREFIX = 'Closed on GitHub';
const MERGED_PREFIX = 'Merged on GitHub';
const REOPENED_PREFIX = 'Reopened on GitHub';
const STATE_PREFIXES = [CLOSED_PREFIX, MERGED_PREFIX, REOPENED_PREFIX];
const EVENT_TIME_LABEL = 'Event time: ';
const STATE_REPLY_FIRST_LINE_END = / by \S+\.$/;
/* Replies from versions without the event time end with the GitHub link instead. */
const STATE_REPLY_END = new RegExp(
  `\\n(${EVENT_TIME_LABEL}\\S+|https://github\\.com/\\S+)$`,
);
const CLOSE_REASONS = {
  completed: 'as completed',
  not_planned: 'as not planned',
  duplicate: 'as a duplicate',
};

/**
 * What a close or reopen on GitHub does to the topic: the reply to post, whether
 * that reply becomes the accepted solution, and whether the topic closes.
 */
export const topicStateChange = (event) => {
  const item = event.pull_request ?? event.issue;
  if (!item || !['closed', 'reopened'].includes(event.action)) return null;
  const actor = event.sender?.login ?? 'someone';
  /* Discourse refuses a non-staff user's identical post within 5 minutes; the time keeps each reply unique. */
  const timeField = event.action === 'reopened' ? 'updated_at' : 'closed_at';
  const at = item[timeField];
  if (!at)
    throw new Error(`#${item.number} ${event.action} without ${timeField}.`);
  const footer = `\n\n${item.html_url}\n\n${EVENT_TIME_LABEL}${at}`;
  if (event.action === 'reopened')
    return {
      reply: `${REOPENED_PREFIX} by ${actor}.${footer}`,
      solve: false,
      close: false,
    };
  if (event.pull_request)
    return item.merged
      ? {
          reply: `${MERGED_PREFIX} by ${item.merged_by?.login ?? actor}.${footer}`,
          solve: true,
          close: true,
        }
      : {
          reply: `${CLOSED_PREFIX} without merging by ${actor}.${footer}`,
          solve: false,
          close: true,
        };
  const reason = CLOSE_REASONS[item.state_reason];
  return {
    reply: `${CLOSED_PREFIX} ${reason ? `${reason} ` : ''}by ${actor}.${footer}`,
    solve: item.state_reason === 'completed',
    close: true,
  };
};

/* By code point, so a cut never splits an emoji's surrogate pair. */
const fit = (text, limit, note) => {
  const points = Array.from(text);
  return points.length > limit
    ? `${points.slice(0, limit - Array.from(note).length).join('')}${note}`
    : text;
};

export const pullRequestTopic = (pullRequest) => {
  const body = pullRequest.body
    ? defuseText(pullRequest.body)
    : '_No description provided._';
  const header = `Opened by ${pullRequest.user.login} on GitHub:\n\n${pullRequest.html_url}\n\n---\n\n`;
  return {
    title: fit(
      `GitHub pull request #${pullRequest.number}: ${pullRequest.title}`,
      FORUM_MAX_TITLE_CHARS,
      TITLE_ELLIPSIS,
    ),
    raw: `${header}${fit(body, FORUM_MAX_POST_CHARS - header.length, TRUNCATED_NOTE)}`,
  };
};

/** The topic id from the bot's link comment; null without one, so only topics the workflow opened sync. */
export const topicIdFromComments = (comments) => {
  const link = comments.find(
    ({ user, body }) =>
      user?.login === BOT_LOGIN &&
      LINK_PREFIXES.some((prefix) => (body ?? '').startsWith(prefix)),
  );
  const match = link && TOPIC_URL.exec(link.body);
  return match ? Number(match[1]) : null;
};

/** Whether an issue comment should go to the forum: not the bot's, not already a mirror. */
export const shouldMirrorComment = ({ user, body }) =>
  user?.login !== BOT_LOGIN &&
  user?.type !== 'Bot' &&
  ![...(body ?? '').matchAll(MARKER)].length;

/** A forum post forumReplyBody wrote, under any API username: the header and the comment link last. */
const isGithubMirror = (raw) =>
  GITHUB_HEADER.test(raw ?? '') &&
  GITHUB_COMMENT_FOOTER.test((raw ?? '').trimEnd());

/** A close, merge or reopen reply from topicStateChange, whichever user posted it. */
export const isStateReply = (raw) => {
  const text = (raw ?? '').trim();
  return (
    STATE_PREFIXES.some((prefix) => text.startsWith(prefix)) &&
    STATE_REPLY_FIRST_LINE_END.test(text.split('\n')[0].trimEnd()) &&
    STATE_REPLY_END.test(text)
  );
};

/** Whether a forum post should go to GitHub: a regular reply, not the API user's, not a mirror or state reply, not yet copied. */
export const shouldMirrorPost = (post, apiUsername, alreadyMirrored) =>
  post.post_number > 1 &&
  post.post_type === REGULAR_POST &&
  !post.hidden &&
  !post.deleted_at &&
  post.username?.toLowerCase() !== apiUsername.toLowerCase() &&
  !isGithubMirror(post.raw) &&
  !isStateReply(post.raw) &&
  !alreadyMirrored.has(post.id);

/**
 * One page of a category's latest list, newest bump first: the topics bumped since `cutoff`, and
 * whether an older unpinned one showed, which ends paging. Pinned topics lead page 0 whatever their age.
 */
export const splitByActivity = (topics, cutoff) => {
  const isRecent = (topic) => Date.parse(topic.bumped_at) >= cutoff;
  return {
    recent: topics.filter(isRecent),
    older: topics.some((topic) => !topic.pinned && !isRecent(topic)),
  };
};

export const forumReplyBody = (comment) => {
  const header = `${comment.user.login} wrote on GitHub:\n\n`;
  const footer = `\n\n${comment.html_url}`;
  const text = defuseText(comment.body ?? '');
  const room = FORUM_MAX_POST_CHARS - header.length - footer.length;
  return `${header}${fit(text, room, TRUNCATED_NOTE)}${footer}`;
};

export const githubCommentBody = (post, postUrl) => {
  const header = `${post.username} wrote on the forum:\n\n`;
  const footer = `\n\n${postUrl}\n${markerOf(post.id)}`;
  const text = defuseText(post.raw ?? '');
  const room = GITHUB_MAX_COMMENT_CHARS - Array.from(header + footer).length;
  return `${header}${fit(text, room, GITHUB_TRUNCATED_NOTE)}${footer}`;
};

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};

export const parseCategoryId = (value) => {
  if (!/^[1-9]\d*$/.test(value ?? ''))
    throw new Error(
      `Set DISCOURSE_CATEGORY_ID to the category's number, such as 5, not "${value}".`,
    );
  return Number(value);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

/**
 * Where a GET redirect may go: the same origin only, since fetch would carry the
 * Api-Key header to any host. POSTs never follow (a 301 would resend as a GET).
 */
export const redirectTarget = (from, location, method, origin, hops) => {
  const target = new URL(location ?? '', from);
  if (method !== 'GET')
    throw new Error(
      `${method} ${from} was redirected to ${target}; not followed.`,
    );
  if (target.origin !== origin)
    throw new Error(
      `GET ${from} was redirected off ${origin} to ${target}; not followed.`,
    );
  if (hops >= MAX_REDIRECTS)
    throw new Error(`GET ${from} redirected more than ${MAX_REDIRECTS} times.`);
  return target.href;
};

export const STATUS_SCOPE = 'topics: status';

/* Retries 429 with Retry-After or exponential backoff; a 403 names the scope it needs, and for status the user rights. */
export const request = async (url, init, scopeHint) => {
  const method = init?.method ?? 'GET';
  const origin = new URL(url).origin;
  let current = url;
  let hops = 0;
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(current, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'manual',
    });
    if (REDIRECT_STATUSES.has(response.status)) {
      current = redirectTarget(
        current,
        response.headers.get('location'),
        method,
        origin,
        hops,
      );
      hops += 1;
      attempt -= 1;
      continue;
    }
    if (response.status === HTTP_TOO_MANY && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter, MAX_RETRY_AFTER_S) * MS_PER_S
          : BACKOFF_BASE_MS * 2 ** (attempt - 1),
      );
      continue;
    }
    if (response.ok) return response;
    const text = await response.text();
    const hint =
      response.status === HTTP_FORBIDDEN && scopeHint
        ? scopeHint === STATUS_SCOPE
          ? ` The API key needs the "${scopeHint}" scope, or the API user must be staff, trust level 4 or a category moderator.`
          : ` The API key needs the "${scopeHint}" scope.`
        : '';
    throw Object.assign(
      new Error(
        `${method} ${current} answered ${response.status}.${hint} ${text.slice(0, ERROR_BODY_CHARS)}`,
      ),
      { status: response.status },
    );
  }
};

const forum = () => {
  const base = required('DISCOURSE_URL').replace(/\/$/, '');
  const headers = {
    'Api-Key': required('DISCOURSE_API_KEY'),
    'Api-Username': required('DISCOURSE_API_USERNAME'),
    'Content-Type': 'application/json',
  };
  const get = async (path, scope) =>
    (await request(`${base}${path}`, { headers }, scope)).json();
  const post = async (path, body, scope) =>
    (
      await request(
        `${base}${path}`,
        { method: 'POST', headers, body: JSON.stringify(body) },
        scope,
      )
    ).json();
  const put = async (path, body, scope) =>
    (
      await request(
        `${base}${path}`,
        { method: 'PUT', headers, body: JSON.stringify(body) },
        scope,
      )
    ).json();
  return { base, get, post, put };
};

const github = () => {
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const repo = required('GITHUB_REPOSITORY');
  const headers = {
    Authorization: `Bearer ${required('GITHUB_TOKEN')}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const comments = async (issue) => {
    const all = [];
    let url = `${api}/repos/${repo}/issues/${issue}/comments?per_page=${GITHUB_PAGE_SIZE}`;
    while (url) {
      const response = await request(url, { headers });
      all.push(...(await response.json()));
      url = /<([^>]+)>;\s*rel="next"/.exec(
        response.headers.get('link') ?? '',
      )?.[1];
    }
    return all;
  };
  /* A transferred issue redirects to its new repository; it is not ours to comment on. */
  const issue = async (number) => {
    const found = await (
      await request(`${api}/repos/${repo}/issues/${number}`, { headers })
    ).json();
    return found.repository_url === `${api}/repos/${repo}` ? found : null;
  };
  const comment = (number, body) =>
    request(`${api}/repos/${repo}/issues/${number}/comments`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  return { comments, issue, comment };
};

const toForum = async () => {
  const event = JSON.parse(readFileSync(required('GITHUB_EVENT_PATH'), 'utf8'));
  const { comment, issue } = event;
  if (!comment || !issue) throw new Error('Expected an issue_comment event.');
  if (!shouldMirrorComment(comment))
    return console.log('A bot comment or a mirror; skipped.');
  const topicId = topicIdFromComments(await github().comments(issue.number));
  if (!topicId)
    return console.log(`#${issue.number} has no forum topic; skipped.`);
  const { post } = forum();
  const created = await post(
    '/posts.json',
    { topic_id: topicId, raw: forumReplyBody(comment) },
    'topics: write',
  );
  if (!created?.id)
    throw new Error(
      `Discourse answered without a post id: ${JSON.stringify(created)}`,
    );
  console.log(
    `Comment ${comment.id} posted as forum post ${created.id} in topic ${topicId}.`,
  );
};

const recentTopics = async (get, categoryId, cutoff) => {
  const topics = [];
  for (let page = 0; ; page += 1) {
    const list = await get(
      `/c/${categoryId}/l/latest.json?page=${page}`,
      'topics: read lists',
    );
    const { recent, older } = splitByActivity(
      list.topic_list?.topics ?? [],
      cutoff,
    );
    topics.push(...recent);
    if (older || !list.topic_list?.more_topics_url) return topics;
  }
};

const topicPosts = async (get, topicId) => {
  const topic = await get(`/t/${topicId}.json`, 'topics: read');
  const ids = topic.post_stream?.stream ?? [];
  const posts = [];
  for (let start = 0; start < ids.length; start += POSTS_PER_REQUEST) {
    const query = ids
      .slice(start, start + POSTS_PER_REQUEST)
      .map((id) => `post_ids[]=${id}`)
      .join('&');
    const page = await get(
      `/t/${topicId}/posts.json?include_raw=true&${query}`,
      'topics: read',
    );
    posts.push(...(page.post_stream?.posts ?? []));
  }
  return { topic, posts };
};

const toGithub = async () => {
  const categoryId = parseCategoryId(required('DISCOURSE_CATEGORY_ID'));
  const apiUsername = required('DISCOURSE_API_USERNAME');
  const { base, get } = forum();
  const gh = github();
  const cutoff = Date.now() - LOOKBACK_HOURS * MS_PER_HOUR;
  let copied = 0;
  for (const listed of await recentTopics(get, categoryId, cutoff)) {
    const target = topicTarget(listed.title);
    if (!target || listed.category_id !== categoryId) continue;
    const { number } = target;
    /* GitHub answers 410 for a deleted issue and 404 for one it hides; neither has anything to sync to. */
    const issue = await gh.issue(number).catch((error) => {
      if (error.status === HTTP_NOT_FOUND || error.status === HTTP_GONE)
        return null;
      throw error;
    });
    if (!issue || Boolean(issue.pull_request) !== target.pullRequest) continue;
    const comments = await gh.comments(number);
    if (topicIdFromComments(comments) !== listed.id) continue;
    const done = mirroredPostIds(comments);
    const { topic, posts } = await topicPosts(get, listed.id);
    for (const post of posts.sort((a, b) => a.post_number - b.post_number)) {
      if (!shouldMirrorPost(post, apiUsername, done)) continue;
      const url = `${base}/t/${topic.slug}/${topic.id}/${post.post_number}`;
      await gh.comment(number, githubCommentBody(post, url));
      copied += 1;
    }
  }
  console.log(
    `Copied ${copied} forum ${copied === 1 ? 'reply' : 'replies'} to GitHub.`,
  );
};

const openTopic = async () => {
  const event = JSON.parse(readFileSync(required('GITHUB_EVENT_PATH'), 'utf8'));
  const pullRequest = event.pull_request;
  if (!pullRequest) throw new Error('Expected a pull_request_target event.');
  if (!shouldOpenTopic(pullRequest))
    return console.log('A draft or a bot pull request; skipped.');
  const gh = github();
  if (topicIdFromComments(await gh.comments(pullRequest.number)))
    return console.log(`#${pullRequest.number} already has a forum topic.`);
  const { base, get, post } = forum();
  const externalId = topicExternalId(
    required('GITHUB_REPOSITORY'),
    pullRequest.number,
    true,
  );
  /* A run that opened the topic but failed to comment left it behind; link that one. */
  const existing = await get(
    `/t/external_id/${externalId}.json`,
    'topics: read',
  ).catch((error) => {
    if (error.status === HTTP_NOT_FOUND) return null;
    throw error;
  });
  const created =
    existing ??
    (await post(
      '/posts.json',
      {
        ...pullRequestTopic(pullRequest),
        category: parseCategoryId(required('DISCOURSE_CATEGORY_ID')),
        external_id: externalId,
      },
      'topics: write',
    ));
  const topicId = existing ? existing.id : created?.topic_id;
  const slug = existing ? existing.slug : created?.topic_slug;
  if (!topicId || !slug)
    throw new Error(
      `Discourse answered without a topic: ${JSON.stringify(created)}`,
    );
  const url = `${base}/t/${slug}/${topicId}`;
  await gh.comment(pullRequest.number, `${PR_LINK_COMMENT_PREFIX}${url}`);
  console.log(
    `#${pullRequest.number} ${existing ? 'linked existing' : 'opened'} topic ${topicId}.`,
  );
};

/**
 * The forum steps for a close or reopen, in order. A close accepts its reply only when no
 * answer is accepted yet; a reopen unaccepts only close or merge replies, never a person's choice.
 */
export const stateSteps = (change, posts) => {
  /* A close or merge reply by shape, so an earlier API user's counts; a person's accepted post stays. */
  const isCloseReply = (post) =>
    isStateReply(post.raw) &&
    [CLOSED_PREFIX, MERGED_PREFIX].some((prefix) =>
      (post.raw ?? '').trim().startsWith(prefix),
    );
  if (!change.close)
    return [
      /* First: the topic author may only unaccept in an open topic. */
      { step: 'reopen' },
      ...posts
        .filter((post) => post.accepted_answer && isCloseReply(post))
        .map((post) => ({ step: 'unaccept', postId: post.id })),
      { step: 'reply' },
    ];
  const answered = posts.some((post) => post.accepted_answer);
  return [
    { step: 'reply' },
    ...(change.solve && !answered ? [{ step: 'accept-reply' }] : []),
    { step: 'close' },
  ];
};

/** The id of a reply an earlier run of this event posted, under any username; its event time makes the text unique. */
export const earlierReplyId = (posts, reply) =>
  posts.find((post) => (post.raw ?? '').trim() === reply.trim())?.id ?? null;

/** Accept only what Discourse says this user may accept; Solved off on the category means not. */
export const acceptDecision = (post) =>
  post?.can_accept_answer ? 'accept' : 'notice';

const syncState = async () => {
  const event = JSON.parse(readFileSync(required('GITHUB_EVENT_PATH'), 'utf8'));
  const change = topicStateChange(event);
  if (!change) return console.log(`Nothing to do for "${event.action}".`);
  const number = (event.pull_request ?? event.issue).number;
  const topicId = topicIdFromComments(await github().comments(number));
  if (!topicId) return console.log(`#${number} has no forum topic; skipped.`);
  const { get, post, put } = forum();
  const { posts } = await topicPosts(get, topicId);
  let replyId = null;
  let solved = false;
  for (const { step, postId } of stateSteps(change, posts)) {
    if (step === 'reopen' || step === 'close') {
      await put(
        `/t/${topicId}/status.json`,
        { status: 'closed', enabled: step === 'close' },
        STATUS_SCOPE,
      );
    } else if (step === 'unaccept') {
      await post('/solution/unaccept.json', { id: postId }, 'solved: answer');
    } else if (step === 'reply') {
      replyId = earlierReplyId(posts, change.reply);
      if (replyId) {
        console.log(`Reply ${replyId} is already posted; reused.`);
        continue;
      }
      const reply = await post(
        '/posts.json',
        { topic_id: topicId, raw: change.reply },
        'topics: write',
      );
      if (!reply?.id)
        throw new Error(
          `Discourse answered without a post id: ${JSON.stringify(reply)}`,
        );
      replyId = reply.id;
    } else if (step === 'accept-reply') {
      const page = await get(
        `/t/${topicId}/posts.json?post_ids[]=${replyId}`,
        'topics: read',
      );
      if (acceptDecision(page.post_stream?.posts?.[0]) === 'accept') {
        await post('/solution/accept.json', { id: replyId }, 'solved: answer');
        solved = true;
      } else {
        console.log(
          `::notice::Post ${replyId} cannot be marked as the solution: turn Solved on for the category (Support type).`,
        );
      }
    }
  }
  console.log(
    `Topic ${topicId} ${change.close ? 'closed' : 'reopened'}${solved ? ' and solved' : ''}.`,
  );
};

const main = async () => {
  const mode = process.argv[2];
  if (mode === 'state') return syncState();
  if (mode === 'open-topic') return openTopic();
  if (mode === 'to-forum') return toForum();
  if (mode === 'to-github') return toGithub();
  throw new Error(
    'Usage: discourse-sync.mjs open-topic | to-forum | to-github | state',
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const cause = error.cause ? ` (${error.cause.message ?? error.cause})` : '';
    console.error(`::error::${error.message}${cause}`);
    process.exit(1);
  });
}
