# gitlab-panel

A Claude Code mod: **your own open GitLab merge requests, live, in a pane beside the chat**, across the projects you choose. Each MR shows its head pipeline, merge status (ready, conflicts, needs approval, threads open, needs rebase…), comment count and age. Open it, copy its link or branch, or post a comment from the pane. Claude can read the same list through an `mrs` tool.

It talks to GitLab through the [`glab`](https://gitlab.com/gitlab-org/cli) CLI you are already signed in with: no token to configure, no server.

## Install

At the prompt of a terminal session:

```
/plugin install gitlab-panel --marketplace rndbblnn/cc-mod-gitlab
```

From a shell:

```
claude plugin install gitlab-panel --marketplace rndbblnn/cc-mod-gitlab
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `rndbblnn/cc-mod-gitlab`, then Add plugin.

The repository is private for now: installing needs read access on GitHub and a git credential for github.com on your machine.

Requires `glab` on the `PATH` and signed in (`glab auth status`).

## Configure

In `/config` (or `pluginConfigs["gitlab-panel"].options` in `~/.claude/settings.json`):

| Option | Default | |
| --- | --- | --- |
| `projects` | empty (all) | Comma-separated. A full path (`group/sub/name`) matches exactly; a bare name matches the last path segment. Order here is the order in the pane. |
| `host` | `gitlab.com` | Passed to `glab api --hostname`. |
| `glab` | `glab` | Path to the CLI. |
| `refreshSeconds` | `60` | Polling interval; `0` turns polling off. |
| `instructClaude` | `true` | Adds a short, stable note to the `mrs` tool's description (no `prompt.compose`: `cc-plugin-sec-default` skips it on Team/Enterprise orgs). |

Example:

```json
"pluginConfigs": {
  "gitlab-panel": { "options": { "projects": "midas-backend, midas-orchestrator, midas-app, midas-sync" } }
}
```

## Use

- `/gitlab` shows or hides the pane; `/gitlab refresh`; `/gitlab midas-app!1507` (or an MR URL) opens one MR.
- In the pane: pick a row for its detail; `r` refresh, `o` open, `y` copy link, `g` copy branch, `c` comment, `b` back.
- The status line reads `⇄ 4 MRs ∙ 1 ⊗ ∙ 1 conflict ∙ 2 ready`; pipeline and merge changes between reads arrive as toasts.
- When Claude runs `git push` or `glab mr …`, the pane re-reads 15 s later.

## How it works

One `GET /merge_requests?scope=created_by_me&state=opened` per refresh (paged), filtered to the watched projects, then one `GET /projects/:id/merge_requests/:iid` per MR for its head pipeline and a fresh merge status (capped at 50, four at a time). Comments go through `POST …/notes`.

## Develop

```
claude plugin validate . && claude plugin test .
```

Load from a working copy with `claude --plugin-dir <folder>` or `CLAUDE_CODE_PLUGIN_DIRS`.

## License

MIT
