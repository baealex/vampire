import adapter from '@sveltejs/adapter-node';

const svelteKitOutputDirectory = process.env.VAMPIRE_SVELTEKIT_OUT_DIR?.trim() || '.svelte-kit';
const adapterOutputDirectory = process.env.VAMPIRE_BUILD_DIR?.trim() || 'build';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    outDir: svelteKitOutputDirectory,
    adapter: adapter({
      out: adapterOutputDirectory,
      precompress: true,
      // The adapter's own server variables must not overlap with app secrets
      // such as VAMPIRE_TOKEN. Our custom entrypoint owns host and port.
      envPrefix: 'VAMPIRE_ADAPTER_',
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
        'style-src': ['self', 'unsafe-inline'],
      },
    },
  },
};

export default config;
