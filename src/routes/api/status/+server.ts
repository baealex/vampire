import { json } from '@sveltejs/kit';
import { authenticationRequired, isAuthenticated } from '~/lib/features/auth/server/auth.server.ts';
import { getTmuxStatus } from '~/lib/features/terminal/server/tmux.server.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
  const authenticated = isAuthenticated(event);
  return json({
    authenticationRequired: authenticationRequired(),
    authenticated,
    tmux: authenticated ? await getTmuxStatus() : null,
  });
};
