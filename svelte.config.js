import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter({
			out: 'build',
			precompress: true,
			// The adapter's own server variables must not overlap with app secrets
			// such as VAMPIRE_TOKEN. Our custom entrypoint owns host and port.
			envPrefix: 'VAMPIRE_ADAPTER_'
		}),
		csp: {
			mode: 'nonce',
			directives: {
				'default-src': ['self'],
				'base-uri': ['none'],
				'connect-src': ['self'],
				'font-src': ['self'],
				'form-action': ['self'],
				'frame-ancestors': ['none'],
				'img-src': ['self', 'data:'],
				'object-src': ['none'],
				'script-src': ['self'],
				'style-src': ['self', 'unsafe-inline']
			}
		}
	}
};

export default config;
