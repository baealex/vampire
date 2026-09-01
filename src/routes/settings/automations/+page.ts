import type { PageLoad } from './$types';

export const load: PageLoad = ({ url }) => ({ workspaceId: url.searchParams.get('workspace') ?? undefined });
