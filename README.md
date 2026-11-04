# GitHub Discourse Sync

GitHub Actions workflows that link a repository's issues and pull requests to
topics on a Discourse forum, and copy comments and replies between them.

The issues of this repository are a live demo: each new issue opens a topic on
the forum this repository is connected to.

## What It Syncs

GitHub to Discourse:

| GitHub event                                                      | Forum result                                             | Workflow                         |
| ----------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------- |
| Issue opened                                                      | New topic; the issue gets a comment with its link        | `issue-to-discourse.yml`         |
| Pull request opened, reopened or ready for review                 | New topic; the pull request gets a comment with its link | `pr-to-discourse.yml`            |
| Comment on an issue or pull request conversation                  | Reply in the topic                                       | `discourse-comment-to-topic.yml` |
| Issue closed or reopened, pull request closed, merged or reopened | Reply in the topic, then the topic closes or reopens     | `discourse-state.yml`            |

Discourse to GitHub:

| Forum event             | GitHub result                        | Workflow                       |
| ----------------------- | ------------------------------------ | ------------------------------ |
| Reply in a linked topic | Comment on its issue or pull request | `discourse-topic-to-issue.yml` |

- Each topic has the `external_id` `github-issue-<n>` or `github-pr-<n>`. A
  re-run links the existing topic instead of opening a second one.
- Pull request topics skip drafts until they are ready for review, and skip
  pull requests opened by bots.
- On a completed issue or merged pull request, `discourse-state.yml` marks its
  close or merge reply as the solution, unless a person already chose one. A
  reopen unaccepts only close or merge replies.
- `discourse-topic-to-issue.yml` runs every 15 minutes and copies replies from
  topics active in the last 48 hours. Discourse cannot call GitHub, so it
  polls.
- Every run for one issue or pull request waits in one queue
  (`concurrency.queue: max`), so a topic exists before its comments, close or
  reopen are posted.

## Use It

- New repository: **Use this template** on GitHub.
- Existing repository: copy the five workflows in the tables above,
  `scripts/discourse-sync.mjs` and `.nvmrc` to the same paths. The script uses Node built-ins only; it needs no `npm install`.
- Without the `DISCOURSE_URL` and `DISCOURSE_CATEGORY_ID` variables, every job
  is skipped, so a fork or copy stays quiet until it is set up.

## Setup

### Discourse

1. Create a user for the sync, for example `github-bot`. It posts every topic
   and reply.
2. Give it rights to close and reopen topics: staff, trust level 4, or
   moderator of the category. Without them, replies still post and the close
   or reopen fails with the missing right named.
3. Turn on Solved for the category, so a reply can be marked as the solution:
   the Support category type, the site setting `allow_solved_on_all_topics`, or
   in older versions the category setting "Allow topic owner and staff to mark
   a reply as the solution". Without it, topics still close.
4. At `/admin/api/keys`, create a granular key for that single
   user with these scopes:
   - `topics`: `write`, `read`, `read_lists`, `status`
   - `solved`: `answer`

   A missing scope fails the job with the scope's name.

5. Note the category's ID: the number in the category URL, such as `5` in
   `https://forum.example.com/c/github/5`.

### GitHub

In **Settings > Secrets and variables > Actions**:

| Name                     | Kind     | Value                                               |
| ------------------------ | -------- | --------------------------------------------------- |
| `DISCOURSE_URL`          | Variable | Forum base URL, such as `https://forum.example.com` |
| `DISCOURSE_CATEGORY_ID`  | Variable | Category ID, such as `5`                            |
| `DISCOURSE_API_KEY`      | Secret   | The granular API key                                |
| `DISCOURSE_API_USERNAME` | Secret   | The sync user's username                            |

With the GitHub CLI:

```sh
gh variable set DISCOURSE_URL --body https://forum.example.com
gh variable set DISCOURSE_CATEGORY_ID --body 5
gh secret set DISCOURSE_API_KEY
gh secret set DISCOURSE_API_USERNAME
```

`gh secret set` prompts for the value, so it stays out of shell history.

## Limits and Privacy

- Anyone can open an issue, a pull request from a fork, or a comment on a
  public repository, so anyone can open a topic or post to the forum.
- Forum replies in `DISCOURSE_CATEGORY_ID` become public on GitHub, even on a
  forum that needs a login.
- Mirrored text breaks `@mentions` on both sides, so no one is notified.
- Edits and deletions are not mirrored.
- Review comments on code lines and review summary bodies
  (`pull_request_review`) are not mirrored.
- Changing `DISCOURSE_API_USERNAME` leaves the old user's replies in place;
  they are not copied to GitHub again. A reopen still unaccepts the old user's
  close or merge reply, and a re-run reuses it.
- GitHub turns the 15-minute schedule off after 60 days without repository
  activity. Turn it back on in the **Actions** tab.
- Runs for one issue or pull request queue up to GitHub's limit of 100 pending
  runs; a run beyond that is canceled and not retried.

## Security

- `pr-to-discourse.yml` and `discourse-state.yml` run on
  `pull_request_target`, so a pull request from a fork can reach the secrets.
  They check out the default branch only and never run the pull request's
  code. A test enforces this for every `pull_request_target` workflow.
- Issue and comment text reaches the script through the event file or
  environment variables, never through `${{ }}` in a shell script.
- Requests never follow a redirect to another host, so the API key is sent
  only to `DISCOURSE_URL`.
- Actions are pinned by commit SHA.

## Development

```sh
npm ci
npm run lint   # Prettier and TypeScript
npm test       # Playwright test runner, no browser
```

## License

[MIT](LICENSE)
