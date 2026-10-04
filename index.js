/**
 * Host half of the prompt library.
 *
 * The plugin owns two pieces of state, both stored in its own Config so that
 * the Settings -> Prompts page can read and write them through
 * `ctx.remote.settings` (the `settings` service projects every `.volatile()`
 * field of a live profile entry):
 *
 *   - `prompts`   the library itself — `[{ id, title, text, byDefault }]`,
 *                 where `byDefault` starts a new session with the prompt on;
 *   - `selection` the per-session pick   — `{ [sessionId]: [promptId, ...] }`,
 *                 where an entry present but empty means "none here".
 *
 * Both fields are `.volatile()`, which makes `config.<field>` a frozen
 * reference whose `get()` is the value the owning runtime last accepted. A
 * write through the settings page updates that reference in place, so the
 * contribution below never has to be re-registered to see fresh state.
 *
 * Injection is one global **runtime-context** contribution whose text is
 * computed per assembly, and it deliberately is not a system-prompt section.
 *
 * A section would be the obvious channel for a standing instruction, but this
 * deployment prepares its model calls with `systemPromptUpdate: 'in-history'`:
 * the agent loop then *appends* the changed prompt after the cached history
 * instead of consolidating it into node 0, which is what keeps the prefix
 * reusable. The consequence for a section is that the previous system prompt —
 * the one still naming the prompt the user just unticked — stays in the request
 * with no statement superseding it, so the model goes on obeying it.
 *
 * Runtime context is built for exactly this: the loop keeps one retained
 * snapshot and replaces it whenever the rendered text changes, and clearing it
 * emits "Current runtime context: none. Earlier runtime-context snapshots no
 * longer apply." Ticking and unticking a prompt therefore take effect on the
 * next step, with no residue.
 *
 * `dsh-system-prompt` calls a contribution's text function with the assembly
 * context the agent loop built, and `dsh-agent` builds that context as
 * `{ agent, scope: agent }`, adding `signal` only when the run has one — so the
 * contribution can decide what to say from the agent it is being assembled for.
 * The provider below therefore reads `agent` through a defaulted argument
 * rather than assuming a context object is always passed.
 *
 * The text is delivered through a prompt variable rather than inline because
 * runtime-context text is always interpolated and, unlike a section, a context
 * has no `interpolate: false`. Inline text containing `{{…}}` would make
 * assembly throw and fail the whole turn; a variable's value is inserted
 * verbatim and never re-scanned, so user-authored text survives intact.
 *
 * Subagents inherit: a child session records its creator in the durable
 * `session.header.parentSession` field, so a session with no pick of its own
 * walks up that chain and adopts the nearest ancestor's pick. That covers
 * subagents and subagents of subagents without the client having to push
 * anything to them.
 */
import z from '@deepseek-ai/schemastery';

/**
 * Stable identity of the plugin. It is not the settings namespace: the
 * namespace is the profile entry id from `cordis.patch.yml` (`prompt-lib`),
 * which is what the client half addresses.
 */
const name = '@stmol/dsh-prompt-lib';

/**
 * Services this plugin cannot work without. Only `systemPrompt` is required —
 * it is the registry the context contribution lands in, and that contribution
 * is the whole point of the host half. `settings` and `agents` are requested
 * optionally inside `apply`, because a composition without them should still
 * load.
 */
const inject = ['systemPrompt'];

/**
 * Runtime-context placement. The repository's own contexts are the dynamic
 * per-session facts, ordered ascending: sandbox policy (110), approval policy
 * (115), subagent delegation (120). User prompts are the same kind of fact and
 * should have the last word, so this sits after all of them.
 */
const CONTEXT_ORDER = 200;

/** Name of the context contribution, unique in the global prompt layer. */
const CONTEXT_NAME = 'prompt-lib:user-prompts';

/**
 * Longest prompt body injected into the context, in characters.
 *
 * The browser half bounds the same field on input, but a hand-edited profile
 * bypasses that, and the whole library is re-sent on every model step — an
 * unbounded entry would ride every request. Truncating here keeps a malformed
 * document from making every turn expensive; text that came through the UI is
 * always inside the bound already.
 */
const MAX_PROMPT_TEXT = 8000;

/** Longest prompt library rendered into one snapshot. */
const MAX_PROMPTS = 100;

/**
 * Longest library scanned for one assembly, in entries.
 *
 * Both scans below — the defaults pass and the id lookup — run on *every* model
 * step, and the library is read straight out of the profile document, which a
 * hand edit can make arbitrarily large. The bound keeps one malformed document
 * from turning every turn into a walk over the whole thing; entries past it are
 * simply not resolvable, which is the same "a broken reference contributes
 * nothing" rule a dangling pick already follows. Nothing on disk is touched.
 */
const MAX_LIBRARY = 500;

/**
 * Prompt variable that carries the rendered prompts.
 *
 * The context below is the literal reference `{{prompt_lib_user_prompts}}` and
 * this variable supplies its value. Values are inserted verbatim and never
 * re-scanned for further references, which is what lets a prompt contain
 * `{{…}}` without failing assembly. The name must match `[a-z][a-z0-9_]*`.
 */
