#!/usr/bin/env node
/*
 * Mirrors issue and pull request comments and forum replies between GitHub and their topics.
 * `open-topic`, `to-forum` and `state` read GITHUB_EVENT_PATH; `to-github` copies recent replies (README.md).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/* A bot comment starting with one of these links its topic; topicIdFromComments reads it. */
export const LINK_COMMENT_PREFIX =
  'Discussion for this issue is open on the forum: ';
export const PR_LINK_COMMENT_PREFIX =
  'Discussion for this pull request is open on the forum: ';
const LINK_PREFIXES = [LINK_COMMENT_PREFIX, PR_LINK_COMMENT_PREFIX];
export const BOT_LOGIN = 'github-actions[bot]';
const GITHUB_HEADER =
  /^\S+ (?:wrote|approved|requested changes|commented) on GitHub[:.]/;
/* The link back, inline or, from earlier versions, alone on the last line. */
const GITHUB_COMMENT_FOOTER =
  /\n(?:\[View on GitHub\]\(\S+#(?:issuecomment|pullrequestreview)-\d+\)|\S+#issuecomment-\d+)$/;
const MARKER = /<!-- discourse-post:(\d+) -->/g;
const TOPIC_TITLE = /^GitHub (issue|pull request) #(\d+):/;
const TOPIC_URL = /\/t\/[^/\s]+\/(\d+)\b/;
/* Discourse's regular post type; moderator actions, small actions and whispers are others. */
const REGULAR_POST = 1;

const LOOKBACK_HOURS = 48;
/* A topic bumped before the last successful run started, less this margin for clock skew and slow runs, has nothing new. */
const LAST_RUN_MARGIN_MS = 900_000;
const WORKFLOW_ON_BRANCH = /\/\.github\/workflows\/([^@/]+)@refs\/heads\/(.+)$/;
/* Successful runs checked for a job that ran; past these, the run falls back to the lookback window. */
const RUN_PAGES = 3;
/* Pages of recently updated pull requests read for new reviews per run. */
const PULL_PAGES = 3;
const RUNS_PER_PAGE = 10;
const MS_PER_HOUR = 3_600_000;
const POSTS_PER_REQUEST = 100;
const GITHUB_PAGE_SIZE = 100;
const MAX_ATTEMPTS = 5;
/* The longest Retry-After a GitHub request waits; longer, and the run stops (GitHub warns against calling on). */
const MAX_RETRY_AFTER_S = 20;
/* Discourse's admin API limit is per minute for the whole site, so a forum request waits a full minute; the run deadline still caps it. */
const FORUM_MAX_RETRY_AFTER_S = 60;
/* Discourse allows 60 admin API requests a minute site-wide by default (max_admin_api_reqs_per_minute); 40 leaves room for event runs. */
export const FORUM_READ_GAP_MS = 1_500;
const MAX_FORUM_GAP_MS = 60_000;
const BACKOFF_BASE_MS = 2_000;
const MS_PER_S = 1_000;
const REQUEST_TIMEOUT_MS = 20_000;
const HTTP_SERVER_ERROR = 500;
/* GitHub asks for at least a second between requests that create content (REST API best practices). */
const GITHUB_WRITE_GAP_MS = 1_000;
/* Checkout and setup-node run before the script inside each job's timeout-minutes. */
export const SETUP_MARGIN_MS = 90_000;
/* Below each job's timeout-minutes less SETUP_MARGIN_MS, so a hanging API fails the run with an error, not a cancel. */
export const RUN_DEADLINE_MS = {
  'open-topic': 210_000,
  'to-forum': 210_000,
  state: 210_000,
  'to-github': 510_000,
};
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_GONE = 410;
const ERROR_BODY_CHARS = 500;
/* Discourse's default max_post_length; GitHub allows 65,536. */
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
 * Copied text, in either direction, without context parsing: a zero-width space after every @, #digit,
 * GH-digit, issues/ pull/ pulls/ discussions/ before a digit (backslash escapes included), [quote, username:
 * and the marker keyword; entities that could decode to them are escaped and github.com becomes
 * redirect.github.com (README.md#limits-and-privacy).
 */
export const defuseText = (text) =>
  text
    .replaceAll('discourse-post:', 'discourse-post\u200b:')
    .replace(/&(?=#|[A-Za-z]+;)/g, '&amp;')
    .replaceAll('@', '@\u200b')
    .replace(/#(?=\d)/g, '#\u200b')
    .replace(/(?<!redirect\\?\.)github\\?\.com/gi, 'redirect.github.com')
    .replace(/(?<=\bgh\\?)-(?=\d)/gi, '-\u200b')
    .replace(/(?<=\b(?:issues|pulls?|discussions)\\?\/)(?=\d)/g, '\u200b')
    .replace(/\[quote/gi, '$&\u200b')
    .replace(/username:/gi, 'username\u200b:');

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

/** Whether an issue or pull request should open a topic: not a draft, from a person. */
export const shouldOpenTopic = (item) =>
  !item.draft && item.user?.type !== 'Bot';

const REPO_KEY_HEX_CHARS = 12;

/** The first 12 hex characters of the SHA-256 of owner/name. */
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

/** A link back to GitHub that Discourse shows as text; a URL alone on its line becomes a card repeating the GitHub text. */
const viewOnGithub = (url) => `[View on GitHub](${url})`;
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
  const footer = `\n\n${viewOnGithub(item.html_url)}\n\n${EVENT_TIME_LABEL}${at}`;
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

/** The first post of the topic for an issue or a pull request. */
export const newTopic = (item, pullRequest) => {
  const body = item.body ? defuseText(item.body) : '_No description provided._';
  const header = `Opened by ${item.user.login} on GitHub: ${viewOnGithub(item.html_url)}\n\n---\n\n`;
  return {
    title: fit(
      `GitHub ${pullRequest ? 'pull request' : 'issue'} #${item.number}: ${item.title}`,
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
  const footer = `\n\n${viewOnGithub(comment.html_url)}`;
  const text = defuseText(comment.body ?? '');
  const room = FORUM_MAX_POST_CHARS - header.length - footer.length;
  return `${header}${fit(text, room, TRUNCATED_NOTE)}${footer}`;
};

const REVIEW_VERBS = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'requested changes',
  COMMENTED: 'commented',
};

/** A submitted review summary: its state, its body when it has one, and its link. Code line comments stay on GitHub. */
export const shouldCopyReview = (review, cutoff) =>
  Object.hasOwn(REVIEW_VERBS, review.state) &&
  review.user?.type !== 'Bot' &&
  /* A Commented review with no body holds only code line comments. */
  !(review.state === 'COMMENTED' && !(review.body ?? '').trim()) &&
  Date.parse(review.submitted_at ?? '') >= cutoff;

export const reviewReplyBody = (review) => {
  const lead = `${review.user.login} ${REVIEW_VERBS[review.state]} on GitHub`;
  const footer = `\n\n${viewOnGithub(review.html_url)}`;
  const text = defuseText((review.body ?? '').trim());
  if (!text) return `${lead}.${footer}`;
  const header = `${lead}:\n\n`;
  const room = FORUM_MAX_POST_CHARS - header.length - footer.length;
  return `${header}${fit(text, room, TRUNCATED_NOTE)}${footer}`;
};

export const githubCommentBody = (post, postUrl) => {
  const header = `${defuseText(post.username ?? '')} wrote on the forum:\n\n`;
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

/** The message and, for a network error, its cause. */
const describe = (error) =>
  `${error.message}${error.cause ? ` (${error.cause.message ?? error.cause})` : ''}`;

/* main sets the run deadline for its mode; requests made outside a run have none. */
let runDeadline = { signal: new AbortController().signal, ms: 0 };

const deadlineError = () =>
  Object.assign(
    new Error(
      `The run passed its ${runDeadline.ms / MS_PER_S} s run deadline, set below the job's timeout-minutes. Run it again once the API answers.`,
    ),
    { deadline: true },
  );

/** Waits, unless the run deadline passes first. */
const wait = (ms) =>
  sleep(ms, undefined, { signal: runDeadline.signal }).catch(() => {
    throw deadlineError();
  });

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

const backoffMs = (attempt, retryAfterHeader, maxRetryAfterS) => {
  const retryAfter = Number(retryAfterHeader);
  return Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.min(retryAfter, maxRetryAfterS) * MS_PER_S
    : BACKOFF_BASE_MS * 2 ** (attempt - 1);
};

const GITHUB_LIMITS = {
  maxRetryAfterS: MAX_RETRY_AFTER_S,
  retry429WithoutRetryAfter: false,
};
/* A forum 429 always waits, so an event run keeps its event within the deadline. */
const FORUM_LIMITS = {
  maxRetryAfterS: FORUM_MAX_RETRY_AFTER_S,
  retry429WithoutRetryAfter: true,
};

/**
 * Retries a 429 for any method after its Retry-After, up to the cap in `limits`, and a 5xx, timeout or
 * dropped connection for a GET only, since a repeated POST could post twice. A 403 names the scope it needs.
 */
export const request = async (url, init, scopeHint, limits = GITHUB_LIMITS) => {
  const method = init?.method ?? 'GET';
  const origin = new URL(url).origin;
  let current = url;
  let hops = 0;
  for (let attempt = 1; ; attempt += 1) {
    const canRetry = attempt < MAX_ATTEMPTS;
    let response;
    try {
      response = await fetch(current, {
        ...init,
        signal: AbortSignal.any([
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          runDeadline.signal,
        ]),
        redirect: 'manual',
      });
    } catch (error) {
      if (runDeadline.signal.aborted) throw deadlineError();
      /* A timeout or a network failure (fetch puts it in cause); a bad header or URL would fail again. */
      const network =
        error.name === 'TimeoutError' || error.cause !== undefined;
      if (method !== 'GET' || !canRetry || !network) throw error;
      await wait(backoffMs(attempt));
      continue;
    }
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
    const retryAfter = response.headers.get('retry-after');
    /* Seconds above 0; zero, negative, empty or a date count as no Retry-After. */
    const retryAfterS = Number(retryAfter);
    const hasRetryAfter =
      retryAfter !== null && Number.isFinite(retryAfterS) && retryAfterS > 0;
    /* A 429 waits only as long as its Retry-After says, and only up to the cap; otherwise the caller stops. */
    const waitable429 =
      response.status === HTTP_TOO_MANY &&
      (hasRetryAfter
        ? retryAfterS <= limits.maxRetryAfterS
        : limits.retry429WithoutRetryAfter);
    const serverError =
      method === 'GET' && response.status >= HTTP_SERVER_ERROR;
    if ((waitable429 || serverError) && canRetry) {
      await response.body?.cancel();
      await wait(
        waitable429 && hasRetryAfter
          ? retryAfterS * MS_PER_S
          : backoffMs(attempt, retryAfter, limits.maxRetryAfterS),
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
      {
        status: response.status,
        url: current,
        /* GitHub can send a secondary rate limit as a 403 or 429 with only a message (docs.github.com, rate limits for the REST API). */
        rateLimited:
          response.status === HTTP_TOO_MANY ||
          (response.status === HTTP_FORBIDDEN &&
            (response.headers.get('x-ratelimit-remaining') === '0' ||
              response.headers.has('retry-after') ||
              /rate limit/i.test(text))),
      },
    );
  }
};

/* Discourse makes API keys with SecureRandom.hex(32) (app/models/api_key.rb). */
const API_KEY_FORMAT = /^[0-9a-f]{64}$/;
/* Printable ASCII: fetch sends header values as Latin-1 bytes, so any other name could never sign in. */
const USERNAME_FORMAT = /^[\x21-\x7e]{1,60}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** The forum settings, checked before any request; an error names the setting, never its value. */
export const forumConfig = () => {
  let url;
  try {
    url = new URL(required('DISCOURSE_URL'));
  } catch {
    throw new Error(
      'Set DISCOURSE_URL to the forum base URL, such as https://forum.example.com.',
    );
  }
  /* http only on loopback, for a local forum or the tests. */
  const secure =
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.username || url.password || url.search || url.hash)
    throw new Error(
      'Set DISCOURSE_URL to an https URL without a login, query or fragment.',
    );
  if (!API_KEY_FORMAT.test(required('DISCOURSE_API_KEY')))
    throw new Error(
      'Set DISCOURSE_API_KEY to the 64 hex characters Discourse shows for the key.',
    );
  if (!USERNAME_FORMAT.test(required('DISCOURSE_API_USERNAME')))
    throw new Error("Set DISCOURSE_API_USERNAME to the sync user's username.");
  return {
    base: url.href.replace(/\/$/, ''),
    apiKey: process.env.DISCOURSE_API_KEY,
    apiUsername: process.env.DISCOURSE_API_USERNAME,
  };
};

/** The forum API; with `readGapMs`, each request starts that long after the one before ended, to stay under the site-wide limit. */
const forum = ({ readGapMs = 0 } = {}) => {
  const { base, apiKey, apiUsername } = forumConfig();
  const headers = {
    'Api-Key': apiKey,
    'Api-Username': apiUsername,
    'Content-Type': 'application/json',
  };
  let lastRequestAt = -Infinity;
  const send = async (path, init, scope) => {
    const gap = readGapMs - (Date.now() - lastRequestAt);
    if (gap > 0) await wait(gap);
    try {
      return await (
        await request(
          `${base}${path}`,
          { ...init, headers },
          scope,
          FORUM_LIMITS,
        )
      ).json();
    } finally {
      lastRequestAt = Date.now();
    }
  };
  const get = (path, scope) => send(path, {}, scope);
  const post = (path, body, scope) =>
    send(path, { method: 'POST', body: JSON.stringify(body) }, scope);
  const put = (path, body, scope) =>
    send(path, { method: 'PUT', body: JSON.stringify(body) }, scope);
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
  /* Every page of a list; Link pages are followed only on the API host, so the token stays on GitHub. */
  const allPages = async (path, label) => {
    const all = [];
    let url = `${api}${path}`;
    while (url) {
      const response = await request(url, { headers });
      all.push(...(await response.json()));
      url = /<([^>]+)>;\s*rel="next"/.exec(
        response.headers.get('link') ?? '',
      )?.[1];
      if (url && new URL(url).origin !== new URL(api).origin)
        throw new Error(
          `GitHub's next page for ${label} is on another host; not followed, so the token stays on GitHub.`,
        );
    }
    return all;
  };
  const comments = (issue) =>
    allPages(
      `/repos/${repo}/issues/${issue}/comments?per_page=${GITHUB_PAGE_SIZE}`,
      `#${issue}`,
    );
  const reviews = (number) =>
    allPages(
      `/repos/${repo}/pulls/${number}/reviews?per_page=${GITHUB_PAGE_SIZE}`,
      `#${number}`,
    );
  /** Pull requests updated since `cutoff`, newest first, from at most a few pages. */
  const updatedPullRequests = async (cutoff) => {
    const found = [];
    for (let page = 1; page <= PULL_PAGES; page += 1) {
      const pulls = await (
        await request(
          `${api}/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${GITHUB_PAGE_SIZE}&page=${page}`,
          { headers },
        )
      ).json();
      const recent = pulls.filter(
        ({ updated_at }) => Date.parse(updated_at) >= cutoff,
      );
      found.push(...recent);
      if (recent.length < pulls.length || pulls.length < GITHUB_PAGE_SIZE)
        break;
    }
    return found;
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
  const getJson = async (path) =>
    (await request(`${api}${path}`, { headers })).json();
  /**
   * When this workflow last made a full pass on this branch: the newest successful run whose job ran,
   * not one the `if:` skipped. Null on the first run; throws when that cannot be told.
   */
  const lastSuccessfulRunStart = async (now) => {
    const ref = WORKFLOW_ON_BRANCH.exec(process.env.GITHUB_WORKFLOW_REF ?? '');
    if (!ref)
      throw new Error(
        'GITHUB_WORKFLOW_REF does not name a workflow on a branch.',
      );
    const [, file, branch] = ref;
    let sawRun = false;
    for (let page = 1; page <= RUN_PAGES; page += 1) {
      const { workflow_runs: runs = [] } = await getJson(
        `/repos/${repo}/actions/workflows/${encodeURIComponent(file)}/runs?status=success&branch=${encodeURIComponent(branch)}&exclude_pull_requests=true&per_page=${RUNS_PER_PAGE}&page=${page}`,
      );
      for (const run of runs) {
        sawRun = true;
        const { jobs = [] } = await getJson(
          `/repos/${repo}/actions/runs/${run.id}/jobs`,
        );
        if (!jobs.some(({ conclusion }) => conclusion === 'success')) continue;
        const started = Date.parse(run.run_started_at ?? '');
        if (!Number.isFinite(started) || started > now)
          throw new Error(`run ${run.id} has no start time in the past.`);
        return started;
      }
      if (runs.length < RUNS_PER_PAGE) break;
    }
    if (sawRun)
      throw new Error(
        `none of the newest ${RUN_PAGES * RUNS_PER_PAGE} successful runs ran its job.`,
      );
    return null;
  };
  return {
    api,
    comments,
    reviews,
    updatedPullRequests,
    issue,
    comment,
    lastSuccessfulRunStart,
  };
};

/** Whether the API user already copied the GitHub item at `url` into these posts, in either link format. */
const alreadyOnForum = (posts, url, apiUsername) => {
  const footers = [viewOnGithub(url), url].map((link) => `\n\n${link}`);
  return posts.some(
    ({ username, raw }) =>
      username?.toLowerCase() === apiUsername.toLowerCase() &&
      isGithubMirror(raw) &&
      footers.some((footer) => (raw ?? '').trimEnd().endsWith(footer)),
  );
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
  const { get, post } = forum();
  const { posts } = await topicPosts(get, topicId);
  if (
    alreadyOnForum(posts, comment.html_url, required('DISCOURSE_API_USERNAME'))
  )
    return console.log(`Comment ${comment.id} is already in topic ${topicId}.`);
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
      'topics: read_lists',
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

/* Past the deadline, a 429 from either side, or another GitHub rate limit: every later topic would fail too, and calling on risks a ban. */
const stopsTheRun = (error, githubApi) =>
  error.deadline === true ||
  error.status === HTTP_TOO_MANY ||
  (error.rateLimited === true &&
    error.url !== undefined &&
    new URL(error.url).origin === new URL(githubApi).origin);

/** The oldest bump worth reading: since the last full pass, less a margin, within the lookback window and never later than now less the margin. */
export const activityCutoff = (now, lastSuccessfulRunStart) =>
  Math.min(
    now - LAST_RUN_MARGIN_MS,
    Math.max(
      now - LOOKBACK_HOURS * MS_PER_HOUR,
      lastSuccessfulRunStart === null
        ? -Infinity
        : lastSuccessfulRunStart - LAST_RUN_MARGIN_MS,
    ),
  );

const toGithub = async () => {
  const categoryId = parseCategoryId(required('DISCOURSE_CATEGORY_ID'));
  const apiUsername = required('DISCOURSE_API_USERNAME');
  const { base, get, post } = forum({ readGapMs: forumReadGapMs() });
  const gh = github();
  const now = Date.now();
  const lastRun = await gh.lastSuccessfulRunStart(now).catch((error) => {
    console.log(
      `::warning::Could not read the last successful run, so this run reads ${LOOKBACK_HOURS} hours of topics: ${describe(error)}`,
    );
    return null;
  });
  const cutoff = activityCutoff(now, lastRun);
  let lastCommentAt = 0;
  /* Forum first: a topic with no reply from a person costs no GitHub request (1,000 an hour per repository). */
  const syncTopic = async (listed, target) => {
    const { topic, posts } = await topicPosts(get, listed.id);
    const candidates = posts
      .filter((post) => shouldMirrorPost(post, apiUsername, new Set()))
      .sort((a, b) => a.post_number - b.post_number);
    if (!candidates.length) return 0;
    const { number } = target;
    /* GitHub answers 410 for a deleted issue and 404 for one it hides; neither has anything to sync to. */
    const issue = await gh.issue(number).catch((error) => {
      if (error.status === HTTP_NOT_FOUND || error.status === HTTP_GONE)
        return null;
      throw error;
    });
    if (!issue || Boolean(issue.pull_request) !== target.pullRequest) return 0;
    const comments = await gh.comments(number);
    if (topicIdFromComments(comments) !== listed.id) return 0;
    const done = mirroredPostIds(comments);
    let copied = 0;
    for (const post of candidates.filter(({ id }) => !done.has(id))) {
      const url = `${base}/t/${topic.slug}/${topic.id}/${post.post_number}`;
      const gap = GITHUB_WRITE_GAP_MS - (Date.now() - lastCommentAt);
      if (gap > 0) await wait(gap);
      await gh.comment(number, githubCommentBody(post, url));
      lastCommentAt = Date.now();
      copied += 1;
    }
    return copied;
  };
  /* Review summaries go to the forum from this scheduled run, because a review event from a fork has no secrets. */
  const syncReviews = async (pullRequest) => {
    const reviews = (await gh.reviews(pullRequest.number))
      .filter((review) => shouldCopyReview(review, cutoff))
      .sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at));
    if (!reviews.length) return 0;
    const topicId = topicIdFromComments(await gh.comments(pullRequest.number));
    if (!topicId) return 0;
    const { posts } = await topicPosts(get, topicId);
    let posted = 0;
    for (const review of reviews) {
      if (alreadyOnForum(posts, review.html_url, apiUsername)) continue;
      await post(
        '/posts.json',
        { topic_id: topicId, raw: reviewReplyBody(review) },
        'topics: write',
      );
      posted += 1;
    }
    return posted;
  };
  let copied = 0;
  let reviewsCopied = 0;
  let failed = 0;
  let stopped = false;
  const listed = await recentTopics(get, categoryId, cutoff);
  for (const [index, topic] of listed.entries()) {
    const target = topicTarget(topic.title);
    if (!target || topic.category_id !== categoryId) continue;
    try {
      copied += await syncTopic(topic, target);
    } catch (error) {
      failed += 1;
      console.error(
        `::error::Could not sync topic ${topic.id}: ${describe(error)}`,
      );
      if (stopsTheRun(error, gh.api)) {
        const left = listed.length - index - 1;
        console.error(
          `::error::Stopped before ${left} more ${left === 1 ? 'topic' : 'topics'}; the next run tries again.`,
        );
        stopped = true;
        break;
      }
    }
  }
  if (!stopped) {
    const pullRequests = await gh.updatedPullRequests(cutoff);
    for (const pullRequest of pullRequests) {
      try {
        reviewsCopied += await syncReviews(pullRequest);
      } catch (error) {
        failed += 1;
        console.error(
          `::error::Could not copy the reviews of #${pullRequest.number}: ${describe(error)}`,
        );
        if (stopsTheRun(error, gh.api)) break;
      }
    }
  }
  console.log(
    `Copied ${copied} forum ${copied === 1 ? 'reply' : 'replies'} to GitHub and ${reviewsCopied} ${reviewsCopied === 1 ? 'review' : 'reviews'} to the forum.`,
  );
  if (failed)
    throw new Error(
      `${failed} ${failed === 1 ? 'topic or pull request' : 'topics or pull requests'} could not sync.`,
    );
};

const openTopic = async () => {
  const event = JSON.parse(readFileSync(required('GITHUB_EVENT_PATH'), 'utf8'));
  const item = event.pull_request ?? event.issue;
  const pullRequest = Boolean(event.pull_request);
  if (!item)
    throw new Error('Expected an issues or pull_request_target event.');
  if (!shouldOpenTopic(item))
    return console.log('A draft or a bot issue or pull request; skipped.');
  const gh = github();
  if (topicIdFromComments(await gh.comments(item.number)))
    return console.log(`#${item.number} already has a forum topic.`);
  const { base, get, post } = forum();
  const externalId = topicExternalId(
    required('GITHUB_REPOSITORY'),
    item.number,
    pullRequest,
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
        ...newTopic(item, pullRequest),
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
  const prefix = pullRequest ? PR_LINK_COMMENT_PREFIX : LINK_COMMENT_PREFIX;
  await gh.comment(item.number, `${prefix}${url}`);
  console.log(
    `#${item.number} ${existing ? 'linked existing' : 'opened'} topic ${topicId}.`,
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

/** The id of the reply an earlier run of this event posted as the API user; its event time makes the text unique. */
export const earlierReplyId = (posts, reply, apiUsername) =>
  posts.find(
    (post) =>
      post.username?.toLowerCase() === apiUsername.toLowerCase() &&
      (post.raw ?? '').trim() === reply.trim(),
  )?.id ?? null;

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
      replyId = earlierReplyId(
        posts,
        change.reply,
        required('DISCOURSE_API_USERNAME'),
      );
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

/* SYNC_FORUM_GAP_MS overrides FORUM_READ_GAP_MS, for a shorter one in tests. */
const forumReadGapMs = () => {
  const override = process.env.SYNC_FORUM_GAP_MS;
  if (override === undefined) return FORUM_READ_GAP_MS;
  if (!/^\d+$/.test(override) || Number(override) > MAX_FORUM_GAP_MS)
    throw new Error(
      `Set SYNC_FORUM_GAP_MS to a whole number of milliseconds up to ${MAX_FORUM_GAP_MS}, not "${override}".`,
    );
  return Number(override);
};

/* SYNC_DEADLINE_MS overrides the mode's deadline, for a shorter one in tests. */
const deadlineMs = (mode) => {
  const override = process.env.SYNC_DEADLINE_MS;
  if (override === undefined) return RUN_DEADLINE_MS[mode];
  if (!/^[1-9]\d*$/.test(override))
    throw new Error(
      `Set SYNC_DEADLINE_MS to a whole number of milliseconds, not "${override}".`,
    );
  return Number(override);
};

const main = async () => {
  const mode = process.argv[2];
  forumConfig();
  if (Object.hasOwn(RUN_DEADLINE_MS, mode)) {
    const ms = deadlineMs(mode);
    runDeadline = { signal: AbortSignal.timeout(ms), ms };
  }
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
    console.error(`::error::${describe(error)}`);
    process.exit(1);
  });
}
