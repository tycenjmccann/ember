# Security Policy

Ember runs coding agents **inside your own AWS account** — your code, your keys, your
bill. Security reports are taken seriously.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately via GitHub's [**Report a vulnerability**](https://github.com/tycenjmccann/ember/security/advisories/new)
(Security → Advisories). If you can't use that, email the maintainer listed on the
GitHub profile.

Please include:

- What the issue is and where (file, endpoint, or resource).
- Steps to reproduce or a proof of concept.
- Impact — what an attacker could do.

You'll get an acknowledgement within a few days. Once a fix ships we'll credit you in
the advisory unless you'd rather stay anonymous.

## Scope

Ember self-hosts into your account, so most of the trust boundary is yours to own. The
areas we care most about:

- **Credential handling** — CLI subscription tokens and API keys. Secrets are stored in
  DynamoDB, only ever sent to the runtime over the control-plane URL, and **never**
  returned through the API or attached to presigned S3 URLs.
- **Tenant isolation** — S3 keys, sessions, and workspaces are tenant-scoped; a report
  showing cross-tenant read/write is high severity.
- **Presigned URL / path-traversal** — artifact and transcript keys are built from
  untrusted paths; traversal or key-injection is in scope.
- **The cloud runtime** — the AgentCore micro-VM executes agent tool calls; sandbox
  escapes or privilege escalation are in scope.

## Out of scope

- Vulnerabilities in your own AWS misconfiguration (over-broad IAM you added, public
  buckets you created).
- Third-party CLIs (Claude Code, Codex, Kiro) themselves — report those upstream.
- Anything requiring a compromised AWS account or laptop you already control.

## Handling your own deployment

Because Ember runs in your account, you are the operator. Rotate CLI tokens and API keys
periodically, keep the runtime image current (`./install.sh` re-pulls the latest), and
scope the IAM role Ember creates to only the accounts/regions you use.
