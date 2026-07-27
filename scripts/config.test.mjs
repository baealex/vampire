import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureAdapterOrigin, runtimeConfig } from './config.mjs';

test('defaults the adapter origin for local IPv4 binding', () => {
	const env = {};
	const config = runtimeConfig(env);

	ensureAdapterOrigin(config, env);

	assert.equal(env.VAMPIRE_ADAPTER_ORIGIN, 'http://127.0.0.1:7677');
});

test('formats local host and port in the default adapter origin', () => {
	const env = { VAMPIRE_HOST: 'localhost', VAMPIRE_PORT: '8080' };
	const config = runtimeConfig(env);

	ensureAdapterOrigin(config, env);

	assert.equal(env.VAMPIRE_ADAPTER_ORIGIN, 'http://localhost:8080');
});

test('brackets a local IPv6 adapter origin', () => {
	const env = { VAMPIRE_HOST: '::1', VAMPIRE_PORT: '8080' };
	const config = runtimeConfig(env);

	ensureAdapterOrigin(config, env);

	assert.equal(env.VAMPIRE_ADAPTER_ORIGIN, 'http://[::1]:8080');
});

test('preserves an explicitly configured adapter origin', () => {
	const env = {
		VAMPIRE_ADAPTER_ORIGIN: 'https://vampire.example.com'
	};
	const config = runtimeConfig(env);

	ensureAdapterOrigin(config, env);

	assert.equal(env.VAMPIRE_ADAPTER_ORIGIN, 'https://vampire.example.com');
});

test('does not invent an adapter origin for a remote bind', () => {
	const env = {
		VAMPIRE_HOST: '0.0.0.0',
		VAMPIRE_TOKEN: 'test-token'
	};
	const config = runtimeConfig(env);

	ensureAdapterOrigin(config, env);

	assert.equal(env.VAMPIRE_ADAPTER_ORIGIN, undefined);
});
