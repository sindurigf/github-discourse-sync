# GitHub Discourse Sync

These GitHub Actions workflows connect a repository to a Discourse forum. Each
issue and pull request gets its own forum topic, and comments travel both ways.

The issues here are a live demo. When you open one, a topic opens on the forum
this repository is connected to.

## What It Syncs

From GitHub to Discourse:

| On GitHub                                                         | On the Forum                                                                    | Workflow                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------- |
| Issue opened                                                      | New topic, and the issue gets a comment with its link                           | `issue-to-discourse.yml`         |
| Pull request opened, reopened or ready for review                 | New topic if it has none yet, and the pull request gets a comment with its link | `pr-to-discourse.yml`            |
| Comment on an issue or pull request conversation                  | Reply in the topic                                                              | `discourse-comment-to-topic.yml` |
| Issue closed or reopened, pull request closed, merged or reopened | Reply in the topic, then the topic closes or reopens                            | `discourse-state.yml`            |
| Pull request review: approved, changes requested or commented     | Reply in the topic with the review summary, within 15 minutes                   | `discourse-topic-to-issue.yml`   |

From Discourse to GitHub:

| On the Forum            | On GitHub                            | Workflow                       |
| ----------------------- | ------------------------------------ | ------------------------------ |
| Reply in a linked topic | Comment on its issue or pull request | `discourse-topic-to-issue.yml` |

How it behaves:

- Every forum post links back to GitHub with an inline "View on GitHub"
  link, not a bare URL, so Discourse shows no card repeating the GitHub text.
- Each topic has the `external_id` `gh-<key>-issue-<n>` or `gh-<key>-pr-<n>`.
  The key is the first 12 hex characters of the SHA-256 of `owner/name`, so
  repositories that share a forum get different IDs. A run that repeats links
  the existing topic instead of opening a second one.
- Draft pull requests wait until they are ready for review. Issues and pull
  requests opened by bots get no topic.
- When an issue is completed or a pull request is merged, its close or merge
  reply is marked as the solution, unless the topic already has an accepted
  answer. A reopen unaccepts only those close or merge replies.
- Discourse cannot call GitHub, so `discourse-topic-to-issue.yml` checks the
  forum every 15 minutes. It reads only topics bumped since its last
  successful run on the same branch started, less 15 minutes, and never more
  than the last 48 hours. On the first run, or when that run cannot be found,
  it reads 48 hours.
- All runs for one issue or pull request wait in a single queue
  (`concurrency.queue: max`), so the topic is normally there before its
  comments, close or reopen arrive. GitHub's workflow syntax docs say queued
  runs "are processed in first-in-first-out (FIFO) order according to the time
  each one started waiting on the concurrency group" and that "ordering is not
  guaranteed".

  [Workflow syntax: concurrency](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)

## Use It

For a new repository, select **Use this template** on GitHub.

For an existing repository, copy these files to the same paths:

- the five workflows named in the tables above
- `scripts/discourse-sync.mjs`
- `.nvmrc`, if your repository does not have one yet

The script uses only Node built-ins, so it needs no `npm install`. In a copy
made with the template, also remove the issue form and the live demo note at
the top of this file.

Until the `DISCOURSE_URL` and `DISCOURSE_CATEGORY_ID` variables are set, every
sync job is skipped, so a fork or copy posts nothing. CI still runs.

## Setup

### Discourse

1. Create a user for the sync, for example `github-bot`. This user posts every
   topic and reply.
2. Let it close and reopen topics. It needs to be staff, trust level 4 or a
   moderator of the category. Without these rights, the close or reopen fails
   with an error that names them. A close still posts its reply first, but a
   reopen posts nothing.
   Staff is the best choice: most Discourse rate limits, such as the wait
   between new topics, do not apply to staff.
3. Turn on Solved for the category so a reply can be marked as the solution.
   Any of these works: the Support category type, the site setting
   `allow_solved_on_all_topics` or, in older versions, the category setting
   "Allow topic owner and staff to mark a reply as the solution". Without
   Solved, topics still close.
4. At `/admin/api/keys`, create a granular key for that single user with these
   scopes:
   - `topics`: `write`, `read`, `read_lists`, `status`
   - `solved`: `answer`

   If a scope is missing, the job fails with an error that names the scope it
   needs.

5. Find the category ID. It is the number at the end of the category URL, such
   as `5` in `https://forum.example.com/c/github/5`.

The sync user opens each topic, so it can mark a solution while the topic is
open.

### GitHub

In **Settings > Secrets and variables > Actions**, add:

| Name                     | Kind     | Value                                                          |
| ------------------------ | -------- | -------------------------------------------------------------- |
| `DISCOURSE_URL`          | Variable | Forum base URL over https, such as `https://forum.example.com` |
| `DISCOURSE_CATEGORY_ID`  | Variable | Category ID, such as `5`                                       |
| `DISCOURSE_API_KEY`      | Secret   | The granular API key                                           |
| `DISCOURSE_API_USERNAME` | Secret   | The sync user's username                                       |

Or with the GitHub CLI:

```sh
gh variable set DISCOURSE_URL --body https://forum.example.com
gh variable set DISCOURSE_CATEGORY_ID --body 5
gh secret set DISCOURSE_API_KEY
gh secret set DISCOURSE_API_USERNAME
```

`DISCOURSE_URL` must use https. Plain http works only for a forum on the same
machine (`localhost`, `127.0.0.1` or `::1`), which the tests use.
The sync user needs a username in plain ASCII, without spaces, because HTTP
headers carry it.

`gh secret set` asks for the value, so it stays out of your shell history.

## Limits and Privacy

- Anyone can open an issue, a pull request from a fork or a comment on a
  public repository. That means anyone can open a topic or post to the forum.
