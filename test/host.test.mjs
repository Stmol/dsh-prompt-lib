/**
 * Host-half tests.
 *
 * These cover the rules that are easy to get wrong and expensive to get wrong:
 * which prompts a session ends up injecting, how the ancestry walk behaves, and
 * the two shapes the host must never emit — `undefined` (a variable with no
 * value fails the whole assembly) and an unbounded body.
 *
 * Run with `node --test test/` or `npm test`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Config, apply, defaultIds, effectiveIds, renderPrompts } from '../index.js';

/** The sentence the host renders above the selected prompts. */
const LEAD =
	'User-defined instructions for this session. Follow them throughout the work you do here — while planning, using tools, and changing files — not only when you write a reply. When two of them conflict, prefer the one listed last.';

/** A realistic library: two plain entries and one marked as a default. */
const LIBRARY = [
	{ id: 'p1', title: 'English', text: 'Always answer in English' },
	{ id: 'p2', title: 'Braces', text: 'Use {{templates}} like {{ this }}' },
	{ id: 'p3', title: 'Russian', text: 'Always answer in Russian', byDefault: true },
];

/**
 * A resolved-config stand-in: each field is the volatile reference the loader builds.
 * @param fields - the stored `prompts` and `selection` values.
 * @returns an object shaped like the plugin's resolved config.
 */
function configOf({ prompts = [], selection = {} } = {}) {
	return {
		prompts: { get: () => prompts },
		selection: { get: () => selection },
	};
}

/**
 * An agent-registry stand-in.
 * @param headers - session id -> the header the registry answers for it.
 * @returns an accessor cell holding a registry.
 */
function registryOf(headers = {}) {
	return {
		agents: {
			get: (id) => (Object.hasOwn(headers, id) ? { session: { header: headers[id] } } : undefined),
		},
	};
}

/**
 * Run `apply` against a recording context.
 * @param config - the config to hand the plugin.
 * @returns the recorded registrations.
 */
function register(config) {
	const calls = { injected: [], variable: [], context: [], section: [] };
	const ctx = {
		fiber: {},
		// Effects run on the spot, as they do on a live context; the disposer they
		// return is not part of what these tests observe.
		effect: (fn) => fn(),
		inject: (names) => {
			calls.injected.push(names);
		},
		systemPrompt: {
			variable: (name, provider) => {
				calls.variable.push([name, provider]);
				return () => {};
			},
			context: (contribution) => {
				calls.context.push(contribution);
				return () => {};
			},
			section: (section) => {
				calls.section.push(section);
				return () => {};
			},
		},
	};
	apply(ctx, config);
	return calls;
}

test('Config resolves to volatile references with empty defaults', () => {
	const resolved = Config({});
	assert.equal(typeof resolved.prompts.get, 'function');
	assert.equal(typeof resolved.selection.get, 'function');
	assert.deepEqual(resolved.prompts.get(), []);
	assert.deepEqual(resolved.selection.get(), {});
});

test('renderPrompts renders the picked prompts and skips what cannot resolve', () => {
	const config = configOf({
		prompts: [...LIBRARY, { id: 'p4', title: 'Blank', text: '   ' }],
		selection: { s1: ['p4', 'missing', 'p1', 'p2'] },
	});
	const text = renderPrompts(registryOf(), config, { id: 's1' });
	// Blank bodies and dangling ids contribute nothing; `{{…}}` in a prompt body
	// is delivered verbatim, which is the whole reason the payload rides a variable.
	assert.equal(text, `${LEAD}\n\nAlways answer in English\n\nUse {{templates}} like {{ this }}`);
});

test('an empty pick injects nothing instead of handing the defaults back', () => {
	const config = configOf({ prompts: LIBRARY, selection: { s1: [] } });
	assert.equal(renderPrompts(registryOf(), config, { id: 's1' }), '');
});

test('a pick naming only deleted prompts injects nothing', () => {
	const config = configOf({ prompts: LIBRARY, selection: { s1: ['gone'] } });
	assert.equal(renderPrompts(registryOf(), config, { id: 's1' }), '');
});

test('a lineage with no pick anywhere falls back to the library defaults', () => {
	const config = configOf({ prompts: LIBRARY });
	assert.equal(renderPrompts(registryOf(), config, { id: 'fresh' }), `${LEAD}\n\nAlways answer in Russian`);
});

test('a subagent adopts the nearest ancestor that has a pick', () => {
	const config = configOf({ prompts: LIBRARY, selection: { parent: ['p1'] } });
	const registry = registryOf({ parent: { parentSession: 'root' } });
	assert.equal(renderPrompts(registry, config, { id: 'child', header: { parentSession: 'parent' } }), `${LEAD}\n\nAlways answer in English`);
});

test('the nearest ancestor wins over a farther one', () => {
	const config = configOf({ prompts: LIBRARY, selection: { mid: ['p2'], root: ['p1'] } });
	const registry = registryOf({ mid: { parentSession: 'root' } });
	assert.deepEqual(effectiveIds(registry, config, { id: 'child', header: { parentSession: 'mid' } }), ['p2']);
});

