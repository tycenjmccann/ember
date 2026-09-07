# Removal Ledger — Dead-Code Sweep — tycenjmccann/ember — 2026-09-07

Workflow: wf_1788780725940_c2uqki · Epic: TEAM-4228 · Ticket: TEAM-4230 · Branch: `feature/TEAM-4230-code-sweeper` · Created from integration branch `feature/TEAM-4228-dead-code-sweep-tycenjmccann-ember-2026` @ f754cd36618f9b2adad03217bb4705d443ca8dd8, which is identical to `main` at sweep time · Delivery: HANDOFF (CD_REGISTERED: false) — never merged by the hub.

## Outcome

**Zero verified-dead removals.** Every candidate emitted by knip / ts-prune / depcheck across both workspaces was independently grepped repo-wide; exactly ONE symbol had zero non-definition references (`encodeClose`, src/lib/ember/shell-protocol.ts:62) and it sits inside the cross-language wire-contract file that this sweep is forbidden to trim → KEPT-UNCERTAIN, escalated to the owning team. Diff vs base contains only two additive files (knip.jsonc, REMOVAL_LEDGER.md). Note: PR #57 (merged 2026-08-31) already removed the previously-dead symbols/files/dep (clsx, src/lib/utils.ts, etc.), which is why this sweep is empty.

## Repo facts re-confirmed on this checkout

```text
$ node -e "const p=require('./package.json'); console.log(JSON.stringify(p.scripts||{}, null, 2))"
{
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "mcp:build": "cd mcp/port-session && npm install && npm run build"
}

$ node -e "const p=require('./mcp/port-session/package.json'); console.log(JSON.stringify(p.scripts||{}, null, 2))"
{
  "build": "tsc",
  "dev": "tsc --watch",
  "start": "node dist/index.js"
}

$ find . -path ./node_modules -prune -o \( -name '*.test.*' -o -name '*.spec.*' -o -name 'jest.config*' -o -name 'vitest.config*' -o -name 'playwright*' \) -print

$ find . -path ./node_modules -prune -o \( -name '.eslintrc*' -o -name 'eslint.config.*' \) -print

$ find . -path ./node_modules -prune -o \( -name 'knip.json' -o -name 'knip.jsonc' -o -name 'knip.config.*' \) -print

$ ls -la .github
total 12
drwxr-xr-x  3 bedrock_agentcore bedrock_agentcore 6144 Sep  7 11:42 .
drwxr-xr-x 10 bedrock_agentcore bedrock_agentcore 6144 Sep  7 11:42 ..
drwxr-xr-x  2 bedrock_agentcore bedrock_agentcore 6144 Sep  7 11:42 assets
```

## Tool versions

knip 5.88.1, ts-prune 0.10.3, depcheck 1.4.7 (all via `npx -y <tool>@<ver>`, nothing added to any package.json), node v20.19.2, npm 9.2.0, typescript 5.9.3 (repo devDependency).

```text
$ npx -y knip@5.88.1 --version
5.88.1

$ npm view ts-prune@0.10.3 version
0.10.3

$ npx -y depcheck@1.4.7 --version
1.4.7

$ node --version
v20.19.2

$ npm --version
9.2.0

$ node -e "console.log(require(\"./node_modules/typescript/package.json\").version)"
5.9.3
```

Exact commands per tool/workspace and artifact file names are archived at s3 `workflows/wf_1788780725940_c2uqki/shared/sweep-artifacts/`: `knip-root.txt`, `knip-all.txt`, `knip-mcp.txt`, `knip-debug-next-plugin.txt`, `ts-prune-root.txt`, `ts-prune-mcp.txt`, `depcheck-root.txt`, `depcheck-mcp.txt`, `verification-grep.txt`, `zero-reference-crosscheck.txt`, `candidates.md`, `tool-versions.txt`.

Proof-run artifacts: `proof-baseline-{a,b,c,d}-*.txt`, `proof-branch-{a,b,c,d,e,f}-*.txt`, `proof-baseline-install-{root,mcp}.txt` (same S3 prefix).

Detection counts and exit codes:

