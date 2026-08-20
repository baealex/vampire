import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStatusPluginOutput } from '../src/lib/server/status-plugin-output.ts';

test('parses SwiftBar-style plain output into a generic menu', () => {
	assert.deepEqual(parseStatusPluginOutput([
		'\u001b[32m42%\u001b[0m | tooltip="Current usage" tone=warning progress=42',
		'---',
		'Weekly | value=61% badge=plan checked=true',
		'--Usage dashboard | href=https://example.com/usage',
		'---',
		'Resets Friday'
	].join('\n')), {
		text: '42%',
		tooltip: 'Current usage',
		menu: [
			{ type: 'item', text: 'Weekly', value: '61%', badge: 'plan', checked: true },
			{ type: 'item', text: 'Usage dashboard', href: 'https://example.com/usage', indent: 1 },
			{ type: 'separator' },
			{ type: 'item', text: 'Resets Friday' }
		],
		progress: 42,
		tone: 'warning'
	});
});

test('parses bounded generic menu output', () => {
	assert.deepEqual(parseStatusPluginOutput(JSON.stringify({
		text: '18%',
		tooltip: 'Current plan usage',
		menu: [
			{ type: 'heading', text: 'Codex', badge: 'Overall' },
			{
				type: 'item',
				text: '5h',
				value: '18% used',
				detail: 'Shared window',
				time: { label: 'Resets', at: 1_787_225_200 },
				progress: 18,
				tone: 'success'
			},
			{ type: 'separator' },
			{ type: 'item', text: 'Usage dashboard', href: 'https://example.com/usage' }
		],
		progress: 18,
		tone: 'success'
	})), {
		text: '18%',
		tooltip: 'Current plan usage',
		menu: [
			{ type: 'heading', text: 'Codex', badge: 'Overall' },
			{
				type: 'item',
				text: '5h',
				value: '18% used',
				detail: 'Shared window',
				time: { label: 'Resets', at: 1_787_225_200_000 },
				progress: 18,
				tone: 'success'
			},
			{ type: 'separator' },
			{ type: 'item', text: 'Usage dashboard', href: 'https://example.com/usage' }
		],
		progress: 18,
		tone: 'success'
	});
});

test('rejects empty and invalid structured output', () => {
	assert.throws(() => parseStatusPluginOutput(' \n\u001b[0m '), /no output/i);
	assert.throws(() => parseStatusPluginOutput('{"text":"ok","progress":120}'), /structured output/i);
	assert.throws(() => parseStatusPluginOutput('{"text":"ok","menu":[{"type":"item","text":"Docs","href":"javascript:alert(1)"}]}'), /structured output/i);
	assert.throws(() => parseStatusPluginOutput('{"detail":"missing text"}'), /no output/i);
});