const VARIABLE = 'prompt_lib_user_prompts';

/**
 * Sentence rendered above the selected prompts. The harness already prefixes
 * the snapshot with "Current runtime context.", so this only has to state what
 * the block is, that it governs the work and not just the wording of a reply,
 * and how to resolve a conflict.
 *
 * "Apply them to every reply" was the earlier phrasing and it was too narrow:
 * a prompt such as "do not write unit tests" is a requirement on what the agent
 * *does* — which tools it calls, which files it writes — and a model that reads
 * the instruction as a reply-formatting rule can still go on writing the tests.
 * The sentence therefore names the work explicitly.
 */
const LEAD =
	'User-defined instructions for this session. Follow them throughout the work you ' +
	'do here — while planning, using tools, and changing files — not only when you ' +
	'write a reply. When two of them conflict, prefer the one listed last.';

/**
 * The plugin's stored configuration.
 *
 * `prompts` is a list of user-authored entries; `byDefault` marks the ones that
 * are ticked automatically in a session that has no pick of its own.
 * `selection` maps a session id to the ids the user ticked for that session;
 * sessions are addressed in a `dict` rather than a fixed object so the map can
 * grow without a schema edit.
 *
 * Both are `.volatile()`: schemastery permits volatile fields only on a fixed
 * object path, which is why the variable-length lists live *inside* two fixed
 * fields instead of the schema trying to describe per-element references.
 */
const Config = z.object({
	prompts: z
		.array(
			z.object({
				id: z.string().required(),
				title: z.string().required(),
				text: z.string().required(),
				// "Start every new session with this prompt ticked." Optional for
				// entries stored before the flag existed; only `true` enables it.
				byDefault: z.boolean().default(false),
			}),
		)
		.default([])
		.volatile(),
	selection: z.dict(z.array(z.string())).default({}).volatile(),
});

/**
 * The stored value of a volatile field, defensively.
 *
 * A reference returns exactly what the runtime accepted, but an older profile
 * patch or a hand edit can still leave `undefined` or a non-object behind, and
 * a prompt assembly that throws takes the whole turn down with it. Every read
 * here therefore falls back to an empty list rather than trusting the shape.
 *
 * @param reference - a volatile config reference.
 * @returns the reference's value when it is an array, otherwise `[]`.
 */
function arrayOf(reference) {
	const value = reference?.get();
	return Array.isArray(value) ? value : [];
}

/**
 * A prompt's stored id, trimmed, or the empty string when it has none.
 *
 * The browser half writes ids trimmed, so a hand-edited id carrying whitespace
 * has to be trimmed here too — otherwise a session's pick names an id the
 * library never resolves, and the prompt silently never injects.
 *
 * @param prompt - one library entry, of unknown shape.
 * @returns the entry's id, trimmed, or `''`.
 */
function idOf(prompt) {
	if (prompt === null || typeof prompt !== 'object') return '';
	return typeof prompt.id === 'string' ? prompt.id.trim() : '';
}

/**
 * The stored selection map.
 * @param config - the resolved plugin config.
 * @returns the session-id map, or an empty object when it is absent.
 */