| Tool run | Counts | Exit |
| --- | --- | --- |
| knip-root | 12 unused exports; 17 unused exported types | 1 |
| knip-all | 1 unlisted dependency; 24 unused exports; 31 unused exported types; 7 configuration hints | 1 |
| knip-mcp | 1 unlisted dependency; 12 unused exports; 14 unused exported types | 1 |
| ts-prune-root | 94 emitted candidates | 0 |
| ts-prune-mcp | 26 emitted candidates | 0 |
| depcheck-root | 4 unused devDependencies | 255 |
| depcheck-mcp | 1 missing dependency | 255 |

Raw detection status:

```text
knip-root exit code: 1
knip-all exit code: 1
knip-mcp exit code: 1
ts-prune-root exit code: 0
depcheck-root exit code: 255
depcheck-mcp exit code: 255
ts-prune-mcp exit code: 0
```

## Candidate table

| Item | Kind (file/export/type/dependency) | Location | Detected by | Verification evidence (grep command → result) | Verdict (REMOVED / KEPT-UNCERTAIN / KEPT-FRAMEWORK / KEPT-FALSE-POSITIVE / KEPT-USED-IN-MODULE / KEPT-CONTRACT) | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| DEFAULT_FILE_CAP_BYTES | export | mcp/port-session/src/artifacts.ts:41 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'DEFAULT_FILE_CAP_BYTES' → definition plus mcp/port-session/src/artifacts.ts:190 internal default use | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| DEFAULT_TOTAL_CAP_BYTES | export | mcp/port-session/src/artifacts.ts:42 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'DEFAULT_TOTAL_CAP_BYTES' → definition plus mcp/port-session/src/artifacts.ts:191 internal default use | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| DEFAULT_FILE_COUNT_CAP | export | mcp/port-session/src/artifacts.ts:43 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'DEFAULT_FILE_COUNT_CAP' → definition plus mcp/port-session/src/artifacts.ts:192 internal default use | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| safeRelPath | export | mcp/port-session/src/artifacts.ts:348 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'safeRelPath' → definition plus mcp/port-session/src/artifacts.ts:361 internal validation use | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| ArtifactKind | type | mcp/port-session/src/artifacts.ts:45 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'ArtifactKind' → definition plus mcp/port-session/src/artifacts.ts:51,65,75 internal type uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| ArtifactCandidate | type | mcp/port-session/src/artifacts.ts:47 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'ArtifactCandidate' → definition plus mcp/port-session/src/artifacts.ts:57,58,59,197,198,236 internal type uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| DetectResult | type | mcp/port-session/src/artifacts.ts:56 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'DetectResult' → definition plus mcp/port-session/src/artifacts.ts:187 return type use | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| DetectOptions | type | mcp/port-session/src/artifacts.ts:173 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'DetectOptions' → definition plus mcp/port-session/src/artifacts.ts:187 parameter type use | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| emberAuthHeaders | export | mcp/port-session/src/auth.ts:120 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'emberAuthHeaders' → definition plus mcp/port-session/src/auth.ts:166 internal header composition use | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| slugForPath | export | mcp/port-session/src/cli-adapter.ts:55 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'slugForPath' → definition plus mcp/port-session/src/cli-adapter.ts:75 internal path use | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| sessionIdForClaudeTranscript | export | mcp/port-session/src/cli-adapter.ts:279 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'sessionIdForClaudeTranscript' → definition plus mcp/port-session/src/cli-adapter.ts internal transcript-id use | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| localTranscriptPath | export | mcp/port-session/src/cli-adapter.ts:297 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'localTranscriptPath' → definition plus mcp/port-session/src/cli-adapter.ts internal/local transcript path use | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| mergeClaudeTranscriptForPull | export | mcp/port-session/src/cli-adapter.ts:330 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'mergeClaudeTranscriptForPull' → definition plus mcp/port-session/src/cli-adapter.ts internal pull-merge use | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| LocatedSession | type | mcp/port-session/src/cli-adapter.ts:38 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'LocatedSession' → definition plus mcp/port-session/src/cli-adapter.ts:256 return type use | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| InstalledTranscript | type | mcp/port-session/src/cli-adapter.ts:45 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'InstalledTranscript' → definition plus mcp/port-session/src/cli-adapter.ts:393 return type use | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| parseRepo | export | mcp/port-session/src/git.ts:53 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'parseRepo' → definition plus mcp/port-session/src/git.ts:94 internal remote parsing use | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| normalizeCloneUrl | export | mcp/port-session/src/git.ts:65 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'normalizeCloneUrl' → definition plus mcp/port-session/src/git.ts internal clone-url normalization use | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| canPushToOrigin | export | mcp/port-session/src/git.ts:106 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'canPushToOrigin' → definition plus mcp/port-session/src/git.ts internal push capability use | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| GitState | type | mcp/port-session/src/git.ts:44 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'GitState' → definition plus mcp/port-session/src/git.ts:83,141,218 internal type uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| GitHandoff | type | mcp/port-session/src/git.ts:113 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'GitHandoff' → definition plus mcp/port-session/src/git.ts:137,227 internal type uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| Cli | type | mcp/port-session/src/config.ts:23 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'Cli' → definition plus mcp/port-session/src/config.ts:393 `gatherBundle(cli: Cli)` same-file use. NOTE: mcp/port-session/src/index.ts:450 `const g = await gatherBundle(cli as Cli)` references the `Cli` imported from ./cli-adapter.js (index.ts:30-36), NOT config.ts's — index.ts:37 imports only `gatherBundle` from ./config.js, so config.ts's `Cli` has no external consumer. | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| ServerCategory | type | mcp/port-session/src/config.ts:26 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'ServerCategory' → definition plus mcp/port-session/src/config.ts:38,104 internal type uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| ServerTransport | type | mcp/port-session/src/config.ts:27 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'ServerTransport' → definition plus mcp/port-session/src/config.ts:39,110,113,136 internal type uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| ClassifiedServer | type | mcp/port-session/src/config.ts:36 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'ClassifiedServer' → definition plus mcp/port-session/src/config.ts:50,96,160,161 internal type uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| GatherResult | type | mcp/port-session/src/config.ts:44 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'GatherResult' → definition plus mcp/port-session/src/config.ts:273,306,313,336,376,393 internal type uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| Cli | type | mcp/port-session/src/login.ts:22 | knip-all; knip-mcp; ts-prune-mcp | git grep -n -w 'Cli' → definition plus mcp/port-session/src/login.ts:81 internal type use | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| KindlingLoaderProps | type | src/components/ember/KindlingLoader.tsx:22 | knip-root; knip-all; ts-prune-root | git grep -n -w 'KindlingLoaderProps' → definition plus same-file component prop use | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| issuerUrl | export | src/lib/auth/cognito.ts:35 | knip-root; knip-all; ts-prune-root | git grep -n -w 'issuerUrl' → definition plus src/lib/auth/cognito.ts:43,69 internal Cognito issuer uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| OAuthEnv | type | src/lib/auth/oauth.ts:11 | knip-root; knip-all; ts-prune-root | git grep -n -w 'OAuthEnv' → definition plus same-file OAuth env uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| TokenSet | type | src/lib/auth/oauth.ts:51 | knip-root; knip-all; ts-prune-root | git grep -n -w 'TokenSet' → definition plus same-file token helper uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| REFRESH_MAX_AGE_S | export | src/lib/auth/session.ts:21 | knip-root; knip-all; ts-prune-root | git grep -n -w 'REFRESH_MAX_AGE_S' → definition plus same-file refresh max-age uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| CliAuthMeta | type | src/lib/ember/auth-store.ts:37 | knip-root; knip-all; ts-prune-root | git grep -n -w 'CliAuthMeta' → definition plus same-file auth metadata uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| UserAuthStatus | type | src/lib/ember/auth-store.ts:42 | knip-root; knip-all; ts-prune-root | git grep -n -w 'UserAuthStatus' → definition plus same-file status uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| UserConfig | type | src/lib/ember/config-store.ts:39 | knip-root; knip-all; ts-prune-root | git grep -n -w 'UserConfig' → definition plus same-file config-store uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| repoShortName | export | src/lib/ember/github-app.ts:22 | knip-root; knip-all; ts-prune-root | git grep -n -w 'repoShortName' → definition plus same-file GitHub helper uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| mintInstallationToken | export | src/lib/ember/github-app.ts:103 | knip-root; knip-all; ts-prune-root | git grep -n -w 'mintInstallationToken' → definition plus same-file token minting uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| GithubAppConfig | type | src/lib/ember/github-app.ts:34 | knip-root; knip-all; ts-prune-root | git grep -n -w 'GithubAppConfig' → definition plus same-file GitHub app config uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| InstallationToken | type | src/lib/ember/github-app.ts:36 | knip-root; knip-all; ts-prune-root | git grep -n -w 'InstallationToken' → definition plus same-file installation token uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| CloneTokenResult | type | src/lib/ember/github-app.ts:142 | knip-root; knip-all; ts-prune-root | git grep -n -w 'CloneTokenResult' → definition plus same-file clone token result uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| GithubConnection | type | src/lib/ember/github-store.ts:24 | knip-root; knip-all; ts-prune-root | git grep -n -w 'GithubConnection' → definition plus same-file GitHub store uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| authDisabled | export | src/lib/ember/identity.ts:32 | knip-root; knip-all; ts-prune-root | git grep -n -w 'authDisabled' → definition plus same-file identity branch uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| Identity | type | src/lib/ember/identity.ts:26 | knip-root; knip-all; ts-prune-root | git grep -n -w 'Identity' → definition plus same-file identity uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| CodingTurnResult | type | src/lib/ember/runtime.ts:49 | knip-root; knip-all; ts-prune-root | git grep -n -w 'CodingTurnResult' → definition plus same-file runtime result uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| CodingTurnParams | type | src/lib/ember/runtime.ts:60 | knip-root; knip-all; ts-prune-root | git grep -n -w 'CodingTurnParams' → definition plus same-file runtime param uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| tenantRoot | export | src/lib/ember/s3keys.ts:26 | knip-root; knip-all; ts-prune-root | git grep -n -w 'tenantRoot' → definition plus same-file key builder uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| resumePrefix | export | src/lib/ember/s3keys.ts:39 | knip-root; knip-all; ts-prune-root | git grep -n -w 'resumePrefix' → definition plus same-file resume key uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| checkpointPrefix | export | src/lib/ember/s3keys.ts:68 | knip-root; knip-all; ts-prune-root | git grep -n -w 'checkpointPrefix' → definition plus same-file checkpoint key uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| secretName | export | src/lib/ember/secrets.ts:34 | knip-root; knip-all; ts-prune-root | git grep -n -w 'secretName' → definition plus same-file secrets backend uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| SecretsBackend | type | src/lib/ember/secrets.ts:26 | knip-root; knip-all; ts-prune-root | git grep -n -w 'SecretsBackend' → definition plus same-file backend selection uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| DEFAULT_TENANT_ID | export | src/lib/ember/sessions.ts:28 | knip-root; knip-all; ts-prune-root | git grep -n -w 'DEFAULT_TENANT_ID' → definition plus same-file session fallback uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| getTenantSilo | export | src/lib/ember/tenant-store.ts:47 | knip-root; knip-all; ts-prune-root | git grep -n -w 'getTenantSilo' → definition plus same-file tenant-store uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| TenantSilo | type | src/lib/ember/tenant-store.ts:31 | knip-root; knip-all; ts-prune-root | git grep -n -w 'TenantSilo' → definition plus same-file tenant silo uses | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| VoiceInput | type | src/lib/ember/use-voice-input.ts:50 | knip-root; knip-all; ts-prune-root | git grep -n -w 'VoiceInput' → definition plus same-file hook return type use | KEPT-USED-IN-MODULE | ts-prune marks `(used in module)`, so only the export surface is unused; keyword-only refactor is out of scope. |
| encodeClose | export | src/lib/ember/shell-protocol.ts:62 | knip-root; knip-all; ts-prune-root | git grep -n -w 'encodeClose' → definition only in src/lib/ember/shell-protocol.ts:62 | KEPT-UNCERTAIN | Zero non-definition references, but src/lib/ember/shell-protocol.ts is the browser-side wire-contract with the Bedrock AgentCore /ws/shells service (bedrock_agentcore SDK protocol); escalated to owning team. |
| DecodedFrame | type | src/lib/ember/shell-protocol.ts:21 | knip-root; knip-all; ts-prune-root | git grep -n -w 'DecodedFrame' → definition plus same-file protocol parsing uses | KEPT-CONTRACT | All exports from src/lib/ember/shell-protocol.ts are wire-contract surface with the Bedrock AgentCore /ws/shells service (bedrock_agentcore SDK protocol) by sweep rule. |
| middleware, config | export | src/middleware.ts:58; src/middleware.ts:132 | ts-prune-root | git grep -n -w 'middleware'; git grep -n -w 'config' → middleware/config definitions plus docs references to src/middleware.ts; Next middleware convention. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| default, metadata, viewport | export | src/app/layout.tsx:31; src/app/layout.tsx:6; src/app/layout.tsx:19 | ts-prune-root | git grep -n -w 'default'; git grep -n -w 'metadata'; git grep -n -w 'viewport' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| default | export | src/app/page.tsx:6 | ts-prune-root | git grep -n -w 'default' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| default | export | src/app/cost/page.tsx:66 | ts-prune-root | git grep -n -w 'default' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| default | export | src/app/ember/page.tsx:58 | ts-prune-root | git grep -n -w 'default' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| default, dynamic | export | src/app/login/page.tsx:8; src/app/login/page.tsx:6 | ts-prune-root | git grep -n -w 'default'; git grep -n -w 'dynamic' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| GET, dynamic | export | src/app/api/auth/callback/route.ts:24; src/app/api/auth/callback/route.ts:22 | ts-prune-root | git grep -n -w 'GET'; git grep -n -w 'dynamic' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| GET, dynamic | export | src/app/api/auth/cli-config/route.ts:17; src/app/api/auth/cli-config/route.ts:15 | ts-prune-root | git grep -n -w 'GET'; git grep -n -w 'dynamic' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| GET, dynamic | export | src/app/api/auth/health/route.ts:10; src/app/api/auth/health/route.ts:8 | ts-prune-root | git grep -n -w 'GET'; git grep -n -w 'dynamic' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| GET, dynamic | export | src/app/api/auth/login/route.ts:22; src/app/api/auth/login/route.ts:20 | ts-prune-root | git grep -n -w 'GET'; git grep -n -w 'dynamic' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| GET, dynamic | export | src/app/api/auth/logout/route.ts:15; src/app/api/auth/logout/route.ts:13 | ts-prune-root | git grep -n -w 'GET'; git grep -n -w 'dynamic' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| GET, POST, DELETE, dynamic | export | src/app/api/ember/auth/route.ts:26; src/app/api/ember/auth/route.ts:37; src/app/api/ember/auth/route.ts:94; src/app/api/ember/auth/route.ts:20 | ts-prune-root | git grep -n -w 'GET'; git grep -n -w 'POST'; git grep -n -w 'DELETE'; git grep -n -w 'dynamic' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| GET, POST, PUT, dynamic, maxDuration | export | src/app/api/ember/config/route.ts:41; src/app/api/ember/config/route.ts:47; src/app/api/ember/config/route.ts:110; src/app/api/ember/config/route.ts:29; src/app/api/ember/config/route.ts:30 | ts-prune-root | git grep -n -w 'GET'; git grep -n -w 'POST'; git grep -n -w 'PUT'; git grep -n -w 'dynamic'; git grep -n -w 'maxDuration' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| GET, DELETE, dynamic | export | src/app/api/ember/github/route.ts:16; src/app/api/ember/github/route.ts:44; src/app/api/ember/github/route.ts:14 | ts-prune-root | git grep -n -w 'GET'; git grep -n -w 'DELETE'; git grep -n -w 'dynamic' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| GET, POST, dynamic | export | src/app/api/ember/sessions/route.ts:14; src/app/api/ember/sessions/route.ts:28; src/app/api/ember/sessions/route.ts:12 | ts-prune-root | git grep -n -w 'GET'; git grep -n -w 'POST'; git grep -n -w 'dynamic' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| GET, dynamic | export | src/app/api/ember/github/callback/route.ts:29; src/app/api/ember/github/callback/route.ts:23 | ts-prune-root | git grep -n -w 'GET'; git grep -n -w 'dynamic' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| GET, dynamic | export | src/app/api/ember/github/install/route.ts:21; src/app/api/ember/github/install/route.ts:15 | ts-prune-root | git grep -n -w 'GET'; git grep -n -w 'dynamic' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| GET, dynamic | export | src/app/api/ember/github/manifest/route.ts:30; src/app/api/ember/github/manifest/route.ts:24 | ts-prune-root | git grep -n -w 'GET'; git grep -n -w 'dynamic' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| PATCH, GET, DELETE, dynamic | export | src/app/api/ember/sessions/[id]/route.ts:64; src/app/api/ember/sessions/[id]/route.ts:88; src/app/api/ember/sessions/[id]/route.ts:105; src/app/api/ember/sessions/[id]/route.ts:22 | ts-prune-root | git grep -n -w 'PATCH'; git grep -n -w 'GET'; git grep -n -w 'DELETE'; git grep -n -w 'dynamic' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| POST, dynamic | export | src/app/api/ember/sessions/port/route.ts:100; src/app/api/ember/sessions/port/route.ts:47 | ts-prune-root | git grep -n -w 'POST'; git grep -n -w 'dynamic' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| GET, POST, dynamic | export | src/app/api/ember/sessions/[id]/artifacts/route.ts:62; src/app/api/ember/sessions/[id]/artifacts/route.ts:123; src/app/api/ember/sessions/[id]/artifacts/route.ts:25 | ts-prune-root | git grep -n -w 'GET'; git grep -n -w 'POST'; git grep -n -w 'dynamic' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| POST, dynamic, maxDuration | export | src/app/api/ember/sessions/[id]/checkpoint/route.ts:32; src/app/api/ember/sessions/[id]/checkpoint/route.ts:25; src/app/api/ember/sessions/[id]/checkpoint/route.ts:26 | ts-prune-root | git grep -n -w 'POST'; git grep -n -w 'dynamic'; git grep -n -w 'maxDuration' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| POST, dynamic, maxDuration | export | src/app/api/ember/sessions/[id]/message/route.ts:25; src/app/api/ember/sessions/[id]/message/route.ts:21; src/app/api/ember/sessions/[id]/message/route.ts:23 | ts-prune-root | git grep -n -w 'POST'; git grep -n -w 'dynamic'; git grep -n -w 'maxDuration' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| POST, dynamic, maxDuration | export | src/app/api/ember/sessions/[id]/shell/route.ts:33; src/app/api/ember/sessions/[id]/shell/route.ts:23; src/app/api/ember/sessions/[id]/shell/route.ts:27 | ts-prune-root | git grep -n -w 'POST'; git grep -n -w 'dynamic'; git grep -n -w 'maxDuration' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| POST, dynamic, maxDuration | export | src/app/api/ember/sessions/[id]/stop/route.ts:34; src/app/api/ember/sessions/[id]/stop/route.ts:29; src/app/api/ember/sessions/[id]/stop/route.ts:30 | ts-prune-root | git grep -n -w 'POST'; git grep -n -w 'dynamic'; git grep -n -w 'maxDuration' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| POST, dynamic, maxDuration | export | src/app/api/ember/sessions/[id]/warm/route.ts:21; src/app/api/ember/sessions/[id]/warm/route.ts:18; src/app/api/ember/sessions/[id]/warm/route.ts:19 | ts-prune-root | git grep -n -w 'POST'; git grep -n -w 'dynamic'; git grep -n -w 'maxDuration' → Framework-convention export; repo-wide grep finds definitions but no direct source caller. | KEPT-FRAMEWORK | Next.js App Router/middleware discovers this export by file convention. |
| node:sqlite | dependency | mcp/port-session/src/cli-adapter.ts:32 | knip-all; knip-mcp; depcheck-mcp | git grep -n 'node:sqlite' → mcp/port-session/src/cli-adapter.ts:32 imports Node builtin node:sqlite | KEPT-FALSE-POSITIVE | Node builtins are not package dependencies; no package.json edit in phase 1. |
| @types/react-dom | dependency | package.json:40 | depcheck-root | git grep -n '@types/react-dom' → package.json/package-lock only | KEPT-FALSE-POSITIVE | Type package supports React DOM/Next TypeScript tooling; dev tooling false positive by sweep rule. |
| autoprefixer | dependency | package.json:41 | depcheck-root | git grep -n 'autoprefixer' → postcss.config.js:4 configures autoprefixer plus package manifests | KEPT-FALSE-POSITIVE | PostCSS tooling dependency referenced from config. |
| postcss | dependency | package.json:42 | depcheck-root | git grep -n 'postcss' → postcss.config.js exists and package-lock includes PostCSS plugin graph | KEPT-FALSE-POSITIVE | Build tooling dependency; config file is consumed by Next/Tailwind pipeline. |
| typescript | dependency | package.json:44 | depcheck-root | git grep -n 'typescript' → root and MCP package manifests/locks contain TypeScript; tsconfig files present | KEPT-FALSE-POSITIVE | TypeScript compiler/tooling dependency. |
| @tailwindcss/typography ignoreDependencies hint | dependency | knip.jsonc | knip-all configuration hint | git grep -n '@tailwindcss/typography' → tailwind.config.js:92 requires @tailwindcss/typography | KEPT-FALSE-POSITIVE | knip hint that the entry is redundant with the Next.js/PostCSS/Tailwind plugin; entry kept explicit per R1 |
| @smithy/node-http-handler ignoreDependencies hint | dependency | knip.jsonc | knip-all configuration hint | git grep -n '@smithy/node-http-handler' → next.config.mjs:14 names @smithy/node-http-handler plus lockfile references | KEPT-FALSE-POSITIVE | knip hint that the entry is redundant with the Next.js/PostCSS/Tailwind plugin; entry kept explicit per R1 |
| src/middleware.ts redundant entry hint | file | knip.jsonc | knip-all configuration hint | git grep -n -w 'middleware'; git grep -n 'src/middleware'; git grep -n 'src/middleware.ts' → README.md:152/192 and docs/ENTERPRISE.md:84 reference src/middleware.ts | KEPT-FALSE-POSITIVE | knip hint that the entry is redundant with the Next.js/PostCSS/Tailwind plugin; entry kept explicit per R1 |
| next.config.mjs redundant entry hint | file | knip.jsonc | knip-all configuration hint | git grep -n 'next.config'; git grep -n 'next.config.mjs' → no content matches beyond file itself; Next/knip plugin covers config by convention | KEPT-FALSE-POSITIVE | knip hint that the entry is redundant with the Next.js/PostCSS/Tailwind plugin; entry kept explicit per R1 |
| tailwind.config.js redundant entry hint | file | knip.jsonc | knip-all configuration hint | git grep -n 'tailwind.config'; git grep -n 'tailwind.config.js' → tailwind.config.js:2 self-doc comment references tailwind.config.js | KEPT-FALSE-POSITIVE | knip hint that the entry is redundant with the Next.js/PostCSS/Tailwind plugin; entry kept explicit per R1 |
| postcss.config.js redundant entry hint | file | knip.jsonc | knip-all configuration hint | git grep -n 'postcss.config'; git grep -n 'postcss.config.js' → no content matches beyond file itself; PostCSS/Next pipeline consumes config by convention | KEPT-FALSE-POSITIVE | knip hint that the entry is redundant with the Next.js/PostCSS/Tailwind plugin; entry kept explicit per R1 |
| mcp/port-session/src/index.ts redundant entry hint | file | knip.jsonc | knip-all configuration hint | git grep -n 'src/index'; git grep -n 'src/index.ts'; git grep -n 'mcp/port-session/src/index'; git grep -n 'mcp/port-session/src/index.ts' → no content matches beyond package build convention; package main points to dist/index.js | KEPT-FALSE-POSITIVE | knip hint that the entry is redundant with the Next.js/PostCSS/Tailwind plugin; entry kept explicit per R1 |

