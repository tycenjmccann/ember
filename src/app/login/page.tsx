/**
 * /login — the only unauthenticated page. No signup (pool is admin-create-only);
 * a single button hands off to the Cognito Hosted UI via /api/auth/login.
 */

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <div className="flex h-full w-full items-center justify-center px-6">
      <div className="flex flex-col items-center gap-6 text-center">
        <img src="/ember-icon.svg" alt="ember" className="h-12 w-auto" />
        <div className="space-y-1">
          <h1 className="text-[22px] font-semibold tracking-tight text-[var(--color-text-primary)]">
            ember
          </h1>
          <p className="text-[15px] text-[var(--color-text-secondary)]">
            Sign in to continue
          </p>
        </div>
        <a
          href="/api/auth/login"
          className="press rounded-[12px] bg-[var(--ios-blue)] px-6 py-3 text-[16px] font-medium text-white"
        >
          Sign in
        </a>
        <p className="max-w-xs text-[12px] text-[var(--color-text-secondary)]">
          Access is provisioned by your administrator. Contact them if you need an
          account.
        </p>
      </div>
    </div>
  );
}
