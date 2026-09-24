// ADR-006 Option A gate: prove OBO -> Lakebase session_user == the real human,
// from the AppKit NODE server (the Node analogue of the Python identity_app that
// returned L0_full_obo). asUser(req) runs the query on the caller's per-user
// Lakebase pool, so PostgreSQL session_user reflects the authenticated user.
import { Application, Request } from 'express';

interface AppKitOBO {
  lakebase: {
    query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    asUser(req: Request): {
      query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    };
  };
  server: { extend(fn: (app: Application) => void): void };
}

export function setupWhoamiRoute(appkit: AppKitOBO): void {
  appkit.server.extend((app) => {
    app.get('/api/whoami', async (req, res) => {
      const forwardedEmail = req.header('x-forwarded-email') ?? null;
      const hasToken = Boolean(req.header('x-forwarded-access-token'));
      try {
        const result = await appkit.lakebase.asUser(req).query('SELECT session_user, current_user');
        const row = result.rows[0] ?? {};
        const sessionUser = row['session_user'];
        const isHuman = typeof sessionUser === 'string' && sessionUser.includes('@');
        res.json({
          identity: forwardedEmail ?? (typeof sessionUser === 'string' ? sessionUser : null),
          forwarded_email: forwardedEmail,
          has_forwarded_token: hasToken,
          pg_session_user: sessionUser,
          pg_current_user: row['current_user'],
          verdict: isHuman ? 'L0_full_obo' : 'L1_not_human',
        });
      } catch (err) {
        res.status(500).json({
          forwarded_email: forwardedEmail,
          has_forwarded_token: hasToken,
          error: (err as Error).message,
        });
      }
    });
  });
}
