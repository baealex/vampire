import assert from 'node:assert/strict';
import test from 'node:test';
import { originsMatch } from '../src/lib/server/origin.mjs';

test('accepts localhost aliases for a loopback origin', () => {
	assert.equal(originsMatch('http://localhost:7677', 'http://127.0.0.1:7677'), true);
	assert.equal(originsMatch('http://[::1]:7677', 'http://127.0.0.1:7677'), true);
});

test('requires the same protocol and port for loopback aliases', () => {
	assert.equal(originsMatch('https://localhost:7677', 'http://127.0.0.1:7677'), false);
	assert.equal(originsMatch('http://localhost:7678', 'http://127.0.0.1:7677'), false);
});

test('does not broaden a non-loopback origin', () => {
	assert.equal(originsMatch('http://localhost:7677', 'http://vampire.example.com:7677'), false);
	assert.equal(originsMatch('http://localhost:7677/path', 'http://127.0.0.1:7677'), false);
});
