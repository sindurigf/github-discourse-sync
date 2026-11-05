import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

export const REPOSITORY = 'o/r';
export const CATEGORY_ID = 5;
export const API_USER = 'forum-bot';
/* Discourse API keys are SecureRandom.hex(32): 64 lowercase hex characters. */
export const API_KEY = 'a'.repeat(64);
export const BOT_LOGIN = 'github-actions[bot]';
export const MOVED_REPOSITORY_ID = 7;

export type Comment = {
  id: number;
  user: { login: string; type: string };
  body: string;
  html_url: string;
};
export type Issue = {
  number: number;
  pullRequest?: boolean;
  deleted?: boolean;
  transferred?: boolean;
  comments: Comment[];
};
export type Post = {
  id: number;
  post_number: number;
  post_type: number;
  username: string;
  raw: string;
  hidden?: boolean;
  accepted_answer?: boolean;
  can_accept_answer?: boolean;
};
export type Topic = {
  id: number;
  slug: string;
  title: string;
  category_id: number;
  bumped_at: string;
  pinned?: boolean;
  external_id?: string;
  closed?: boolean;
  posts: Post[];
};
export type Hit = { method: string; url: string; body: string; at: number };
export type Fault = {
  method?: string;
  path: string | RegExp;
  status: number | 'drop' | 'hang';
  times?: number;
  headers?: Record<string, string>;
  body?: unknown;
};

type Answer = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

/** Page sizes the fakes use, so paging tests can cross a page boundary with few items. */
export type Paging = { latestPerPage: number; commentsPerPage: number };

/**
 * One stateful fake of the GitHub REST and Discourse APIs on one origin. It keeps
 * issues, comments, topics and posts, answers the endpoints the script calls and
 * refuses anything else with 500, so an unexpected request fails its test.
 */
