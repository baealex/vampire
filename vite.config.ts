import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	optimizeDeps: {
		include: ['@codemirror/commands', '@codemirror/state', '@codemirror/view']
	},
	ssr: {
		noExternal: ['@lucide/svelte']
	}
});
