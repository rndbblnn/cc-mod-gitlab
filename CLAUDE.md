# gitlab-panel — notes for Claude

A Claude Code **mod** (hooks module). Load the `plugin-authoring` skill before changing it. Sibling of
`cc-mod-linear`; same conventions.

## Layout
- `hooks/model.ts` — pure: GitLab REST parsing (`toMR`), project filter, fetch (`fetchMRs`, injected `Api`),
  ordering, diffs, labels, the prompt section and the `mrs` tool text. Unit-tested.
- `hooks/register.tsx` — `/gitlab` command, `mrs` tool, `prompt.compose` section, a `tool.call` watch on
  Bash (`git push` / `glab mr`) that schedules a re-read, 1 s clock (poll), `ui.render` Pane `gitlab`.
- `types/index.d.ts` — `$.state` contract. Change a value's fields → bump its `shape` tag.

## Gotchas
- GitLab is reached with `$.process.run(['glab', 'api', '--hostname', host, …, path])`, not an MCP server.
  `glab` must be signed in; its stderr's first line becomes the pane's error.
- The prompt section must stay stable (no MR statuses in it): it sits in the system prompt.
- The validator requires every function that takes `$` to be declared at module top level. Options live in
  the module-level `cfg`, set as `register` runs.
- A `Button`'s children may only be strings and `Text`, so a row is one line of padded text (`fit`).
- Type-check against `claude-code` + `claude-code-tools` only (`claude-code-mcp` can be huge).

## Check
`claude plugin validate . && claude plugin test .` (9 tests).
