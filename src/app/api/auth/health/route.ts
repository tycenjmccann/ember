/**
 * Unauthenticated health check for load balancers.
 *
 * Lives under /api/auth/ so the middleware's PUBLIC_PREFIXES allowlist keeps it
 * reachable without a session — every other page 302s to /login and every other
 * API 401s, neither of which an ALB target-group matcher counts as healthy.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true });
}