test('an empty pick on an ancestor stops the walk rather than climbing past it', () => {
	const config = configOf({ prompts: LIBRARY, selection: { parent: [], root: ['p1'] } });
	const registry = registryOf({ parent: { parentSession: 'root' } });
	assert.deepEqual(effectiveIds(registry, config, { id: 'child', header: { parentSession: 'parent' } }), []);
});

test('a lineage cycle terminates at the defaults', () => {
	const config = configOf({ prompts: LIBRARY });
	const registry = registryOf({ a: { parentSession: 'b' }, b: { parentSession: 'a' } });
	assert.deepEqual(effectiveIds(registry, config, { id: 'a' }), ['p3']);
});

test('ids are trimmed on both sides of the lookup', () => {
	const padded = [{ id: ' p1 ', title: 'Padded', text: 'Padded body', byDefault: true }];
	assert.deepEqual(defaultIds(configOf({ prompts: padded })), ['p1']);
	// The defaults path and a stored pick that names the untrimmed id both resolve.
	const byDefault = configOf({ prompts: padded });
	assert.equal(renderPrompts(registryOf(), byDefault, { id: 's' }), `${LEAD}\n\nPadded body`);
	const picked = configOf({ prompts: padded, selection: { s: [' p1 '] } });
	assert.equal(renderPrompts(registryOf(), picked, { id: 's' }), `${LEAD}\n\nPadded body`);
});

test('an over-long prompt body is truncated to the injected bound', () => {
	const config = configOf({
		prompts: [{ id: 'p1', title: 'Long', text: 'a'.repeat(9000) }],
		selection: { s: ['p1'] },
	});
	assert.equal(renderPrompts(registryOf(), config, { id: 's' }), `${LEAD}\n\n${'a'.repeat(8000)}`);
});

test('no more than the bounded number of prompts is injected', () => {
	const many = Array.from({ length: 120 }, (_, index) => ({
		id: `p${index}`,
		title: `Prompt ${index}`,
		text: `body${index}`,
	}));
	const config = configOf({ prompts: many, selection: { s: many.map((prompt) => prompt.id) } });
	const blocks = renderPrompts(registryOf(), config, { id: 's' }).split('\n\n').slice(1);
	assert.equal(blocks.length, 100);
	assert.equal(blocks[0], 'body0');
	assert.equal(blocks[99], 'body99');
});

test('a library is only scanned up to the bound, so entries past it never resolve', () => {
	/** @param marked - index of the one entry flagged as a default. */
	const libraryOf = (marked) =>
		Array.from({ length: 700 }, (_, index) => ({
			id: `p${index}`,
			title: `Prompt ${index}`,
			text: `body${index}`,
			byDefault: index === marked,
		}));
	// Just inside the 500-entry scan bound: still a default.
	assert.deepEqual(defaultIds(configOf({ prompts: libraryOf(499) })), ['p499']);
	// Past it: the entry is not reachable at all, so the library contributes
	// nothing rather than making every step walk the whole document.
	assert.deepEqual(defaultIds(configOf({ prompts: libraryOf(600) })), []);
	assert.equal(renderPrompts(registryOf(), configOf({ prompts: libraryOf(600) }), { id: 's' }), '');
	// A pick naming an unreachable entry is the same dangling reference it would
	// be for a deleted prompt.
	const picked = configOf({ prompts: libraryOf(600), selection: { s: ['p600'] } });
	assert.equal(renderPrompts(registryOf(), picked, { id: 's' }), '');
});

test('a malformed library reads as empty instead of throwing', () => {
	const broken = { prompts: { get: () => null }, selection: { get: () => [] } };
	assert.deepEqual(defaultIds(broken), []);
	assert.deepEqual(effectiveIds(registryOf(), broken, { id: 's' }), []);
	assert.equal(renderPrompts(registryOf(), broken, { id: 's' }), '');
});

test('the variable provider never answers undefined, even without an agent', () => {
	const calls = register(configOf({ prompts: [{ id: 'p1', title: 'Plain', text: 'body' }] }));
	const provider = calls.variable[0][1];
	// `interpolate` throws on an undefined variable value, which would fail the
	// whole turn, so every path has to answer with a string.
	for (const context of [{}, { agent: undefined }, { agent: { session: { id: 's1' } } }, undefined]) {
		assert.equal(typeof provider(context), 'string');
		assert.equal(provider(context), '');
	}
});

test('apply registers one variable and one context, never a system-prompt section', () => {
	const calls = register(configOf({ prompts: LIBRARY, selection: { s1: ['p1'] } }));
	assert.deepEqual(calls.section, []);
	assert.deepEqual(calls.variable.map(([name]) => name), ['prompt_lib_user_prompts']);
	assert.deepEqual(calls.context, [
		{ name: 'prompt-lib:user-prompts', order: 200, text: '{{prompt_lib_user_prompts}}' },
	]);
	// Both optional services are requested through `inject`, so a composition
	// without them still loads.
	assert.deepEqual(calls.injected, [['agents'], ['settings']]);
	const provider = calls.variable[0][1];
	assert.equal(provider({ agent: { session: { id: 's1' } } }), `${LEAD}\n\nAlways answer in English`);
});
