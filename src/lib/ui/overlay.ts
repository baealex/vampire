export function isUiOverlayOpen(root: ParentNode = document): boolean {
	return Boolean(root.querySelector('[data-vampire-overlay]'));
}