- Forum replies in the synced category become public on GitHub, even when the
  forum needs a login.
- Copied text, in both directions, is changed so these forms do not notify
  anyone or link an issue:
  - `@name`: a zero-width space after every `@`
  - `#1`, `owner/repo#1`: a zero-width space after every `#` before a digit
  - `GH-1`: a zero-width space after `GH-` before a digit, in any case
  - `issues/1`, `pull/1`, `pulls/1`, `discussions/1`: a zero-width space
    after the slash
  - `github.com`: every occurrence, in any case, becomes
    `redirect.github.com`, so `api.github.com` becomes
    `api.redirect.github.com`. GitHub documents that a `redirect.github.com`
    link adds no backlink:

    [Autolinked references and URLs](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls)

  - `[quote="name"]` and `username:name`: a zero-width space after `[quote`
    and before the colon in `username:`
  - `discourse-post:`: a zero-width space before the colon, so copied text
    cannot pose as a copy marker
  - HTML entities such as `&#64;`: the `&` becomes `&amp;`
- Forms not in this list are copied as written. A forum link in a GitHub
  comment stays a link on the forum, and Discourse may notify the author of
  the linked post.
- The forum username at the top of a reply copied to GitHub gets the same
  changes.
- A backslash escape such as `github\.com`, `GH\-1` or `issues\/1` gets the
  same change as the unescaped form.
- These changes apply everywhere in the text, including email addresses,
  links and code. A copied email address, a link with `@`, a `#` and a number
  or an issue path, or a command with any of them needs editing before use.
- Edits and deletions are not copied.
- Re-running a close or reopen event from before forum posts linked back
  inline posts its reply again, because the reply text changed.
- Review summaries are copied by the 15-minute schedule, so they reach the
  forum up to 15 minutes later. An approval without a summary posts one line.
  Review comments on code lines are not copied, and neither is a Commented
  review that holds only those. A review dismissed after it was copied stays
  on the forum. A review on a closed or merged pull request is copied into
  its closed topic. Only the 300 pull requests updated most recently since the
  cutoff are read for reviews; a run with more prints a warning.
- Comments made before a pull request has its topic, such as while it is a
  first draft, are not copied.
- Text that would make a forum post longer than 32,000 characters is
  shortened, with a note that the full text is on GitHub. A forum reply longer
  than a GitHub comment, 65,536 characters, is shortened with a note that the
  full text is on the forum.
- A topic syncs only while its title starts with `GitHub issue #<n>:` or
  `GitHub pull request #<n>:` and it stays in the synced category. Retitling
  or moving it stops forum replies from reaching GitHub.
- If you change `DISCOURSE_API_USERNAME`, the old user's replies stay where
  they are and are not copied to GitHub again. A reopen still unaccepts the old
  user's close or merge reply. A repeated run reuses only a reply the current
  user posted, so a re-run after the change posts its reply again.
- In a public repository, GitHub turns off the 15-minute schedule after 60
  days without repository activity. You can turn it back on in the **Actions**
  tab. Each run reads only topics active in the last 48 hours, so a reply
  posted while the schedule was off for longer is copied once its topic is
  active again.
- One issue or pull request can have up to 100 runs waiting, which is GitHub's
  limit. A run beyond that is canceled and not retried.
- Discourse allows 60 admin API requests a minute for the whole site by
  default, shared by every key and staff included
  (`DISCOURSE_MAX_ADMIN_API_REQS_PER_MINUTE`). `discourse-topic-to-issue.yml`
  waits 1.5 seconds between forum requests, about 40 a minute, to leave room
  for the other workflows. A forum request that hits the limit waits up to a
  minute, as Discourse asks, within the run's time limit; a run that still
  cannot finish fails and its event can be run again.
- The other workflows are not paced. A bulk action, such as closing 30 issues
  at once, starts that many runs in parallel and can pass the forum's limit,
  so some of them may fail and need a re-run.
- Each topic read costs about 3.3 seconds with this pacing, and each copied
  reply or review adds time, so one run of `discourse-topic-to-issue.yml`
  handles up to about 150 topics bumped and pull requests with new reviews
  since the last successful run. With more, runs
  fail at their time limit and read the same topics again until activity
  drops; replies older than 48 hours by then are not copied.
- The cutoff moves only after a run on the same branch whose job ran and
  succeeded. One topic or pull request that keeps failing makes every run
  fail, so the cutoff stops moving and reads widen to 48 hours until it is
  fixed.
- After a long pause, such as a forum outage, the backlog of replies can take
  several runs to copy, and those runs may fail until it catches up. Each run
  copies only replies not yet on GitHub, so none is copied twice.

## Security

- `pr-to-discourse.yml` and `discourse-state.yml` run on
  `pull_request_target`, so a pull request from a fork can reach the secrets.
  They check out only the default branch and never run the pull request's
  code. Tests check every `pull_request_target` workflow for a checkout of
  another ref and for a step that fetches the pull request.
- Issue, pull request and comment text reaches the script through the event
  file, never through `${{ }}` inside a shell script.
- Review summaries are read through the API by the scheduled workflow. A
  `pull_request_review` event from a fork runs without secrets and with a
  read-only token, and `workflow_run` would add another trigger that runs with
  secrets, so neither is used.
- Requests do not follow a redirect to another host, so the API key goes only
  to `DISCOURSE_URL`.
- Every action is pinned to a commit SHA. A test checks this and the rule
  above about `${{ }}`.

## Development

```sh
npm ci
npm run lint   # Prettier, and TypeScript over the tests
npm test       # Node's built-in test runner
```

## License

MIT license:

[LICENSE](LICENSE)

AI disclosure:

[AI_DISCLOSURE.md](AI_DISCLOSURE.md)