## Removed

None.

REMOVED-set (∅) == deletions in diff (∅). `git diff --stat <base>..HEAD` shows only additions: knip.jsonc, REMOVAL_LEDGER.md.

## Kept (uncertain)

- `encodeClose` — src/lib/ember/shell-protocol.ts:62 — detected by knip (root), ts-prune (root). `git grep -n -w 'encodeClose'` → only the definition line. Kept because src/lib/ember/shell-protocol.ts is the browser-side implementation of the channel-prefix framing protocol of the Bedrock AgentCore runtime `/ws/shells` WebSocket service (protocol owned by the `bedrock_agentcore` Python SDK, runtime/shell/protocol.py — see shell-protocol.ts:4-6). The peer is that external AWS service: src/app/api/ember/sessions/[id]/shell/route.ts:4-6,141-142 only SigV4-presigns `bedrock-agentcore.${REGION}.amazonaws.com/runtimes/${arn}/ws/shells` and the browser (src/components/ember/ShellTerminal.tsx:166-181) connects directly and already RECEIVES ShellChannel.CLOSE → setStatus("closed"). The repo's own runtime image is NOT the peer: `grep -n -iE "channel|frame|0xff|CLOSE" deploy/coding-agent-runtime/main.py deploy/coding-agent-runtime/shell-init.sh` returned only unrelated DB close / SSE / JSONL frame mentions, with no shell channel-prefix / 0xff / CLOSE frame handling; deploy/coding-agent-runtime/requirements.txt lists fastapi, uvicorn, boto3, requests, aws-bedrock-token-generator (no bedrock_agentcore SDK). Because the peer is an external service protocol this repo cannot inspect, KEEP-UNCERTAIN is the conservative verdict; CLOSE (0xff) is a channel of that protocol and the encoder may be needed by the browser terminal / future callers. Sweep rules forbid trimming this file on unused-export grounds. Recommendation for the owning team: decide whether the CLOSE-frame encoder is intentionally retained; it is the ONLY symbol in the repo with zero non-definition references.