function selectionMap(config) {
	const value = config.selection?.get();
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * The parent of a session, when it has one.
 *
 * `agent.session` is live for the session being assembled; ancestors are
 * reached through the agent registry, which holds every session the current
 * runtime created. An ancestor that is no longer live ends the walk — a pick
 * cannot be inherited from a session that is not there to be read, and
 * guessing would be worse than stopping.
 *
 * @param registry - accessor cell holding the agent registry, which is filled
 *   only once the `agents` service is mounted.
 * @param sessionId - the session whose creator is wanted.
 * @param header - the already-known header of `sessionId`, when the caller has it.
 * @returns the parent session id, or undefined at a runtime root.
 */
function parentOf(registry, sessionId, header) {
	const direct = header ?? registry.agents?.get(sessionId)?.session?.header;
	const parent = direct?.parentSession;
	return typeof parent === 'string' && parent !== '' ? parent : undefined;
}

/**
 * The prompts that ask to start enabled.
 *
 * The flag is read leniently: an entry stored before it existed simply is not a
 * default, and a hand-edited value has to be exactly `true` to count.
 *
 * @param config - the resolved plugin config.
 * @returns the ids of the default prompts, in library order.
 */
function defaultIds(config) {
	const library = arrayOf(config.prompts);
	const ids = [];
	const limit = Math.min(library.length, MAX_LIBRARY);
	for (let index = 0; index < limit; index += 1) {
		const prompt = library[index];
		if (prompt === null || typeof prompt !== 'object') continue;
		if (prompt.byDefault !== true) continue;
		const id = idOf(prompt);
		if (id === '') continue;
		ids.push(id);
	}
	return ids;
}

/**
 * Resolve which prompts are in force for a session.
 *
 * A session's own pick wins outright, and an *empty* pick is a pick: it is what
 * the client records when the last ticked prompt is unticked, and reading it as
 * "did not choose" would hand the library's defaults straight back to a session
 * that just said no to them. Only a session with no entry at all inherits, and
 * then from the nearest ancestor that has one — so a subagent that has never
 * been touched follows its parent.
 *
 * A lineage with no entry anywhere falls back to the library's own defaults:
 * the prompts the user marked to start enabled in every new session. That is
 * the same fallback the composer picker shows, so a fresh chat displays exactly
 * what it is about to inject.
 *
 * The seen-set guards against a malformed or hand-edited lineage cycle; the
 * walk is bounded by the number of distinct sessions it has visited.
 *
 * @param registry - accessor cell holding the agent registry.
 * @param config - the resolved plugin config.
 * @param session - the session being assembled for.
 * @returns the selected prompt ids, nearest ancestor first.
 */
function effectiveIds(registry, config, session) {
	const selection = selectionMap(config);
	const seen = new Set();
	let id = typeof session?.id === 'string' ? session.id : undefined;
	let header = session?.header;
	while (typeof id === 'string' && id !== '' && !seen.has(id)) {
		seen.add(id);
		const chosen = selection[id];
		if (Array.isArray(chosen)) return chosen;
		const parent = parentOf(registry, id, header);
		header = undefined;
		id = parent;
	}
	return defaultIds(config);
}

/**
 * Render the enabled prompts as the runtime-context body.
 *
 * An entry that has been deleted from the library but is still named by a
 * session's pick is skipped rather than rendered as a dangling id — the pick is
 * a set of references, and a broken reference simply contributes nothing.
 *
 * @param registry - accessor cell holding the agent registry.
 * @param config - the resolved plugin config.
 * @param session - the session being assembled for.
 * @returns the context body, or an empty string when nothing is enabled.
 */
function renderPrompts(registry, config, session) {
	const chosen = effectiveIds(registry, config, session);
	if (chosen.length === 0) return '';
	const library = arrayOf(config.prompts);
	const byId = new Map();
	const limit = Math.min(library.length, MAX_LIBRARY);
	for (let index = 0; index < limit; index += 1) {
		const prompt = library[index];
		const id = idOf(prompt);
		if (id !== '') byId.set(id, prompt);
	}
	const blocks = [];
	for (const chosenId of chosen) {
		if (blocks.length >= MAX_PROMPTS) break;
		const prompt = typeof chosenId === 'string' ? byId.get(chosenId.trim()) : undefined;
		if (prompt === undefined) continue;
		const text = typeof prompt.text === 'string' ? prompt.text.trim().slice(0, MAX_PROMPT_TEXT) : '';
		if (text === '') continue;
		// Only the instruction is injected. The title is a label for the user —
		// the Settings list and the composer picker use it to make a prompt
		// findable — so it is not part of what the model reads. Blocks stay
		// separated by a blank line so several enabled prompts remain
		// distinguishable without a heading.
		blocks.push(text);
	}
	if (blocks.length === 0) return '';
	return `${LEAD}\n\n${blocks.join('\n\n')}`;
}

/**
 * Register the prompt context contribution and claim this plugin's settings-page policy.
 *
 * The policy is `auto: false` because the bundle ships its own Prompts page:
 * without it the Plugins screen would additionally offer a schema-generated
 * form for the same two fields. Registering the policy does not restrict
 * reads or writes — the page still goes through `ctx.remote.settings`.
 *
 * @param ctx - the plugin context.
 * @param config - the resolved plugin config, carrying the volatile references.
 */
function apply(ctx, config) {
	// Both services are optional so that the plugin still loads in a minimal
	// composition: without `settings` the stored library simply cannot be
	// edited from the UI, and without `agents` only the session's own pick
	// counts and nested subagents stop inheriting.
	//
	// The callbacks are reached through accessor cells rather than `ctx.<name>`
	// because a service that was never requested from the container cannot be
	// read off the context at all.
	const registry = { agents: undefined };
	ctx.inject(['agents'], (scope) => {
		registry.agents = scope.agents;
		scope.effect(
			() => () => {
				registry.agents = undefined;
			},
			'dsh-prompt-lib: agent registry',
		);
	});

	ctx.inject(['settings'], (child) => {
		child.effect(
			() => child.settings.configure({ auto: false }, ctx.fiber),
			'dsh-prompt-lib: settings page policy',
		);
	});

	// The variable is what the context references, so it must exist before any
	// assembly runs; both are registered as effects, which means they are
	// disposed and re-registered together whenever the config changes shape.
	ctx.effect(
		() => ctx.systemPrompt.variable(VARIABLE, ({ agent } = {}) => renderPrompts(registry, config, agent?.session)),
		'dsh-prompt-lib: prompts variable',
	);

	ctx.effect(
		() =>
			ctx.systemPrompt.context({
				name: CONTEXT_NAME,
				order: CONTEXT_ORDER,
				text: `{{${VARIABLE}}}`,
			}),
		'dsh-prompt-lib: prompts context',
	);
}

export { Config, apply, defaultIds, effectiveIds, inject, name, renderPrompts };
