import { authenticationRequired, isAuthenticated } from '~/lib/features/auth/server/auth.server.ts';
import { getTmuxStatus } from '~/lib/features/terminal/server/tmux.server.ts';
import { json, type RequestHandler } from '~/lib/server/http-handler.server.ts';

export const GET: RequestHandler = async (event) => {
  const authenticated = isAuthenticated(event);
  return json({
    authenticationRequired: authenticationRequired(),
    authenticated,
    tmux: authenticated ? await getTmuxStatus() : null,
  });
};
