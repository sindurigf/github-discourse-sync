import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { load } from 'js-yaml';
import {
  RUN_DEADLINE_MS,
  SETUP_MARGIN_MS,
} from '../scripts/discourse-sync.mjs';

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
};
type Job = { if?: string; 'timeout-minutes'?: number; steps?: Step[] };
type Workflow = {
  on?: unknown;
  concurrency?: { group?: string; queue?: string };
  jobs?: Record<string, Job>;
};

const DIR = '.github/workflows';
const workflows = readdirSync(DIR)
  .filter((name) => name.endsWith('.yml'))
  .map((name) => ({
    name,
    workflow: load(readFileSync(`${DIR}/${name}`, 'utf8')) as Workflow,
  }));
const forumWorkflows = workflows.filter(({ name }) => name !== 'ci.yml');
const jobs = (workflow: Workflow) => Object.values(workflow.jobs ?? {});
const steps = (workflow: Workflow) =>
  jobs(workflow).flatMap((job) => job.steps ?? []);
const onPullRequestTarget = workflows.filter(({ workflow }) =>
  JSON.stringify(workflow.on ?? {}).includes('pull_request_target'),
);

/* Security: pull_request_target checkouts, pinned actions, no expressions in scripts, no kept tokens; function: opt-in jobs, per-issue queues, bot filters; build correctness: deadlines below timeouts. */
describe('workflows', () => {
  test('there is a pull_request_target workflow to check', () => {
    assert.ok(onPullRequestTarget.length > 0);
  });

  for (const { name, workflow } of onPullRequestTarget) {
    test(`${name} checks out only the default branch of this repository`, () => {
      for (const step of steps(workflow).filter(({ uses }) =>
        uses?.startsWith('actions/checkout@'),
      )) {
        assert.ok(
          [undefined, '${{ github.event.repository.default_branch }}'].includes(
            step.with?.['ref'],
          ),
          `checks out ${step.with?.['ref']}`,
        );
        assert.equal(step.with?.['repository'], undefined);
      }
    });

    test(`${name} has no step that fetches the pull request`, () => {
      for (const step of steps(workflow))
        assert.doesNotMatch(
          step.run ?? '',
          /gh pr checkout|refs\/pull\/|pull\/[^/\s]+\/(?:head|merge)|head\.(?:ref|sha)/,
          `step "${step.name}" fetches the pull request`,
        );
    });
  }

  for (const { name, workflow } of workflows) {
    test(`${name} pins every action to a full commit SHA`, () => {
      for (const { uses } of steps(workflow).filter(({ uses }) => uses))
        assert.match(uses!, /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/);
    });

    test(`${name} never puts a \${{ }} expression inside a shell script`, () => {
      for (const step of steps(workflow))
        assert.doesNotMatch(
          step.run ?? '',
          /\$\{\{/,
          `step "${step.name}" interpolates an expression`,
        );
    });

    test(`${name} checks out without keeping the token`, () => {
      for (const step of steps(workflow).filter(({ uses }) =>
        uses?.startsWith('actions/checkout@'),
      ))
        assert.equal(String(step.with?.['persist-credentials']), 'false');
    });
  }

  for (const { name, workflow } of forumWorkflows) {
    test(`${name} skips every job until the forum variables are set`, () => {
      for (const job of jobs(workflow)) {
        assert.match(job.if ?? '', /vars\.DISCOURSE_URL != ''/);
        assert.match(job.if ?? '', /vars\.DISCOURSE_CATEGORY_ID != ''/);
      }
    });
  }

  /* Function: GitHub cancels all but the newest pending run in a group unless queue is max. */
  for (const name of [
    'issue-to-discourse.yml',
    'pr-to-discourse.yml',
    'discourse-comment-to-topic.yml',
    'discourse-state.yml',
  ]) {
    test(`${name} queues its runs per issue without dropping one`, () => {
      const { concurrency } = workflows.find((w) => w.name === name)!.workflow;
      assert.equal(
        concurrency?.group,
        'discourse-${{ github.event.issue.number || github.event.pull_request.number }}',
      );
      assert.equal(concurrency?.queue, 'max');
    });
  }

  test('discourse-comment-to-topic.yml skips comments from bots', () => {
    const { workflow } = workflows.find(
      ({ name }) => name === 'discourse-comment-to-topic.yml',
    )!;
    for (const job of jobs(workflow))
      assert.match(job.if ?? '', /github\.event\.comment\.user\.type != 'Bot'/);
  });

  /* Build correctness: a hanging API must fail the run with an error before GitHub cancels the job. */
  test('every mode stops at its run deadline before its job times out', () => {
    const modes = new Set<string>();
    for (const { name, workflow } of workflows)
      for (const job of jobs(workflow)) {
        const mode = (job.steps ?? [])
          .map(
            (step) =>
              /node scripts\/discourse-sync\.mjs (\S+)/.exec(
                step.run ?? '',
              )?.[1],
          )
          .find(Boolean);
        if (!mode) continue;
        modes.add(mode);
        const deadline = (RUN_DEADLINE_MS as Record<string, number>)[mode];
        assert.ok(deadline, `${name} runs ${mode}, which has no deadline`);
        assert.ok(
          deadline + SETUP_MARGIN_MS <= (job['timeout-minutes'] ?? 0) * 60_000,
          `${name} can time out before ${mode} reaches its deadline`,
        );
      }
    assert.deepEqual([...modes].sort(), [
      'open-topic',
      'state',
      'to-forum',
      'to-github',
    ]);
  });

  /* Security: a job holds only the permissions it names, each with its reason. */
  for (const { name, workflow } of workflows)
    test(`${name} grants no permissions at workflow level and gives each job a reason for each`, () => {
      assert.deepEqual((workflow as { permissions?: unknown }).permissions, {});
      const text = readFileSync(`${DIR}/${name}`, 'utf8');
      for (const line of text.match(/^ {6}[a-z-]+: (?:read|write).*$/gm) ?? [])
        assert.match(line, / # \S/, `${line.trim()} has no reason`);
      for (const job of jobs(workflow))
        assert.ok(
          (job as { permissions?: object }).permissions,
          'a job has no permissions block',
        );
    });
});
