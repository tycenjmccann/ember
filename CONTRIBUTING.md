# Contributing to Ember

Thanks for wanting to help. Ember is MIT-licensed and contributions of all sizes are
welcome — bug reports, docs, and code.

## Ground rules

- Be kind. See the [Code of Conduct](CODE_OF_CONDUCT.md).
- For anything security-related, **do not open a public issue** — follow the
  [Security Policy](SECURITY.md).
- Open an issue before a large change so we can agree on the approach first.

## Project layout

| Path | What it is |
|------|------------|
| `src/` | Next.js web app + control-plane API (the "hub") |
| `mcp/port-session/` | The local MCP server (`port` / `pull` / `login` / `sync-config`) — TypeScript |
| `deploy/coding-agent-runtime/` | The cloud runtime that runs inside the AgentCore micro-VM — Python + Dockerfile |
| `deploy/apprunner/` | Web deploy (Docker → ECR → App Runner) |
| `install.sh` | Idempotent, end-to-end stand-up into your AWS account |

## Local development

```bash
git clone https://github.com/tycenjmccann/ember.git && cd ember
npm install

# Web app / API
npm run dev            # next dev

# The MCP server
npm run mcp:build      # installs + tsc-builds mcp/port-session
# or, iterating:
cd mcp/port-session && npm run dev   # tsc --watch
```

You'll need an AWS account and a profile with credentials (`export AWS_PROFILE=<profile>`)
to exercise the port/pull round trip. `./install.sh` stands up the backing resources.

## Before you open a PR

- **Build clean.** `npm run build` (web) and `npm run mcp:build` (MCP) must both succeed.
- **Match the surrounding code.** Same naming, comment density, and idioms as the file
  you're editing. Comments explain *why*, not *what*.
- **Keep changes focused.** One logical change per PR; split unrelated work.
- **Describe the change and how you tested it** in the PR body.

## Commit and PR conventions

- Conventional-commit-style prefixes are preferred: `feat(ember): …`, `fix(auth): …`,
  `docs: …`.
- Keep commits meaningful; squash noise before opening the PR.

## Adding a new coding CLI

Ember abstracts each agent behind a small adapter. If you're adding a CLI, the touch
points are: `mcp/port-session/src/cli-adapter.ts` (produce/consume the session bytes),
the runtime's `_run_<cli>` in `deploy/coding-agent-runtime/main.py`, and the `EmberCli`
type plus UI branding in `src/`. Open an issue first — happy to point you at the seams.

## License

By contributing you agree your contributions are licensed under the [MIT License](LICENSE).
