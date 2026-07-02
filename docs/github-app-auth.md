# GitHub App auth — short-lived, scoped clone tokens

Status: **implementing** (feature `feat/github-app-auth`). Closes the "still open"
item in [ENTERPRISE.md](./ENTERPRISE.md) (§3): *short-lived, scoped GitHub tokens
(GitHub App installation tokens) instead of the single shared PAT.*

## The problem

Today the runtime clones private repos with a single **`GITHUB_PAT`** — a
long-lived Personal Access Token injected as a runtime env var at deploy time and
written into `~/.gitconfig` as `url.https://x-access-token:<PAT>@github.com/`.

That PAT is readable by any agent turn in the microVM (`echo $GITHUB_PAT`,
`cat ~/.gitconfig`) — which is a problem because the microVM runs **untrusted
tasks**. A malicious repo or prompt-injection can exfiltrate the operator's token,
and its blast radius is *every repo the PAT can touch, forever*.

Not a source/repo leak — the PAT is never in git, S3, or the API. It's a runtime
exposure, and the same exposure exists for every self-hoster.

## The fix, in one line

Replace the static PAT with **GitHub App installation tokens**: minted
server-side in the hub, short-lived (~1h), scoped to selected repos. The agent
only ever sees an expiring, narrow token — never the App's private key.

### Why this and not the alternatives

| Option | No re-auth? | No long-lived secret? | Blast radius |
|--------|:-----------:|:---------------------:|--------------|
| Shared PAT (today) | ✅ | ❌ | all repos, forever |
| Per-user PAT in Secrets Manager | ✅ | ❌ | all that PAT's repos, forever |
| **GitHub App installation token** | ✅ | ✅ | selected repos, ~1h |

The App path is the only one that is **both** zero-re-auth **and**
no-long-lived-secret.

## Trust boundary — who holds what

- **App private key (the master credential):** lives ONLY in the hub
  (Next.js / App Runner), stored in Secrets Manager `ember/github-app`. NEVER
  enters the microVM.
- **Installation token (~1h, repo-scoped):** minted by the hub per clone, passed
  in the invoke payload, materialized to tmpfs in the microVM. This is the only
  GitHub credential the agent can reach.

> Rejected design: minting inside the runtime. That would require the App private
> key inside the microVM where untrusted agents run — strictly worse than the PAT.

## User experience

One-time setup, then **invisible forever** — no per-session, no per-turn auth.

**Personal deploy (default, unchanged):** the `GITHUB_PAT` env path still works
with zero new steps. Stays the documented simple option; nobody is forced into
App setup.

**App path (multi-user / "proper"):**
1. **Operator, once:** create the GitHub App via the manifest flow (one click on
   GitHub generates the App + private key, redirects back; the hub stores App ID
   + PEM in Secrets Manager).
2. **End user, once:** click **Connect GitHub** in the account sheet → GitHub's
   "Install & pick repositories" screen → redirect back with `installation_id`,
   stored per-user.
3. **Every clone after that:** nothing. The hub auto-mints a fresh token. Expiry
   is invisible — each turn gets a new token on demand.

## Installation scope decision

Support **both**, operator's choice at App-create time:
- **Per-user install** — each dev installs on their own account/repos. Default for
  personal + small teams.
- **Org install** — one installation covers a whole GitHub org; all tenant users
  share it. For enterprises with an org.

The stored record is just an `installation_id` either way; the mint call is
identical. Org vs user is a GitHub-side install choice, not a code fork.

## Implementation