export const startFakeApis = async (
  paging: Paging = { latestPerPage: 30, commentsPerPage: 100 },
) => {
  const issues = new Map<number, Issue>();
  const topics: Topic[] = [];
  const hits: Hit[] = [];
  const faults: Fault[] = [];
  const settings = { solved: true };
  /* Newest first, as the Actions API lists them. */
  const successfulRuns: { run_started_at: string }[] = [];
  let nextId = 1000;
  let origin = '';

  const findTopic = (id: number) => topics.find((topic) => topic.id === id);
  const postById = (id: number) =>
    topics.flatMap((topic) => topic.posts).find((post) => post.id === id);
  const topicOfPost = (id: number) =>
    topics.find((topic) => topic.posts.some((post) => post.id === id));
  const latestFirst = () =>
    [...topics].sort(
      (a, b) =>
        Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
        Date.parse(b.bumped_at) - Date.parse(a.bumped_at),
    );

  const github = (
    method: string,
    path: string,
    query: URLSearchParams,
    body: string,
  ): Answer => {
    const moved = /^\/repositories\/\d+\/issues\/(\d+)(\/comments)?$/.exec(
      path,
    );
    if (moved && method === 'GET')
      return {
        status: 200,
        body: moved[2]
          ? []
          : {
              number: Number(moved[1]),
              repository_url: `${origin}/repos/o/elsewhere`,
            },
      };
    if (
      path === '/repos/o/r/actions/workflows/discourse-topic-to-issue.yml/runs'
    ) {
      if (query.get('status') !== 'success')
        return {
          status: 400,
          body: { message: 'only successful runs are faked' },
        };
      return {
        status: 200,
        body: { workflow_runs: successfulRuns.slice(0, 1) },
      };
    }
    const issueMatch = /^\/repos\/o\/r\/issues\/(\d+)(\/comments)?$/.exec(path);
    if (!issueMatch) return { status: 500, body: { unexpected: path } };
    const issue = issues.get(Number(issueMatch[1]));
    if (!issue) return { status: 404, body: { message: 'Not Found' } };
    if (issue.deleted)
      return { status: 410, body: { message: 'This issue was deleted' } };
    /* GitHub answers a transferred issue with a redirect to its new repository by id. */
    if (issue.transferred)
      return {
        status: 301,
        headers: {
          location: `${origin}/repositories/${MOVED_REPOSITORY_ID}${path.slice('/repos/o/r'.length)}`,
        },
      };
    if (!issueMatch[2]) {
      return {
        status: 200,
        body: {
          number: issue.number,
          repository_url: `${origin}/repos/${REPOSITORY}`,
          ...(issue.pullRequest ? { pull_request: {} } : {}),
        },
      };
    }
    if (method === 'POST') {
      const id = (nextId += 1);
      issue.comments.push({
        id,
        user: { login: BOT_LOGIN, type: 'Bot' },
        body: JSON.parse(body).body,
        html_url: `https://github.com/o/r/issues/${issue.number}#issuecomment-${id}`,
      });
      return { status: 201, body: { id } };
    }
    const page = Number(query.get('page') ?? '1');
    const size = paging.commentsPerPage;
    const slice = issue.comments.slice((page - 1) * size, page * size);
    const more = page * size < issue.comments.length;
    return {
      status: 200,
      body: slice,
      headers: more
        ? {
            link: `<${origin}${path}?per_page=${size}&page=${page + 1}>; rel="next"`,
          }
        : {},
    };
  };

  const topicJson = (topic: Topic) => ({
    id: topic.id,
    slug: topic.slug,
    post_stream: { stream: topic.posts.map((post) => post.id) },
  });

  const forum = (
    method: string,
    path: string,
    query: URLSearchParams,
    body: string,
  ): Answer => {
    const latest = /^\/c\/(\d+)\/l\/latest\.json$/.exec(path);
    if (latest && method === 'GET') {
      const page = Number(query.get('page') ?? '0');
      const all = latestFirst().filter(
        (topic) => topic.category_id === Number(latest[1]),
      );
      const size = paging.latestPerPage;
      const slice = all.slice(page * size, (page + 1) * size);
      return {
        status: 200,
        body: {
          topic_list: {
            topics: slice.map(({ posts, ...listed }) => listed),
            ...((page + 1) * size < all.length
              ? { more_topics_url: `/c/${latest[1]}/l/latest?page=${page + 1}` }
              : {}),
          },
        },
      };
    }
    const byExternal = /^\/t\/external_id\/([\w-]+)\.json$/.exec(path);
    if (byExternal) {
      const topic = topics.find((t) => t.external_id === byExternal[1]);
      return topic
        ? {
            status: 301,
            headers: { location: `/t/${topic.slug}/${topic.id}.json` },
          }
        : { status: 404, body: { errors: ['Not found'] } };
    }
    const topicPath = /^\/t\/(?:[\w-]+\/)?(\d+)\.json$/.exec(path);
    if (topicPath && method === 'GET') {
      const topic = findTopic(Number(topicPath[1]));
      return topic ? { status: 200, body: topicJson(topic) } : { status: 404 };
    }
    const postsPath = /^\/t\/(\d+)\/posts\.json$/.exec(path);
    if (postsPath && method === 'GET') {
      const ids = query.getAll('post_ids[]').map(Number);
      const topic = findTopic(Number(postsPath[1]));
      return {
        status: 200,
        body: {
          post_stream: {
            posts: (topic?.posts ?? [])
              .filter((post) => ids.includes(post.id))
              .map(({ raw, ...post }) =>
                query.get('include_raw') === 'true' ? { ...post, raw } : post,
              ),
          },
        },
      };
    }
    const statusPath = /^\/t\/(\d+)\/status\.json$/.exec(path);
    if (statusPath && method === 'PUT') {
      const topic = findTopic(Number(statusPath[1]));
      const { status, enabled } = JSON.parse(body);
      if (!topic || status !== 'closed') return { status: 400 };
      topic.closed = enabled;
      return { status: 200, body: { success: 'OK' } };
    }
    if (path === '/posts.json' && method === 'POST') {
      const data = JSON.parse(body);
      const post = (topic: Topic, raw: string): Post => {
        const created: Post = {
          id: (nextId += 1),
          post_number: topic.posts.length + 1,
          post_type: 1,
          username: API_USER,
          raw,
          can_accept_answer: settings.solved,
        };
        topic.posts.push(created);
        topic.bumped_at = new Date().toISOString();
        return created;
      };
      if (data.topic_id) {
        const topic = findTopic(data.topic_id);
        if (!topic) return { status: 404 };
        return { status: 200, body: { id: post(topic, data.raw).id } };
      }
      if (topics.some((topic) => topic.external_id === data.external_id))
        return {
          status: 422,
          body: { errors: ['External ID has already been taken'] },
        };
      const topic: Topic = {
        id: (nextId += 1),
        slug: 'topic',
        title: data.title,
        category_id: data.category,
        bumped_at: new Date().toISOString(),
        external_id: data.external_id,
        posts: [],
      };
      topics.push(topic);
      const first = post(topic, data.raw);
      return {
        status: 200,
        body: { id: first.id, topic_id: topic.id, topic_slug: topic.slug },
      };
    }
    const solution = /^\/solution\/(accept|unaccept)\.json$/.exec(path);
    if (solution && method === 'POST') {
      const target = postById(JSON.parse(body).id);
      if (!target) return { status: 404 };
      if (solution[1] === 'accept') {
        for (const other of topicOfPost(target.id)?.posts ?? [])
          other.accepted_answer = false;
      }
      target.accepted_answer = solution[1] === 'accept';
      return { status: 200, body: { success: 'OK' } };
    }
    return { status: 500, body: { unexpected: `${method} ${path}` } };
  };

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const method = req.method ?? '';
      const url = new URL(req.url ?? '/', origin);
      hits.push({
        method,
        url: `${url.pathname}${url.search}`,
        body,
        at: performance.now(),
      });
      const fault = faults.find(
        (f) =>
          (f.times ?? 1) > 0 &&
          (!f.method || f.method === method) &&
          (typeof f.path === 'string'
            ? f.path === url.pathname
            : f.path.test(url.pathname)),
      );
      if (fault) {
        fault.times = (fault.times ?? 1) - 1;
        if (fault.status === 'drop') return req.socket.destroy();
        if (fault.status === 'hang') return;
        res.writeHead(fault.status, {
          'content-type': 'application/json',
          ...fault.headers,
        });
        return res.end(JSON.stringify(fault.body ?? { errors: ['injected'] }));
      }
      const answer = /^\/(repos|repositories)\//.test(url.pathname)
        ? github(method, url.pathname, url.searchParams, body)
        : forum(method, url.pathname, url.searchParams, body);
      res.writeHead(answer.status, {
        'content-type': 'application/json',
        ...answer.headers,
      });
      res.end(JSON.stringify(answer.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    hits,
    issues,
    topics,
    /** Solved off for the category: no post can be accepted. */
    settings,
    successfulRuns,
    /** Answers the next `times` matching requests with `status` before the fake sees them. */
    fail: (fault: Fault) => faults.push(fault),
    addIssue: (issue: Omit<Issue, 'comments'> & { comments?: Comment[] }) => {
      const added = { comments: [], ...issue };
      issues.set(issue.number, added);
      return added;
    },
    addTopic: (
      topic: Omit<Topic, 'category_id' | 'bumped_at' | 'slug'> & Partial<Topic>,
    ) => {
      const added: Topic = {
        slug: 'topic',
        category_id: CATEGORY_ID,
        bumped_at: new Date().toISOString(),
        ...topic,
      };
      topics.push(added);
      return added;
    },
    writes: () => hits.filter(({ method }) => method !== 'GET'),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

export type FakeApis = Awaited<ReturnType<typeof startFakeApis>>;

export type Run = { code: number; stdout: string; stderr: string };

/** Runs scripts/discourse-sync.mjs in a child process, as a workflow step does. */
export const runMode = async (
  mode: string,
  fake: FakeApis,
  event: unknown = {},
  env: Record<string, string> = {},
): Promise<Run> => {
  const eventPath = join(
    mkdtempSync(join(tmpdir(), 'discourse-')),
    'event.json',
  );
  writeFileSync(eventPath, JSON.stringify(event));
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ['scripts/discourse-sync.mjs', mode],
      {
        env: {
          PATH: process.env['PATH'],
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_API_URL: fake.origin,
          GITHUB_REPOSITORY: REPOSITORY,
          GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/discourse-topic-to-issue.yml@refs/heads/main`,
          GITHUB_TOKEN: 'gh-token',
          SYNC_FORUM_GAP_MS: '0',
          DISCOURSE_URL: fake.origin,
          DISCOURSE_CATEGORY_ID: String(CATEGORY_ID),
          DISCOURSE_API_KEY: API_KEY,
          DISCOURSE_API_USERNAME: API_USER,
          ...env,
        },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as Run;
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
};