## Tool false positives

- `@smithy/node-http-handler` — transitive package named only in next.config.mjs:14 `serverComponentsExternalPackages`; not a direct dependency, so knip needed `ignoreDependencies`.
- `@aws-crypto/sha256-js`, `@smithy/signature-v4`, `@aws-sdk/credential-provider-node` — imported in src/app/api/ember/sessions/[id]/shell/route.ts:13, src/app/api/ember/sessions/[id]/shell/route.ts:14, and src/app/api/ember/sessions/[id]/shell/route.ts:15. These were pre-flagged as classic false positives; they were not flagged by any tool this run, listed pre-emptively.
- `@tailwindcss/typography` — required from tailwind.config.js:92; config-only reference.
- Next.js route/page/layout default exports, HTTP handler exports (`GET`/`POST`/`PUT`/`PATCH`/`DELETE`), src/middleware.ts `middleware`/`config`, and segment-config exports (`dynamic` ×27, `maxDuration`, `metadata`, `viewport`) — framework entry points flagged by ts-prune.
- depcheck root devDeps `@types/react-dom`, `autoprefixer`, `postcss`, `typescript` — tooling deps loaded by PostCSS/Next/tsc, invisible to import analysis.
- `node:sqlite` — Node builtin flagged as unlisted/missing by knip (mcp) and depcheck (mcp).
- All ts-prune `(used in module)` exports (root + mcp) — symbol used inside its own module; only the `export` keyword is unused; removing the keyword is a refactor, out of scope.
- `src/lib/ember/types.ts` — no tool emitted a candidate from this file this run (verified against knip, ts-prune, and depcheck artifacts); it is contract-protected regardless.