### New: `src/lib/ember/github-app.ts`
- `githubAppConfigured(): boolean` — App ID + PEM present.
- `mintInstallationToken(installationId, repositories?): Promise<{token, expiresAt}>`
  - Read App ID + PEM from Secrets Manager `ember/github-app` (cache the config).
  - Sign an RS256 JWT with **`jose`** (already a dep): `iss=appId`, `iat`, 9-min
    `exp` (< GitHub's 10-min cap, clock-skew margin).
  - `POST https://api.github.com/app/installations/<id>/access_tokens` with
    optional `{ repositories }` scoping → `{ token, expires_at }`.
  - **In-memory cache** (module Map keyed by `installationId + repos`), reused
    until 5 min before `expires_at`, so we don't mint every turn.

### `src/lib/ember/secrets.ts`
- App key → a single deploy-level secret `ember/github-app`
  (`{ appId, privateKey }`), separate from per-user creds. Add
  `getGithubAppConfig()` reading it via the existing backend switch.

### `src/lib/ember/github-store.ts` (new, mirrors auth-store)
- Store per-(tenant,user) `{ installationId, account, repoSelection, connectedAt }`
  in the DynamoDB sessions table, key `github:{userId}`.
- `getGithubConnection(userId)`, `putGithubConnection(...)`, `deleteGithubConnection(...)`.

### API
- **`src/app/api/ember/github/route.ts` (new):**
  - `GET` → connection status (account login, repo count) — never the token.
  - `DELETE` → disconnect (clear installation record).
- **`src/app/api/ember/github/callback/route.ts` (new):** GitHub redirect target
  after install; captures `installation_id` (+ `setup_action`, `code`). Two gates
  before storing: (1) the signed `state` nonce proves THIS user started an install
  flow (CSRF + session binding; `?github=state_mismatch` on fail); (2) **ownership
  proof** — the manifest sets `request_oauth_on_install`, so GitHub appends an
  OAuth `code`; we exchange it for a user token and confirm the installation is in
  that user's `/user/installations` (`verifyInstallationOwnership`). State alone is
  insufficient: during its lifetime a user could start their own flow then swap in
  another org's `installation_id`. Ownership failure → `?github=ownership_unverified`.
  (An App created before OAuth-on-install has no client creds and falls back to
  state-only.) Ownership also requires **admin proof**, not mere visibility:
  `/user/installations` lists org installs a member can only *access*, so for an
  org-account install we additionally require the user's org membership role to be
  `admin` (`/user/memberships/orgs/{org}`); a user-account install must belong to
  the authenticated user. The manifest-**creation** flow (phase 1→2) carries its
  own signed `state` too, so an admin can't be lured into exchanging an attacker's
  manifest `code` (which would store the attacker's App as Ember's).
- **`src/app/api/ember/github/install/route.ts` (new):** issues the signed state
  (`issueInstallState(userId)`, HMAC keyed off the App private key) and redirects
  the user to GitHub's install screen carrying `?state=`.
- **`src/app/api/ember/github/manifest/route.ts` (new, operator-only):** the App
  manifest creation flow (generate App → GitHub returns a temp code → exchange for
  App ID + PEM → store in `ember/github-app`). The post-create install redirect
  also carries a signed state.

### Turn dispatch
- **`runtime.ts`:** add `githubToken?: string` to `CodingTurnParams`; in
  `buildTurnPayload` set `payload.github_token = params.githubToken`. Same for
  `warmCodingSession` (clone happens on warm too).
- **`message/route.ts`, `port/route.ts`, warm/prepare callers:** before invoke, if
  the session's user has a GitHub connection AND the App is configured →
  `mintInstallationToken(installationId, repoScope)` → pass `githubToken`. On any
  mint error, fall back to omitting it (runtime uses `GITHUB_PAT` env if set).

### Runtime `deploy/coding-agent-runtime/main.py`
- `_configure_git(token: str | None = None)`:
  - token source order: **payload `github_token`** → `GITHUB_PAT` env (back-compat).
  - Instead of baking `x-access-token:<token>@github.com` into `~/.gitconfig`,
    write the token to a **tmpfs file** (`/dev/shm/ember-creds/github`, mirroring
    the subscription-cred materialization) and configure a **git credential
    helper** that reads it. Keeps the token out of a static, greppable config file.
  - The helper is **scoped to `https://github.com`** — bound under
    `credential.https://github.com.helper` AND it re-checks `protocol`/`host` from
    git's stdin request, replying only for github.com. A bare `credential.helper`
    is consulted for every host, so without this a task cloning an
    attacker-controlled remote would have the token offered to it.
  - On a turn with **no token** (user disconnected, or minting failed) on a warm
    runtime, `_clear_git_credential_helper()` scrubs the helper config, the tmpfs
    token file, and `GH_TOKEN`/`GITHUB_TOKEN` — so a prior turn's installation
    token can't linger until natural expiry.
  - Still export `GH_TOKEN`/`GITHUB_TOKEN` (from the same tmpfs value) for `gh`.
  - Thread `github_token = payload.get("github_token")` at the call site
    (`main.py` ~line 2210) into `_configure_git(github_token)`.
- Redact `github_token` in `turn_start` / any payload logging.

### Deploy + role
- App key secret (`ember/github-app`) lives in **Secrets Manager only**, never the
  artifact bucket — regardless of `EMBER_SECRETS_BACKEND`. The shared runtime role
  grants `s3:GetObject` on `ember/*`, so an App key parked in S3 would be readable
  by an untrusted agent; SM (where the runtime role's grant is scoped to
  `ember/t/*`, excluding `ember/github-app`) is the one store the microVM cannot
  reach. The hub role has `secretsmanager:GetSecretValue`/`CreateSecret`/
  `PutSecretValue` on `ember/github-app*`. Dev/single-operator deploys without SM
  use the `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY` env override.
- `deploy.py`: keep `GITHUB_PAT` optional (personal fallback). Document that the
  App path supersedes it.

### Docs
- Flip ENTERPRISE.md §3 "Still open" → shipped.
- README: add the GitHub App connect flow; document fine-grained PAT as the
  documented fallback (never classic-full-`repo`).

## Verification

1. **Build/typecheck:** `npm run build` + `tsc` clean.
2. **Mint unit:** with a test App ID/PEM, `mintInstallationToken` returns a token
   that clones a private test repo; cache reuse verified (second call within
   window does not hit GitHub).
3. **Runtime git config:** `_configure_git(token)` → private clone succeeds; token
   is NOT in `~/.gitconfig` (only the helper is); `cat ~/.gitconfig` shows no
   secret; token file is on tmpfs, 0600.
4. **Live E2E:** connect GitHub in the account sheet → create a session on a
   private repo → clone succeeds with a minted token → confirm the token expires
   (~1h) and the next turn mints a fresh one with no user interaction.
5. **Fallback:** with no GitHub connection but `GITHUB_PAT` set, behavior is
   unchanged (personal deploy path still clones).

## Rollout

Additive + back-compat. The App path activates only when `ember/github-app` is
configured AND a user connects; otherwise the existing `GITHUB_PAT` path is
untouched. No migration, no breaking change for personal deploys.
