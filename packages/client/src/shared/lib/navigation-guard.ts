let guard: (() => Promise<boolean>) | undefined;

export function registerNavigationGuard(next: (() => Promise<boolean>) | undefined) {
  guard = next;
  return () => {
    if (guard === next) guard = undefined;
  };
}

export function navigationGuard() {
  return guard;
}