## Proof (R4) — "full test suite" (no test runner exists)

| Command | Baseline (base @ f754cd3) EXIT | Branch EXIT | Artifact |
| --- | --- | --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 0 | `proof-baseline-a-tsc-root.txt`; `proof-branch-a-tsc-root.txt` |
| `npm run build` | 0 | 0 | `proof-baseline-b-next-build.txt`; `proof-branch-b-next-build.txt` |
| `npm run mcp:build` | 0 | 0 | `proof-baseline-c-mcp-build.txt`; `proof-branch-c-mcp-build.txt` |
| `cd mcp/port-session && npx tsc --noEmit` | 0 | 0 | `proof-baseline-d-tsc-mcp.txt`; `proof-branch-d-tsc-mcp.txt` |
| Test runner re-check: grep for `test`/`lint` scripts and jest/vitest/playwright/mocha/cypress binaries | no runner exists | grep exit 1 = no matches | `proof-branch-e-no-test-runner.txt` |
| `docker build -t ember-sweep-check .` | NOT RUN | NOT RUN — `docker: command not found` (exit 127) | `proof-branch-f-docker.txt` |

`next build` with `output: "standalone"` (row b) exercises the same build step the Dockerfile runs. Zero new errors vs baseline (build outputs identical route tables). `git status` was clean of tracked changes after builds; no package.json/lockfile changed in either workspace.

## Process notes

- Branch naming: ticket text suggested `chore/dead-code-sweep-2026-09-07` from `main`; the workflow harness mandates `feature/TEAM-4230-code-sweeper` cut from the shared integration branch `feature/TEAM-4228-dead-code-sweep-tycenjmccann-ember-2026` (same SHA as main). The harness convention was followed; the orchestrator opens the unified PR to main.
- No Pipeline/CD tools used; nothing merged.
- Recommendation (not implemented, out of scope): add a test runner / ESLint / CI workflow so future sweeps have a real suite.
