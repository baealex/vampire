import { json } from '@sveltejs/kit';
import { authenticationRequired, isAuthenticated } from '~/lib/features/auth/server/auth';
import { getTmuxStatus } from '~/lib/features/terminal/server/tmux';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
  const authenticated = isAuthenticated(event);
  return json({
    authenticationRequired: authenticationRequired(),
    authenticated,
    tmux: await getTmuxStatus(),
  });
};
