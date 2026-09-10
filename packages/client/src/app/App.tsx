import { QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { queryClient } from '~/shared/api/query-client.ts';

function RootLayout() {
  return (
    <Suspense fallback={<div aria-label="Loading Vampire" />}>
      <Outlet />
    </Suspense>
  );
}

const VampireApp = lazy(() => import('./VampireApp.tsx'));
const rootRoute = createRootRoute({ component: RootLayout });
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '$',
  component: VampireApp,
});
const routeTree = rootRoute.addChildren([appRoute]);
const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
