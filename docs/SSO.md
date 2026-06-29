# Single Sign-On (SSO / federated login)

Ember authenticates through an Amazon Cognito user pool. Cognito can sit in front
of your existing identity provider — Okta, Microsoft Entra ID (Azure AD), Google
Workspace, OneLogin, Ping, Cloudflare Access, or any SAML 2.0 / OpenID Connect IdP.

Because the app only ever verifies **Cognito** tokens, federation needs **no app
code changes and no redeploy**. You register your IdP once with one script and
your team signs in with their existing corporate credentials.

> Requires the Cognito **Essentials** tier or higher. SAML/OIDC federation is not
> available on the Lite tier.

---

## 1. Register your IdP

Run [`deploy/cognito/add-idp.sh`](../deploy/cognito/add-idp.sh) once per provider.
It creates the IdP on the pool **and** enables it on the web + CLI app clients (so
it actually appears at the Hosted UI — registering alone leaves it hidden).

```bash
# SAML — Okta, Entra ID, OneLogin, Ping, Cloudflare Access (metadata URL):
deploy/cognito/add-idp.sh Okta saml \
    --metadata-url https://acme.okta.com/app/abc123/sso/saml/metadata

# SAML from a downloaded metadata file instead:
deploy/cognito/add-idp.sh Entra saml --metadata-file ./entra-metadata.xml

# Generic OIDC IdP:
deploy/cognito/add-idp.sh CorpOIDC oidc \
    --client-id <id> --client-secret <secret> \
    --issuer https://login.acme.com

# Google Workspace:
deploy/cognito/add-idp.sh Google google \
    --client-id <id>.apps.googleusercontent.com --client-secret <secret>
```

`NAME` (the first arg) is what your users see and what you pass in the direct
link below. Use letters, digits, `_ . -`, max 32 chars. Re-running with the same
`NAME` updates that provider in place.

## 2. Point your IdP back at Cognito

In your IdP's app/integration config, set the redirect / ACS URL to your pool's
hosted endpoint:

```
<COGNITO_DOMAIN>/oauth2/idpresponse
```

`COGNITO_DOMAIN` is the value printed by `setup-cognito.sh`
(e.g. `https://ember-123456789012.auth.us-east-1.amazoncognito.com`).

| IdP | What to create | Key field |
|-----|----------------|-----------|
| Okta | SAML 2.0 app | Single sign-on URL = `…/oauth2/idpresponse` |
| Entra ID | Enterprise app (SAML) | Reply URL = `…/oauth2/idpresponse` |
| Google | OAuth 2.0 client | Authorized redirect URI = `…/oauth2/idpresponse` |
| OIDC (generic) | OIDC client | Redirect URI = `…/oauth2/idpresponse` |
| Cloudflare Access | SAML/OIDC SaaS app | ACS / redirect = `…/oauth2/idpresponse` |

## 3. Sign in

- **Hosted-UI chooser:** users hit the normal login link and pick your provider.
- **Direct SSO link (skips the chooser):**

  ```
  https://<your-deployment>/api/auth/login?idp=<NAME>
  ```

  e.g. `https://ember.acme.com/api/auth/login?idp=Okta` drops users straight on
  Okta. Hand this link to your team or wire it behind a "Sign in with SSO" button.

Federated users are provisioned just-in-time — no `admin-user.sh` step needed.
Each gets their own isolated tenant (sessions, config, secrets, S3 prefix) keyed
to their Cognito `sub`.

---

## Grouping a whole company into one tenant (optional)

By default every user — federated or not — gets a **per-user** tenant. If you want
all of one customer's SSO users to **share a single tenant** (shared sessions /
config), add a [Pre-Token-Generation Lambda](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-token-generation.html)
on the pool that stamps `custom:tenantId` based on the IdP the user came from
(`identities[0].providerName` in the trigger event).

Ember reads `custom:tenantId` and falls back to a per-user value when it's unset,
so isolation holds with or without the Lambda — this is purely opt-in grouping.
It's the one piece that is code/infra rather than config, which is why it's left
out of the base install.

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Provider missing from Hosted UI | App client doesn't list it — rerun `add-idp.sh` (it enables on `ember-web` + `ember-cli`). |
| `?idp=NAME` ignored, chooser shown | `NAME` mismatch (case-sensitive) or invalid chars — must match the registered provider exactly. |
| `redirect_mismatch` at the IdP | IdP redirect/ACS URL ≠ `<COGNITO_DOMAIN>/oauth2/idpresponse`. |
| Federation rejected by Cognito | Pool is on the Lite tier — upgrade to Essentials or higher. |
| Email blank on the user | Adjust the attribute mapping; SAML email claim URIs vary by IdP. |
