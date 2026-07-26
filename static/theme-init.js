(() => {
	const storageKey = 'vampire:theme';
	let theme;
	try {
		const savedTheme = window.localStorage.getItem(storageKey);
		if (savedTheme === 'dark' || savedTheme === 'light') theme = savedTheme;
	} catch {
		// Storage can be unavailable in hardened browser contexts.
	}
	document.documentElement.dataset.theme = theme
		?? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
})();
