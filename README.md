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

From Discourse to GitHub:

| On the Forum            | On GitHub                            | Workflow                       |
| ----------------------- | ------------------------------------ | ------------------------------ |
| Reply in a linked topic | Comment on its issue or pull request | `discourse-topic-to-issue.yml` |

How it behaves:

- Each topic has the `external_id` `gh-<key>-issue-<n>` or `gh-<key>-pr-<n>`.
  The key is the first 12 hex characters of the SHA-256 of `owner/name`, so
  repositories that share a forum get different IDs. A run that repeats links
  the existing topic instead of opening a second one.
- Draft pull requests wait until they are ready for review. Pull requests
  opened by bots get no topic.
- When an issue is completed or a pull request is merged, its close or merge
  reply is marked as the solution, unless the topic already has an accepted
  answer. A reopen unaccepts only those close or merge replies.
- Discourse cannot call GitHub, so `discourse-topic-to-issue.yml` checks the
  forum every 15 minutes. It copies replies from topics active in the last 48
  hours.
- All runs for one issue or pull request wait in a single queue
  (`concurrency.queue: max`), so the topic is normally there before its
  comments, close or reopen arrive. GitHub usually runs the queue in order but does
  not guarantee it.

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
job is skipped. A fork or copy stays quiet until you set it up.

## Setup

### Discourse

1. Create a user for the sync, for example `github-bot`. This user posts every
   topic and reply.
2. Let it close and reopen topics. It needs to be staff, trust level 4 or a
   moderator of the category. Without these rights, the close or reopen fails
   with an error that names them. A close still posts its reply first, but a
   reopen posts nothing.
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

| Name                     | Kind     | Value                                               |
| ------------------------ | -------- | --------------------------------------------------- |
| `DISCOURSE_URL`          | Variable | Forum base URL, such as `https://forum.example.com` |
| `DISCOURSE_CATEGORY_ID`  | Variable | Category ID, such as `5`                            |
| `DISCOURSE_API_KEY`      | Secret   | The granular API key                                |
| `DISCOURSE_API_USERNAME` | Secret   | The sync user's username                            |

Or with the GitHub CLI:

```sh
gh variable set DISCOURSE_URL --body https://forum.example.com
gh variable set DISCOURSE_CATEGORY_ID --body 5
gh secret set DISCOURSE_API_KEY
gh secret set DISCOURSE_API_USERNAME
```

`gh secret set` asks for the value, so it stays out of your shell history.

## Limits and Privacy

- Anyone can open an issue, a pull request from a fork or a comment on a
  public repository. That means anyone can open a topic or post to the forum.
- Forum replies in the synced category become public on GitHub, even when the
  forum needs a login.
- Copied text breaks `@mentions` on both sides, so nobody gets notified.
- Edits and deletions are not copied.
- Review comments on code lines and review summaries are not copied.
- Comments made before a pull request has its topic, such as while it is a
  first draft, are not copied.
- Text that would make a forum post longer than 32,000 characters is
  shortened, with a note that the full text is on GitHub.
- If you change `DISCOURSE_API_USERNAME`, the old user's replies stay where
  they are and are not copied to GitHub again. A reopen still unaccepts the old
  user's close or merge reply, and a repeated run reuses it.
- In a public repository, GitHub turns off the 15-minute schedule after 60
  days without repository activity. You can turn it back on in the **Actions**
  tab.
- One issue or pull request can have up to 100 runs waiting, which is GitHub's
  limit. A run beyond that is canceled and not retried.

## Security

- `pr-to-discourse.yml` and `discourse-state.yml` run on
  `pull_request_target`, so a pull request from a fork can reach the secrets.
  They check out only the default branch and never run the pull request's
  code. Tests check every `pull_request_target` workflow for a checkout of
  another ref and for a step that fetches the pull request.
- Issue and comment text reaches the script through the event file or
  environment variables, never through `${{ }}` inside a shell script.
- Requests do not follow a redirect to another host, so the API key goes only
  to `DISCOURSE_URL`.
- Every action is pinned to a commit SHA. A test checks this and the rule
  above about `${{ }}`.

## Development

```sh
npm ci
npm run lint   # Prettier, and TypeScript over the tests
npm test       # Playwright test runner, no browser
```

## License

MIT license:

[LICENSE](LICENSE)

AI disclosure:

[AI_DISCLOSURE.md](AI_DISCLOSURE.md)
