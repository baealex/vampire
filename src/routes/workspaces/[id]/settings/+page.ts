import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => ({ workspaceId: params.id });
