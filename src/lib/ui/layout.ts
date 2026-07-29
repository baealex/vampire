export const DESKTOP_MEDIA_QUERY = '(min-width: 64rem)';
export const COMPACT_MEDIA_QUERY = '(max-width: 32rem)';

export function isDesktopViewport(): boolean {
	return window.matchMedia(DESKTOP_MEDIA_QUERY).matches;
}
