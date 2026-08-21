export const DESKTOP_MEDIA_QUERY = '(min-width: 64rem)';
export const REPOSITORY_SPLIT_MEDIA_QUERY = '(min-width: 80rem)';
export const COMPACT_MEDIA_QUERY = '(max-width: 32rem)';

export function isDesktopViewport(): boolean {
  return window.matchMedia(DESKTOP_MEDIA_QUERY).matches;
}
