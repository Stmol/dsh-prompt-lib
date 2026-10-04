/**
 * Browser half of the prompt library.
 *
 * Two surfaces share one store:
 *
 *   - a **Prompts** page in Settings (`settings.section`) that creates,
 *     edits and deletes the stored prompts;
 *   - a **picker** in the composer tool row (`conversation.input.left`,
 *     rendered immediately after the permissions control) that ticks which
 *     of those prompts are injected into the current session.
 *
 * Both read and write the plugin's own Config through the host's `settings`
 * remote. The namespace is the profile entry id from `cordis.patch.yml`
 * (`prompt-lib`), which is the same convention the shipped
 * `dsh-client-ui-permission-presets` plugin follows with its literal
 * `"permission"` namespace.
 *
 * The picker is keyed by the current `sessionId`, and the host walks
 * `session.header.parentSession` when a session has no pick of its own, so a
 * subagent inherits the pick of the session that spawned it.
 */
window.__ModuleLoader__.load({
	id: '@stmol/dsh-prompt-lib',
	factory(require) {
		const React = require('react');
		const ReactDOM = require('react-dom');
		const h = React.createElement;

		/** Locale namespace of this plugin's dictionaries. */
		const NS = 'dsh-prompt-lib';

		/**
		 * Settings namespace of the plugin: the id of its entry in the profile
		 * patch. Kept in one place because `cordis.patch.yml` has to agree.
		 */
		const ENTRY_ID = 'prompt-lib';

		/**
		 * The prompt text field is the only place a user writes free-form text
		 * that reaches the model verbatim, so the length is bounded on the way
		 * in rather than left to the schema to reject after a round trip.
		 */
		const MAX_TITLE = 120;
		const MAX_TEXT = 8000;

		/**
		 * Object keys a value must never be used as.
		 *
		 * A session id is the only caller-supplied string that reaches a settings
		 * document path — `['selection', sessionId]` — so an id naming an object
		 * prototype is refused rather than handed to the host, which resolves that
		 * path against a plain object.
		 */
		const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

		/**
		 * Whether a session id can address a stored pick.
		 *
		 * Without the guard a picker rendered without a session id would record
		 * its choice under the literal key `"undefined"`, where nothing would ever
		 * read it again; a reserved key is a path segment the host must not have
		 * to defend against.
		 *
		 * @param sessionId - the session the picker is being rendered for.
		 * @returns true when the id may be used as a settings path segment.
		 */
		function addressableSessionId(sessionId) {
			return typeof sessionId === 'string' && sessionId !== '' && !RESERVED_KEYS.has(sessionId);
		}

		/**
		 * Stable ids for new prompts. The library is keyed by id, not by title,
		 * so renaming a prompt never detaches a session's pick from it.
		 */
		function newId() {
			const random =
				typeof window.crypto?.randomUUID === 'function'
					? window.crypto.randomUUID()
					: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
			return `p_${random}`;
		}

		/** Sentinel meaning "the editor is creating rather than editing". */
		const NEW_PROMPT = '__new__';

		/**
		 * Sentinel in `confirming` meaning "the whole library, not one row". The
		 * per-row confirmation is keyed by prompt id, and a prompt id can never
		 * collide with this literal because ids are `p_`-prefixed.
		 */
		const DELETE_ALL = '__all__';

		/** Panel texts; `en` is the shipped UI language and `ru` the installed pack. */
		const DICTIONARIES = {
			en: {
				'nav': 'Prompts',
				'section.title': 'Prompts',
				'section.intro':
					'Reusable instructions you switch on per session; ticked prompts join that session and its subagents.',
				'section.empty': 'No prompts yet \u2014 add one above, then tick it in the chat composer.',
				'section.add': 'Add prompt',
				'section.titleLabel': 'Title',
				'section.titlePlaceholder': 'Prompt short name',
				'section.textLabel': 'Instruction',
				'section.textPlaceholder': 'Add your custom instructions\u2026',
				'section.save': 'Save',
				'section.cancel': 'Cancel',
				'section.byDefault': 'Enable in every new chat',
				'section.byDefaultHint': 'New chats start with this prompt selected',
				'section.edit': 'Edit',
				'section.delete': 'Delete',
				'section.deleteAll': 'Delete all',
				'section.deleteConfirm': 'Delete this prompt?',
				'section.confirmYes': 'Delete',
				'section.confirmNo': 'Keep',
				'section.titleRequired': 'A title is required.',
				'section.textRequired': 'An instruction is required.',
				'section.loading': 'Loading\u2026',
				'section.unavailable': 'Settings are not available in this profile: {reason}',
				'section.readOnly': 'This profile\u2019s settings file is read-only, so prompts cannot be saved.',
				'section.unbound': 'Settings are not available in this profile.',
				'section.saveError': 'Could not save: {reason}',
				'picker.label': 'Prompts',
				'picker.empty': 'No prompts stored yet.',
				'picker.emptyHint': 'Create them in Settings \u2192 Prompts.',
				'picker.noMatches': 'No prompts match.',
				'picker.clear': 'Clear',
				'picker.search': 'Search prompts\u2026',
				'picker.searchClear': 'Clear the search',
				'picker.unavailable': 'Settings are not available in this profile.',
				'picker.error': 'Could not save: {reason}',
			},
			ru: {
				'nav': 'Промпты',
				'section.title': 'Промпты',
				'section.intro':
					'Многоразовые инструкции для отдельных сессий: отмеченные промпты добавляются в контекст сессии и её субагентов.',
				'section.empty': 'Промптов пока нет \u2014 добавьте промпт выше и отметьте его в композере чата.',
				'section.add': 'Добавить промпт',
				'section.titleLabel': 'Название',
				'section.titlePlaceholder': 'Короткое название промпта',
				'section.textLabel': 'Инструкция',
				'section.textPlaceholder': 'Добавьте свои инструкции\u2026',
				'section.save': 'Сохранить',
				'section.cancel': 'Отмена',
				'section.byDefault': 'Включать в каждом новом чате',
				'section.byDefaultHint': 'Новые чаты начинаются с этим промптом',
				'section.edit': 'Изменить',
				'section.delete': 'Удалить',
				'section.deleteAll': 'Удалить все',
				'section.deleteConfirm': 'Удалить этот промпт?',
				'section.confirmYes': 'Удалить',
				'section.confirmNo': 'Оставить',
				'section.titleRequired': 'Нужно название.',
				'section.textRequired': 'Нужна инструкция.',
				'section.loading': 'Загрузка\u2026',
				'section.unavailable': 'Настройки недоступны в этом профиле: {reason}',
				'section.readOnly': 'Файл настроек профиля доступен только для чтения — промпты не сохранятся.',
				'section.unbound': 'Настройки недоступны в этом профиле.',
				'section.saveError': 'Не удалось сохранить: {reason}',
				'picker.label': 'Промпты',
				'picker.empty': 'Промпты ещё не созданы.',
				'picker.emptyHint': 'Создайте их в Настройки \u2192 Промпты.',
				'picker.noMatches': 'Ничего не найдено.',
				'picker.clear': 'Сбросить',
				'picker.search': 'Поиск промптов\u2026',
				'picker.searchClear': 'Очистить поиск',
				'picker.unavailable': 'Настройки недоступны в этом профиле.',
				'picker.error': 'Не удалось сохранить: {reason}',
			},
		};

		/** Class names, prefixed so they cannot collide with the shell's styles. */
		const css = {
			// composer picker
			anchor: 'dshPromptLib_anchor',
			trigger: 'dshPromptLib_trigger',
			triggerQuiet: 'dshPromptLib_triggerQuiet',
			triggerIcon: 'dshPromptLib_triggerIcon',
			triggerLabel: 'dshPromptLib_triggerLabel',
			badge: 'dshPromptLib_badge',
			chevron: 'dshPromptLib_chevron',
			chevronOpen: 'dshPromptLib_chevronOpen',
			panel: 'dshPromptLib_panel',
			panelMaterial: 'dshPromptLib_panelMaterial',
			searchRow: 'dshPromptLib_searchRow',
			search: 'dshPromptLib_search',
			searchWithQuery: 'dshPromptLib_searchWithQuery',
			searchIcon: 'dshPromptLib_searchIcon',
			searchInput: 'dshPromptLib_searchInput',
			searchClear: 'dshPromptLib_searchClear',
			viewport: 'dshPromptLib_viewport',
			list: 'dshPromptLib_list',
			option: 'dshPromptLib_option',
			optionCopy: 'dshPromptLib_optionCopy',
			optionTitle: 'dshPromptLib_optionTitle',
			optionPreview: 'dshPromptLib_optionPreview',
			optionCheck: 'dshPromptLib_optionCheck',
			panelFooter: 'dshPromptLib_panelFooter',
			linkButton: 'dshPromptLib_linkButton',
			note: 'dshPromptLib_note',
			noteWarn: 'dshPromptLib_noteWarn',
			// settings page
			page: 'dshPromptLib_page',
			heading: 'dshPromptLib_heading',
			headerActions: 'dshPromptLib_headerActions',
			intro: 'dshPromptLib_intro',
			rows: 'dshPromptLib_rows',
			rowCard: 'dshPromptLib_rowCard',
			// The open editor keeps the row card's stroke, radius and padding but
			// takes the Models page's module-platform fill, so it reads as a form
			// surface rather than as another stored row.
			formCard: 'dshPromptLib_formCard',
			rowHead: 'dshPromptLib_rowHead',
			rowName: 'dshPromptLib_rowName',
			rowText: 'dshPromptLib_rowText',
			rowTextWrap: 'dshPromptLib_rowTextWrap',
			rowTextFade: 'dshPromptLib_rowTextFade',
			rowActions: 'dshPromptLib_rowActions',
			editor: 'dshPromptLib_editor',
			field: 'dshPromptLib_field',
			fieldLabel: 'dshPromptLib_fieldLabel',
			input: 'dshPromptLib_input',
			textarea: 'dshPromptLib_textarea',
			primaryButton: 'dshPromptLib_primaryButton',
			secondaryButton: 'dshPromptLib_secondaryButton',
			dangerButton: 'dshPromptLib_dangerButton',
			deleteButton: 'dshPromptLib_deleteButton',
			formActions: 'dshPromptLib_formActions',
			formToggle: 'dshPromptLib_formToggle',
			switch: 'dshPromptLib_switch',
			switchThumb: 'dshPromptLib_switchThumb',
			switchLabel: 'dshPromptLib_switchLabel',
			error: 'dshPromptLib_error',
			pageNote: 'dshPromptLib_pageNote',
			empty: 'dshPromptLib_empty',
		};

		/**
		 * The plugin's one dropdown style, copied from the shell's own controls
		 * rather than invented here.
		 *
		 * The **trigger** is the composer row's scale, byte for byte the one the
		 * permissions and model controls use: 28px high, `--dsw-radius-sm`,
		 * `0 4px 0 8px` padding, a 4px gap, `--dsw-alias-label-secondary` at rest
		 * and the plain hover fill. Its label stays at that secondary colour in
		 * every state; only the "none" suffix is muted to `--dsw-alias-label-caption`,
		 * so an empty picker is still readable.
		 *
		 * The **card** is `MenuSurface` plus `dsh-client-ui-model-selection`'s
		 * `.menu`: `--dsw-radius-lg`, 4px of padding, `--dsw-elevation-prominent`
		 * over an l1 stroke rebind, and the translucent menu material on a child
		 * that paints `--dsw-menu-surface-fill` under
		 * `--dsw-menu-backdrop-filter`. Painting the material as its own layer —
		 * instead of a flat background on the card — is what every shell menu
		 * does, and it is why the card matches them; `overflow:hidden` clips the
		 * layer to the radius.
		 *
		 * The **rows** are `.cell` (a titled row) and `.option` (a row with a
		 * supporting line) from that same menu: `--dsw-radius-md`, 13px/20px at
		 * the inherited weight, the standard hover fill, and the shared
		 * `IconCheckOutline` glyph in `--dsw-alias-label-primary` pinned to the
		 * trailing edge.
		 *
		 * Every colour is an alias token and every size an `--dsw-font-*` or
		 * `--dsw-radius-*` token, so light and dark need no separate rules.
		 */
		const STYLES = [
			// --- composer picker -------------------------------------------------
			'.dshPromptLib_anchor{min-width:0;display:inline-flex}',
			`.dshPromptLib_trigger{border-radius:var(--dsw-radius-sm);min-width:0;max-width:220px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:400;line-height:20px;display:inline-flex;font-family:inherit}`,
			`.dshPromptLib_trigger:hover,.dshPromptLib_trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}`,
			`.dshPromptLib_trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}`,
			// Nothing ticked: the icon and label drop to the same muted tier the
			// model control gives its effort value. Ticked, they stay secondary.
			`.dshPromptLib_triggerQuiet{color:var(--dsw-alias-label-caption)}`,
			'.dshPromptLib_triggerIcon{flex:none;display:inline-flex;align-items:center}',
			'.dshPromptLib_triggerIcon svg{width:16px;height:16px}',
			'.dshPromptLib_triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
			`.dshPromptLib_badge{color:var(--dsw-alias-label-caption);border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-interactive-bg-hover);padding:0 5px;font-size:11px;font-weight:500;line-height:16px;font-variant-numeric:tabular-nums;flex:none}`,
			`.dshPromptLib_chevron{color:var(--dsw-alias-label-caption);transition:transform .12s;flex:none;display:inline-flex}`,
			`.dshPromptLib_chevronOpen{transform:rotate(180deg)}`,
			`.dshPromptLib_panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);width:max-content;min-width:min(240px,100vw - 32px);max-width:min(420px,100vw - 32px);max-height:min(360px,100vh - 96px);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);cursor:default;border:0;flex-direction:column;padding:4px;display:flex;position:fixed;overflow:hidden;font-family:inherit}`,
			// The card's border is the elevated surface's own stroke: a 0.5px hairline
			// that `--dsw-elevation-prominent` draws through
			// `--dsw-elevation-stroke-color`. The panel carries
			// `data-menu-material`, the attribute `MenuSurface` puts on every menu, so
			// the theme rebinds that stroke to `--dsw-alias-border-l3` exactly as it
			// does for the model menu; light menus keep the darker derived `border-l4`.
			// The first version pointed the stroke at l1 by hand, which is why the
			// card had no visible edge.
			`.dshPromptLib_panelMaterial{position:absolute;inset:0;z-index:-1;border-radius:inherit;background:var(--dsw-menu-surface-fill);backdrop-filter:var(--dsw-menu-backdrop-filter);pointer-events:none}`,
			// The search row is the model menu's own: a field in a rounded wrapper
			// above the list, with 12px text, and a clear button overlaid on the
			// wrapper's trailing edge rather than laid out beside the field — so the
			// field keeps its full width and the button never displaces it. The row
			// resets `display` and `flex-direction` because the card is a column
			// flex container and would otherwise stack the two.
			'.dshPromptLib_searchRow{position:relative;flex-shrink:0;margin:2px 0 3px;flex-direction:row;display:flex}',
			'.dshPromptLib_search{border-radius:var(--dsw-radius-md);box-sizing:border-box;width:100%;height:32px;background:0 0;border:.5px solid var(--dsw-alias-border-l4);align-items:center;gap:6px;padding:0 7px;display:flex}',
			'.dshPromptLib_search:focus-within{border-color:var(--dsw-alias-state-business-primary)}',
			'.dshPromptLib_searchWithQuery{padding-right:34px}',
			'.dshPromptLib_searchIcon{color:var(--dsw-alias-label-tertiary);flex:none;display:inline-flex}',
			'.dshPromptLib_searchIcon svg{width:14px;height:14px}',
			'.dshPromptLib_searchInput{flex:1;min-width:0;border:none;outline:none;background:0 0;font-family:inherit;font-size:12px;line-height:normal;color:var(--dsw-alias-label-primary);padding:0}',
			'.dshPromptLib_searchInput::placeholder{color:var(--dsw-alias-label-caption)}',
			`.dshPromptLib_searchClear{color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;corner-shape:round;border-radius:50%;justify-content:center;align-items:center;width:24px;height:24px;padding:0;display:inline-flex;position:absolute;top:50%;right:4px;transform:translateY(-50%)}`,
			`.dshPromptLib_searchClear:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
			'.dshPromptLib_searchClear svg{width:14px;height:14px}',
			'.dshPromptLib_viewport{flex-direction:column;min-height:0;display:flex}',
			'.dshPromptLib_list{max-height:min(320px,50vh);overflow-y:auto;padding:0;margin:0;list-style:none}',
			`.dshPromptLib_option{box-sizing:border-box;border-radius:var(--dsw-radius-md);width:100%;min-height:34px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:6px;padding:5px 7px;font-size:13px;line-height:20px;display:flex}`,
			`.dshPromptLib_option:hover,.dshPromptLib_option:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}`,
			'.dshPromptLib_optionCopy{flex-direction:column;flex:1;min-width:0;display:flex}',
			'.dshPromptLib_optionTitle{color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
			'.dshPromptLib_optionPreview{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;overflow:hidden}',
			'.dshPromptLib_optionCheck{color:var(--dsw-alias-label-primary);flex:0 0 14px;place-items:center;display:grid}',
			'.dshPromptLib_optionCheck svg{width:14px;height:14px}',
			`.dshPromptLib_panelFooter{border-top:.5px solid var(--dsw-alias-border-l2);margin-top:3px;padding-top:3px;flex-direction:column;flex:none;display:flex}`,
			`.dshPromptLib_linkButton{border-radius:var(--dsw-radius-md);min-width:100%;height:34px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;cursor:pointer;background:0 0;border:none;text-align:left;align-items:center;padding:0 8px;display:flex}`,
			`.dshPromptLib_linkButton:hover,.dshPromptLib_linkButton:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}`,
			'.dshPromptLib_linkButton:disabled{opacity:.4;cursor:default}',
			`.dshPromptLib_note{color:var(--dsw-alias-label-tertiary);padding:8px;font-size:12px;line-height:18px}`,
			'.dshPromptLib_noteWarn{color:var(--dsw-alias-state-warn-label)}',
			// --- settings page ---------------------------------------------------
			// These rules are copied rule-for-rule from
			// `dsh-client-ui-settings-models` — the shipped page that, like this
			// one, lists rows with Edit/Delete actions and an inline editor. Keeping
			// its exact tokens and metrics is what makes the page sit in the panel
			// as if it shipped with the shell, in both themes and at the content
			// font scale.
			'.dshPromptLib_page{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:16px;display:flex}',
			'.dshPromptLib_heading{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}',
			'.dshPromptLib_intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}',
			// Cards breathe more than the shipped pages do: this list alternates short
			// prompt rows with full-height editor cards, and the wider gap is what
			// keeps a row from reading as part of the editor that follows it.
			'.dshPromptLib_rows{flex-direction:column;gap:16px;margin:0;padding:0;list-style:none;display:flex}',
			'.dshPromptLib_rowCard{border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl);flex-direction:column;gap:12px;padding:12px 14px;display:flex;box-sizing:border-box}',
			// Only the fill differs from a row card; every other metric is inherited
			// from `.dshPromptLib_rowCard` because the two classes always co-apply.
			// `--dsw-alias-bg-module-platform` is the fill the Models page gives its
			// editor and add cards, one step up from the layer-2 card fill.
			'.dshPromptLib_formCard{background:var(--dsw-alias-bg-module-platform)}',
			'.dshPromptLib_rowHead{align-items:center;gap:10px;display:flex}',
			'.dshPromptLib_rowName{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;min-width:0;overflow-wrap:anywhere}',
			// The wrap is the positioning context for the fade below.
			'.dshPromptLib_rowTextWrap{position:relative}',
			// Five 20px lines, so the clamp lands between lines instead of slicing the
			// last one in half.
			'.dshPromptLib_rowText{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:100px;overflow:hidden}',
			'.dshPromptLib_rowTextFade{background:linear-gradient(to bottom,transparent,var(--dsw-alias-settings-card-fill));pointer-events:none;position:absolute;left:0;right:0;bottom:0;height:40px}',
			'.dshPromptLib_rowActions{align-items:center;gap:4px;margin-left:auto;display:inline-flex;flex:none}',
			// The page's action bar: a full-width row that pushes its buttons to the
			// trailing edge. It sits under the description rather than beside the
			// heading, and carries a little extra room below so the first card does
			// not crowd it.
			'.dshPromptLib_headerActions{align-items:center;justify-content:flex-end;gap:8px;margin-bottom:8px;display:flex}',
			'.dshPromptLib_editor{flex-direction:column;gap:14px;display:flex}',
			'.dshPromptLib_field{flex-direction:column;gap:6px;display:flex}',
			'.dshPromptLib_fieldLabel{color:var(--dsw-alias-label-secondary);align-items:center;gap:10px;font-size:12px;font-weight:500;line-height:18px;display:inline-flex}',
			'.dshPromptLib_input{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);width:100%;height:32px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 10px;font-size:14px;line-height:22px}',
			'.dshPromptLib_textarea{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);width:100%;min-height:96px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:8px 10px;font-size:14px;line-height:22px;resize:vertical}',
			'.dshPromptLib_input:focus-visible,.dshPromptLib_textarea:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
			// Buttons: one shared base, then the shipped per-variant skins.
			'.dshPromptLib_primaryButton,.dshPromptLib_secondaryButton{box-sizing:border-box;border-radius:var(--dsw-radius-md);height:36px;font:inherit;cursor:pointer;border:none;justify-content:center;align-items:center;gap:4px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}',
			'.dshPromptLib_dangerButton{box-sizing:border-box;border-radius:var(--dsw-radius-md);height:36px;color:var(--dsw-alias-state-error-primary);font:inherit;cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}',
			'.dshPromptLib_primaryButton{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
			'.dshPromptLib_primaryButton:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
			'.dshPromptLib_secondaryButton{border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);background:0 0}',
			'.dshPromptLib_secondaryButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
			'.dshPromptLib_dangerButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
			// An action sitting in a row — a prompt's Edit/Delete pair or the heading's
			// controls — is the compact variant, exactly as shipped. Both selectors
			// stay scoped: the Models page scopes its own copy of this rule the same
			// way, and an unscoped `.dshPromptLib_secondaryButton` would also shrink
			// the editor's Cancel to 28px next to a 36px Save.
			'.dshPromptLib_rowActions .dshPromptLib_secondaryButton,.dshPromptLib_rowActions .dshPromptLib_dangerButton,.dshPromptLib_headerActions .dshPromptLib_secondaryButton,.dshPromptLib_headerActions .dshPromptLib_dangerButton{border-radius:var(--dsw-radius-sm);height:28px;padding:0 10px;font-size:12px;line-height:18px}',
			'.dshPromptLib_primaryButton:disabled,.dshPromptLib_secondaryButton:disabled,.dshPromptLib_dangerButton:disabled{opacity:.4;cursor:default}',
			'.dshPromptLib_primaryButton:focus-visible,.dshPromptLib_secondaryButton:focus-visible,.dshPromptLib_dangerButton:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}',
			'.dshPromptLib_formActions{align-items:center;justify-content:flex-end;gap:8px;display:flex}',
			// The toggle group is pushed to the leading edge by auto margin, which
			// keeps the DOM order — the switch, its label, then Cancel and Save — the
			// same as the reading order while the buttons stay flush right. The
			// switch leads its own label so the control itself sits on the edge.
			'.dshPromptLib_formToggle{align-items:center;gap:8px;margin-right:auto;display:inline-flex}',
			'.dshPromptLib_switchLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}',
			// Copied from the shell's `Switch` primitive, tokens and metrics
			// included: a 36x20 track, a 16px thumb that slides across, the brand
			// fill once checked. The label is the button's accessible name, so the
			// visible text beside it stays plain copy.
			'.dshPromptLib_switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer}',
			'.dshPromptLib_switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}',
			'.dshPromptLib_switch:disabled{cursor:default;opacity:.5}',
			'.dshPromptLib_switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
			'.dshPromptLib_switchThumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s ease}',
			'.dshPromptLib_switch[aria-checked=false] .dshPromptLib_switchThumb{background:var(--dsw-alias-switch-thumb)}',
			'.dshPromptLib_switch[aria-checked=true] .dshPromptLib_switchThumb{transform:translate(16px)}',
			// A row's delete is an icon, not a label, and it wears the Models page's
			// `iconButtonDanger` skin: 28px square, `--dsw-radius-sm`, a 14px
			// `IconTrashOutlineRegular` glyph in the tertiary tint that turns red —
			// icon and fill together — on hover.
			'.dshPromptLib_deleteButton{box-sizing:border-box;border-radius:var(--dsw-radius-sm);width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;display:inline-flex;flex:none}',
			'.dshPromptLib_deleteButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}',
			'.dshPromptLib_deleteButton:disabled{cursor:default;opacity:.4}',
			'.dshPromptLib_deleteButton:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}',
			'.dshPromptLib_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}',
			'.dshPromptLib_pageNote{color:var(--dsw-alias-state-warn-label);margin:0;font-size:12px;line-height:18px}',
			'.dshPromptLib_empty{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}',
		].join('');

		/** Adds the panel styles to the document; the returned function removes them. */
		function applyStyles() {
			const tag = document.createElement('style');
			tag.dataset.plugin = '@stmol/dsh-prompt-lib';
			tag.textContent = STYLES;
			document.head.appendChild(tag);
			return () => tag.remove();
		}

		/**
		 * Reason taken from a remote response: an error carries either a message
		 * or a code, and a note must never end up with an empty `{reason}`.
		 */
		function errorReason(error) {
			if (error === null || error === undefined) return 'unknown error';
			if (typeof error === 'string') return error;
			return error.message ?? error.code ?? JSON.stringify(error);
		}

		/**
		 * One-line preview of a prompt body for the picker's rows.
		 *
		 * Every run of whitespace collapses to a single space, so a multi-line
		 * instruction reads as one line, and the result is cut at 90 characters.
		 */
		function previewOf(text) {
			const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
			return flat.length > 90 ? `${flat.slice(0, 89)}\u2026` : flat;
		}

		/** A trimmed string field, or the empty string when it is not a string. */
		function textOf(value) {
			return typeof value === 'string' ? value.trim() : '';
		}

		/**
		 * Ids of the prompts marked to start enabled in every new session.
		 *
		 * This mirrors the host's own fallback, so the picker shows a fresh chat
		 * exactly the set the host is about to inject, in the same order.
		 *
		 * @param prompts - a normalized prompt list.
		 * @returns the default prompts' ids, in library order.
		 */
		function defaultIds(prompts) {
			return prompts.filter((prompt) => prompt.byDefault === true).map((prompt) => prompt.id);
		}

		/**
		 * The ids in force for one session, mirroring the host's own rule.
		 *
		 * A session with an entry of its own uses exactly that list — including an
		 * empty one, which is how unticking the last default prompt stays unticked.
		 * Only a session with no entry at all falls back to the library's defaults,
		 * the same fallback the host applies when it assembles the session.
		 *
		 * @param prompts - the normalized library.
		 * @param selection - the normalized session-id -> ids map.
		 * @param sessionId - the session the pick is wanted for.
		 * @returns the session's complete pick.
		 */
		function pickOf(prompts, selection, sessionId) {
			const stored = selection?.[sessionId];
			return Array.isArray(stored) ? stored : defaultIds(prompts);
		}

		/**
		 * Reads a prompt list defensively.
		 *
		 * The list crosses a JSON round trip through the settings document, so a
		 * hand-edited profile can hold anything. Entries that cannot be addressed
		 * by id are dropped: a prompt with no id could never be ticked, and would
		 * only show up as a row that does nothing.
		 */
		function normalizePrompts(value) {
			if (!Array.isArray(value)) return [];
			const result = [];
			for (const entry of value) {
				if (entry === null || typeof entry !== 'object') continue;
				const id = textOf(entry.id);
				if (id === '') continue;
				result.push({
					id,
					title: textOf(entry.title),
					text: typeof entry.text === 'string' ? entry.text : '',
					// Exactly `true`, so an entry stored before the flag existed — or
					// a hand-edited one — reads as "not a default".
					byDefault: entry.byDefault === true,
				});
			}
			return result;
		}

		/** Reads the session-id -> prompt-ids map defensively. */
		function normalizeSelection(value) {
			if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
			// Null-prototype on purpose: the keys come out of the stored document,
			// and assigning `__proto__` on a plain object would reparent it instead
			// of storing the entry the host is honouring.
			const result = Object.create(null);
			for (const [key, ids] of Object.entries(value)) {
				if (Array.isArray(ids)) result[key] = ids.filter((id) => typeof id === 'string');
			}
			return result;
		}

		/**
		 * Shared state of both surfaces.
		 *
		 * `access` is an accessor cell rather than a direct service reference
		 * because the settings remote is mounted asynchronously: `ctx.inject`
		 * fills it once the namespace is ready, and both surfaces treat a missing
		 * reader as "settings unavailable" instead of throwing.
		 *
		 * Writes are serialized through one promise chain so two quick ticks
		 * cannot race on the same revision.
		 */
		function createStore() {
			const access = { read: undefined, write: undefined };
			let state = {
				status: 'loading',
				prompts: [],
				selection: {},
				revision: undefined,
				writable: true,
				error: undefined,
			};
			let queue = Promise.resolve();
			const listeners = new Set();

			function publish(next) {
				state = next;
				for (const listener of listeners) listener();
			}

			/** Find this plugin's namespace in a describe response. */
			function viewOf(value) {
				const namespaces = Array.isArray(value?.namespaces) ? value.namespaces : [];
				return namespaces.find((entry) => entry?.ns === ENTRY_ID);
			}

			/**
			 * Adopt one namespace view, which is what both describe and mutate answer with.
			 *
			 * The error is carried through rather than cleared: a read that follows a
			 * refused write must not wipe the reason the write was refused.
			 */
			function adopt(value, writable, error) {
				publish({
					status: 'ready',
					prompts: normalizePrompts(value?.value?.prompts),
					selection: normalizeSelection(value?.value?.selection),
					revision: value?.revision,
					writable: writable ?? state.writable,
					error,
				});
			}

			/**
			 * Read the namespaces once; a missing reader means "not bound yet".
			 *
			 * Deliberately not queued here: `enqueue` wraps it for callers, while a
			 * write that has to recover calls it directly so it cannot wait on the very
			 * queue that write is running in.
			 *
			 * @param error - failure to keep showing while the read lands.
			 * @returns whether a namespace view was adopted.
			 */
			async function readOnce(error) {
				const read = access.read;
				if (read === undefined) {
					publish({ ...state, status: 'unbound', error });
					return false;
				}
				let result;
				try {
					result = await read();
				} catch (failure) {
					publish({ ...state, status: 'unavailable', error: String(failure) });
					return false;
				}
				if (!result?.ok) {
					publish({ ...state, status: 'unavailable', error: errorReason(result?.error) });
					return false;
				}
				const value = result.value;
				const view = viewOf(value);
				if (view === undefined) {
					// The entry is missing from the profile: the plugin is mounted
					// without its patch row, so there is nothing to edit.
					publish({
						status: 'unavailable',
						prompts: [],
						selection: {},
						revision: undefined,
						writable: value?.writable ?? false,
						error: `no "${ENTRY_ID}" entry in this profile`,
					});
					return false;
				}
				adopt(view, value?.writable, error);
				return true;
			}

			/**
			 * Run one write at the head of the queue.
			 *
			 * `build` is called here, not at the click, so the ops are derived from the
			 * newest snapshot: two quick ticks each merge into what the previous write
			 * accepted instead of both starting from the same render.
			 *
			 * A refusal means this snapshot is behind the document — the next attempt
			 * would be refused for the same reason — so the namespaces are re-read while
			 * the reason stays visible.
			 *
			 * @param build - snapshot -> ops, or undefined when there is nothing to do.
			 * @returns whether the write was accepted.
			 */
			async function run(build) {
				const write = access.write;
				if (write === undefined) {
					publish({ ...state, status: 'unavailable' });
					return false;
				}
				let ops;
				try {
					ops = build(state);
				} catch (error) {
					publish({ ...state, error: String(error) });
					return false;
				}
				if (ops === undefined) return true;
				let result;
				try {
					result = await write(ops, state.revision);
				} catch (error) {
					publish({ ...state, error: String(error) });
					return false;
				}
				if (!result?.ok) {
					const reason = errorReason(result?.error);
					publish({ ...state, error: reason });
					await readOnce(reason);
					return false;
				}
				adopt(result.value, state.writable);
				return true;
			}

			/**
			 * Serialize one task behind the writes already queued.
			 *
			 * The chain never rejects: a task that throws would otherwise poison every
			 * write queued behind it, and a wedged queue is worse than a lost edit.
			 *
			 * @param task - work to run once the queue reaches it.
			 * @returns the queue's promise, resolving to the task's outcome.
			 */
			function enqueue(task) {
				queue = queue.then(task).catch(() => false);
				return queue;
			}

			/** Read the namespaces, queued behind any write already running. */
			function load() {
				return enqueue(() => readOnce());
			}

			return {
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				getSnapshot() {
					return state;
				},
				/**
				 * Point the store at the settings remote, or at nothing when it is absent.
				 *
				 * Binding is what starts the first read: a read attempted before the
				 * remote exists would report "unavailable" and leave the composer
				 * picker permanently absent, so the state machine distinguishes
				 * "not bound yet" from "bound and refusing".
				 */
				bind(read, write) {
					access.read = read;
					access.write = write;
					void load();
				},
				unbind() {
					access.read = undefined;
					access.write = undefined;
					publish({ ...state, status: 'unbound' });
				},
				/** Read the namespaces; queued so it cannot land under a write. */
				load,
				/**
				 * Apply path-addressed edits whose ops are already known.
				 *
				 * Only ops that do not depend on the current snapshot belong here; a list
				 * replacement that has to merge with what is stored goes through `mutate`.
				 *
				 * @param ops - settings path operations.
				 * @returns whether the write was accepted.
				 */
				write(ops) {
					return enqueue(() => run(() => ops));
				},
				/**
				 * Apply path-addressed edits whose ops are computed when they run.
				 *
				 * The ops are resolved by the host against the stored section, so a stale
				 * client still lands its edit on the right field; the revision is passed
				 * so a genuine concurrent edit is refused rather than silently
				 * overwritten. Building the value from the freshest snapshot is what keeps
				 * two quick clicks from overwriting each other.
				 *
				 * @param build - snapshot -> ops, or undefined when there is nothing to do.
				 * @returns whether the write was accepted.
				 */
				mutate(build) {
					return enqueue(() => run(build));
				},
			};
		}

		/**
		 * Subscribes a component to the shared store.
		 * @param store - the store built by the plugin.
		 */
		function useStore(store) {
			return React.useSyncExternalStore(store.subscribe, store.getSnapshot);
		}

		/**
		 * Closes the picker on a pointer press outside it. The panel lives in a
		 * portal, so it is checked separately from the anchor.
		 */
		function useDismissOnOutsidePointer(root, panel, open, setOpen) {
			React.useEffect(() => {
				if (!open) return;
				const closeOutside = (event) => {
					const target = event.target;
					if (!(target instanceof Node)) return;
					if (root.current?.contains(target) === true) return;
					if (panel.current?.contains(target) === true) return;
					setOpen(false);
				};
				document.addEventListener('pointerdown', closeOutside);
				return () => document.removeEventListener('pointerdown', closeOutside);
			}, [root, panel, open, setOpen]);
		}

		/** Closes the picker on Escape, the way the built-in shell menus do. */
		function useDismissOnEscape(open, setOpen) {
			React.useEffect(() => {
				if (!open) return;
				const onKeyDown = (event) => {
					if (event.key === 'Escape') setOpen(false);
				};
				document.addEventListener('keydown', onKeyDown);
				return () => document.removeEventListener('keydown', onKeyDown);
			}, [open, setOpen]);
		}

		/**
		 * Places the panel above its anchor, clamped to the window.
		 *
		 * The composer sits inside ancestors with `backdrop-filter`, which become
		 * their own containing block for `position: fixed`; the panel is therefore
		 * portalled to `document.body` and positioned from measured rects, exactly
		 * as the built-in dock popovers do.
		 */
		function usePanelPosition({ open, anchorRef, panelRef, gap, margin }) {
			const [position, setPosition] = React.useState(null);
			React.useLayoutEffect(() => {
				if (!open) {
					setPosition(null);
					return;
				}
				const place = () => {
					const rect = anchorRef.current?.getBoundingClientRect();
					if (rect === undefined) return;
					const panel = panelRef.current;
					const width = panel?.offsetWidth ?? 0;
					const height = panel?.offsetHeight ?? 0;
					let left = rect.left;
					let top = rect.top - gap - height;
					if (width > 0) left = Math.min(Math.max(left, margin), window.innerWidth - width - margin);
					if (height > 0) top = Math.min(Math.max(top, margin), window.innerHeight - height - margin);
					setPosition({ left, top });
				};
				place();
				window.addEventListener('scroll', place, true);
				window.addEventListener('resize', place);
				const panel = panelRef.current;
				let observer = null;
				if (typeof ResizeObserver !== 'undefined' && panel !== null) {
					observer = new ResizeObserver(place);
					observer.observe(panel);
				}
				return () => {
					observer?.disconnect();
					window.removeEventListener('scroll', place, true);
					window.removeEventListener('resize', place);
				};
			}, [open, anchorRef, panelRef, gap, margin]);
			return position;
		}

		/** Hides the panel for the first frame so its measured size is available. */
		const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };

		/** Gap between the trigger and the panel, and the panel's margin from the window edge. */
		const PANEL_GAP = 8;
		const PANEL_MARGIN = 12;

		/**
		 * The picker trigger's stacked-list glyph.
		 *
		 * Hairline strokes rather than filled bars: the reference control draws
		 * three lines over a 16px box, so the 14px render is 0.9px — the same
		 * `IconFlatListOutlineRegular` weight the shell's own small glyphs use.
		 */
		function PromptsGlyph() {
			return h(
				'svg',
				{
					width: 16,
					height: 16,
					viewBox: '0 0 16 16',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1,
					'aria-hidden': true,
					focusable: false,
				},
				h('path', { d: 'M2.4 4.2h11.2M2.4 8h11.2M2.4 11.8h6.4' }),
			);
		}

		/** The search field's leading glyph, matching `IconSearchOutlineRegular`. */
		function SearchGlyph() {
			return h(
				'svg',
				{
					width: 14,
					height: 14,
					viewBox: '0 0 16 16',
					fill: 'none',
					'aria-hidden': true,
					focusable: false,
				},
				h('path', {
					d: 'M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z',
					stroke: 'currentColor',
				}),
				h('path', { d: 'M10.2991 10.3933L14.7783 14.8725', stroke: 'currentColor' }),
			);
		}

		/**
		 * The add button's leading glyph, matching `IconPlusOutlineRegular` from
		 * `dsh-client-ui-primitives`: two hairline strokes over a 16px box. The
		 * Models page draws the same icon at size 14 in the same button, so the
		 * two "add" affordances stay pixel-comparable.
		 */
		function AddGlyph() {
			return h(
				'svg',
				{
					width: 14,
					height: 14,
					viewBox: '0 0 16 16',
					fill: 'none',
					strokeWidth: 1,
					'aria-hidden': true,
					focusable: false,
				},
				h('path', { d: 'M8 2V14', stroke: 'currentColor' }),
				h('path', { d: 'M2 8H14', stroke: 'currentColor' }),
			);
		}

		/**
		 * The shell's `IconCloseFillRegular` cross, at 14px, used by the picker's
		 * search field to clear the query.
		 */
		function CloseGlyph() {
			return h(
				'svg',
				{
					width: 14,
					height: 14,
					viewBox: '0 0 16 16',
					fill: 'none',
					strokeWidth: 1,
					'aria-hidden': true,
					focusable: false,
				},
				h('path', { d: 'M3.5 3.5L12.5 12.5', stroke: 'currentColor' }),
				h('path', { d: 'M12.5 3.5L3.5 12.5', stroke: 'currentColor' }),
			);
		}

		/**
		 * The shell's `IconTrashOutlineRegular`, at 14px — the same artwork the
		 * Models page puts in its `iconButtonDanger` remove control. A prompt row
		 * deletes with it so the two destructive affordances read alike.
		 */
		function TrashGlyph() {
			return h(
				'svg',
				{
					width: 14,
					height: 14,
					viewBox: '0 0 16 16',
					fill: 'none',
					strokeWidth: 1,
					'aria-hidden': true,
					focusable: false,
				},
				h('path', { d: 'M1.28149 3.88831H14.7187', stroke: 'currentColor' }),
				h('path', {
					d: 'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833',
					stroke: 'currentColor',
				}),
				h('path', {
					d: 'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831',
					stroke: 'currentColor',
				}),
				h('path', { d: 'M6.44946 6.98926V11.1238', stroke: 'currentColor' }),
				h('path', { d: 'M9.55054 6.98926V11.1238', stroke: 'currentColor' }),
			);
		}

		/**
		 * The composer picker.
		 *
		 * The trigger prints the number of prompts ticked for this session — the
		 * count is the whole reason the control is visible at a glance. Ticking a
		 * row writes immediately; the panel stays open so several prompts can be
		 * switched in one visit.
		 */
		function PromptsPicker(props) {
			const { t, sessionId } = props;
			const store = props.store;
			const state = useStore(store);
			const [open, setOpen] = React.useState(false);
			const [search, setSearch] = React.useState('');
			const rootRef = React.useRef(null);
			const panelRef = React.useRef(null);
			const searchRef = React.useRef(null);
			/** Whether the panel was open on the previous run, for the focus edge. */
			const wasOpenRef = React.useRef(false);
			const position = usePanelPosition({
				open,
				anchorRef: rootRef,
				panelRef,
				gap: PANEL_GAP,
				margin: PANEL_MARGIN,
			});
			useDismissOnOutsidePointer(rootRef, panelRef, open, setOpen);
			useDismissOnEscape(open, setOpen);

			// The count has to be right on first paint, so the library is read as
			// soon as the control mounts; every open re-reads as well, because the
			// library may have been edited in Settings since.
			React.useEffect(() => {
				void store.load();
			}, [store]);
			React.useEffect(() => {
				if (open) void store.load();
			}, [open, store]);
			// A fresh search each time the panel opens: a stale filter would hide
			// prompts with no visible reason.
			React.useEffect(() => {
				if (!open) setSearch('');
			}, [open]);
			// The panel is a search surface, so opening it hands the keyboard to the
			// field — the same move the model menu makes.
			//
			// This is a *layout* effect on purpose. The panel's first commit renders
			// it under `visibility:hidden` while its size is measured, and
			// `usePanelPosition` — itself a layout effect — writes the real
			// coordinates during that same commit. React runs every layout effect
			// before any passive effect, so focusing here happens after the field is
			// visible and focusable; a plain `useEffect` would race the measurement
			// on a slow frame and lose the focus to a hidden element.
			//
			// It also guards the close -> open edge: the field mounts with the panel,
			// and re-focusing on every render would drag the caret back out of
			// wherever the user tabbed to.
			React.useLayoutEffect(() => {
				const wasOpen = wasOpenRef.current;
				wasOpenRef.current = open;
				if (open && !wasOpen) searchRef.current?.focus();
			}, [open]);

			// `loading` still means "the first read has not answered" and `unbound`
			// means the settings remote is not mounted at all. Rendering a "0"
			// during either would make the count flash on every mount, and rendering
			// the control without a working remote would offer a picker that cannot
			// record anything.
			if (state.status === 'loading' || state.status === 'unbound') {
				return null;
			}

			// The count on a fresh chat is what that chat will inject, because this
			// resolves the pick with the same rule the host assembles by.
			const selected = pickOf(state.prompts, state.selection, sessionId);
			const selectedSet = new Set(selected);
			const count = state.prompts.filter((prompt) => selectedSet.has(prompt.id)).length;
			const unavailable = state.status === 'unavailable';
			// Writing is refused when the session cannot be addressed: a pick is
			// stored *under* the session id, so a picker without a usable one has
			// nowhere to record a choice and must not invent a key.
			const blocked = unavailable || !addressableSessionId(sessionId);

			// The search narrows what the panel lists; it never touches the stored
			// selection, so a ticked prompt stays on even while it is filtered out.
			const query = search.trim().toLowerCase();
			const visible =
				query === ''
					? state.prompts
					: state.prompts.filter(
							(prompt) =>
								prompt.title.toLowerCase().includes(query) || prompt.text.toLowerCase().includes(query),
						);

			/**
			 * The op that records a session's pick.
			 *
			 * A pick equal to the library's defaults is written as `unset`: an absent
			 * entry and "the defaults" mean the same thing to both halves, so the
			 * document does not have to carry a copy of the defaults for every session
			 * the user merely looked at. Any other list — the empty one included — is
			 * written out, because that is how a session says "none here", and it is
			 * why unticking the last default prompt cannot hand the default back.
			 *
			 * @param snapshot - the state the write runs against.
			 * @param next - the session's complete pick.
			 * @returns the path operation to apply.
			 */
			function selectionOp(snapshot, next) {
				const defaults = defaultIds(snapshot.prompts);
				const equalsDefaults =
					next.length === defaults.length && next.every((id, index) => id === defaults[index]);
				if (equalsDefaults) return { op: 'unset', path: ['selection', sessionId] };
				return { op: 'set', path: ['selection', sessionId], value: next };
			}

			const toggle = (id) => {
				if (blocked) return;
				// The list is read from the snapshot the write runs against, not from this
				// render: two ticks inside one round trip would otherwise both start from
				// the same list and the first one would be lost.
				void store.mutate((snapshot) => {
					const current = pickOf(snapshot.prompts, snapshot.selection, sessionId);
					const currentSet = new Set(current);
					const next = currentSet.has(id)
						? current.filter((entry) => entry !== id)
						: [...current, id];
					return [selectionOp(snapshot, next)];
				});
			};

			// Clearing is a decision too: the session keeps its empty pick rather
			// than falling back to the defaults it was just stripped of.
			const clear = () => {
				if (blocked) return;
				void store.write([{ op: 'set', path: ['selection', sessionId], value: [] }]);
			};

			const triggerLabel = t('picker.label');
			// An empty picker is still a readable control: the icon and label stay
			// on the muted tier only while nothing is ticked, exactly as the model
			// control mutes its effort value and not its label.
			const triggerFace = count === 0 ? ` ${css.triggerQuiet}` : '';

			return h(
				'span',
				{ ref: rootRef, className: css.anchor },
				h(
					'button',
					{
						type: 'button',
						className: `${css.trigger}${triggerFace}`,
						'aria-haspopup': 'dialog',
						'aria-expanded': open,
						'aria-label': count === 0 ? triggerLabel : `${triggerLabel}: ${count}`,
						onClick: () => setOpen((value) => !value),
						// The pointer press must not take focus back from the search
						// field, or clicking the trigger while the panel is open would
						// move the caret off it.
						onMouseDown: (event) => event.preventDefault(),
					},
					h('span', { className: css.triggerIcon }, h(PromptsGlyph, null)),
					h('span', { className: css.triggerLabel }, triggerLabel),
					count === 0 ? null : h('span', { className: css.badge }, String(count)),
					h(
						'svg',
						{
							width: 14,
							height: 14,
							viewBox: '0 0 16 16',
							fill: 'none',
							strokeWidth: 1,
							'aria-hidden': true,
							focusable: false,
							className: open ? `${css.chevron} ${css.chevronOpen}` : css.chevron,
						},
						h('path', {
							d: 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6',
							stroke: 'currentColor',
						}),
					),
				),
				open
					? ReactDOM.createPortal(
							h(
								'div',
								{
									ref: panelRef,
									className: css.panel,
									// Marks this as a menu material surface, which is what
									// lets the theme supply the surface's border stroke.
									'data-menu-material': 'translucent',
									role: 'dialog',
									'aria-label': t('picker.label'),
									style: position ?? MEASURE_STYLE,
								},
								// The material is a child layer, not a background on the
								// card, so the backdrop filter sees the page behind the
								// card exactly as the shell's menus do.
								h('div', { className: css.panelMaterial, 'aria-hidden': true }),
								// Search sits above the scroll region, like the model
								// menu's own row, so a long library stays filtered in place.
								state.prompts.length === 0
									? null
									: h(
											'div',
											{ className: css.searchRow },
											h(
												'span',
												{
													className: search === '' ? css.search : `${css.search} ${css.searchWithQuery}`,
												},
												h('span', { className: css.searchIcon }, h(SearchGlyph, null)),
												h('input', {
													ref: searchRef,
													type: 'text',
													className: css.searchInput,
													placeholder: t('picker.search'),
													'aria-label': t('picker.search'),
													value: search,
													disabled: unavailable,
													onChange: (event) => setSearch(event.target.value),
												}),
											),
											search === ''
												? null
												: h(
														'button',
														{
															type: 'button',
															className: css.searchClear,
															'aria-label': t('picker.searchClear'),
															onClick: () => setSearch(''),
														},
														h(CloseGlyph, null),
													),
										),
								h(
									'div',
									{ className: css.viewport },
									unavailable && state.prompts.length === 0
										? h('div', { className: css.note }, t('picker.unavailable'))
										: null,
									state.prompts.length === 0
										? h(
												'div',
												{ className: css.note },
												h('div', null, t('picker.empty')),
												h('div', null, t('picker.emptyHint')),
											)
										: visible.length === 0
											? h('div', { className: css.note }, t('picker.noMatches'))
											: h(
													'ul',
													{ className: css.list },
													visible.map((prompt) => {
														const checked = selectedSet.has(prompt.id);
														return h(
															'li',
															{ key: prompt.id },
															h(
																'button',
																{
																	type: 'button',
																	role: 'checkbox',
																	'aria-checked': checked,
																	className: css.option,
																	disabled: blocked,
																	onClick: () => toggle(prompt.id),
																},
																h(
																	'span',
																	{ className: css.optionCopy },
																	h('span', { className: css.optionTitle }, prompt.title || previewOf(prompt.text)),
																	h('span', { className: css.optionPreview }, previewOf(prompt.text)),
																),
																// Trailing marker, the shared `IconCheckOutline`
																// the shell's own menus draw.
																checked
																	? h(
																			'span',
																			{ className: css.optionCheck },
																			h(
																				'svg',
																				{
																					width: 14,
																					height: 14,
																					viewBox: '0 0 16 16',
																					fill: 'none',
																					strokeWidth: 1,
																					'aria-hidden': true,
																					focusable: false,
																				},
																				h('path', {
																					d: 'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4',
																					stroke: 'currentColor',
																				}),
																			),
																		)
																	: null,
															),
														);
													}),
												),
								),
								state.error === undefined
									? null
									: h('div', { className: `${css.note} ${css.noteWarn}` }, t('picker.error', { reason: state.error })),
								count === 0
									? null
									: h(
										'div',
										{ className: css.panelFooter },
										h('button', { type: 'button', className: css.linkButton, disabled: blocked, onClick: clear }, t('picker.clear')),
									),
							),
							document.body,
						)
					: null,
			);
		}

		/**
		 * The stored instruction, clamped to five lines.
		 *
		 * The clamp is a hard height, so a long instruction used to end mid-line
		 * with nothing to say it continued. The fade is painted only when the text
		 * really overflows — measured, not assumed, and re-measured when the panel
		 * reflows — so a short prompt keeps a clean bottom edge. It is decorative:
		 * the full text stays in the DOM, so the row still reads complete to
		 * assistive tech and to the picker's own preview.
		 */
		function ClampedText(props) {
			const ref = React.useRef(null);
			const [clamped, setClamped] = React.useState(false);
			React.useLayoutEffect(() => {
				const node = ref.current;
				if (node === null) return undefined;
				const measure = () => setClamped(node.scrollHeight > node.clientHeight + 1);
				measure();
				if (typeof ResizeObserver === 'undefined') return undefined;
				const observer = new ResizeObserver(measure);
				observer.observe(node);
				return () => observer.disconnect();
			}, [props.text]);
			return h(
				'div',
				{ className: css.rowTextWrap },
				h('div', { ref, className: css.rowText }, props.text),
				clamped ? h('div', { className: css.rowTextFade, 'aria-hidden': true }) : null,
			);
		}

		/**
		 * The Settings -> Prompts page.
		 *
		 * The page owns the library: it creates, renames, rewrites and deletes
		 * entries. Every mutation rewrites the whole `prompts` array, which keeps
		 * the write a single op and sidesteps array-index bookkeeping.
		 */
		function PromptsSection(props) {
			const { t } = props;
			const store = props.store;
			const state = useStore(store);
			// One editor at a time: `editing` is a prompt id, or the NEW sentinel.
			const [editing, setEditing] = React.useState(null);
			const [title, setTitle] = React.useState('');
			const [text, setText] = React.useState('');
			const [byDefault, setByDefault] = React.useState(false);
			const [confirming, setConfirming] = React.useState(null);
			const [problem, setProblem] = React.useState(null);
			/** The open editor's card, so it can be brought into view when it mounts. */
			const formRef = React.useRef(null);

			React.useEffect(() => {
				void store.load();
			}, [store]);

			/**
			 * The nearest ancestor that actually scrolls, or `null` when the page
			 * itself is the scroller. Used to tell whether a mounted editor is
			 * really on screen rather than clipped by the panel's scrollport.
			 */
			function scrollParentOf(node) {
				let parent = node.parentElement;
				while (parent !== null) {
					const { overflowY } = window.getComputedStyle(parent);
					if ((overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) {
						return parent;
					}
					parent = parent.parentElement;
				}
				return null;
			}

			/**
			 * Brings the editor into view when it opens.
			 *
			 * The add form mounts after the rows *and* after the add button, so
			 * opening it from the bottom of a long library left it — Title field
			 * included — below the fold, with nothing on screen to say it had
			 * appeared. `block: 'start'` pins the form's top to the top of the
			 * panel's scrollport rather than fitting its bottom, because the space
			 * under the button is usually shorter than the form. A form that is
			 * already fully on screen is left alone, so pressing Edit on a visible
			 * row does not jump the list.
			 */
			React.useEffect(() => {
				if (editing === null) return;
				const node = formRef.current;
				if (node === null) return;
				const scroller = scrollParentOf(node);
				const view =
					scroller === null
						? { top: 0, bottom: window.innerHeight }
						: scroller.getBoundingClientRect();
				const box = node.getBoundingClientRect();
				if (box.top >= view.top && box.bottom <= view.bottom) return;
				node.scrollIntoView({ block: 'start' });
			}, [editing]);

			const beginNew = () => {
				setEditing(NEW_PROMPT);
				setTitle('');
				setText('');
				// Off unless asked for: a prompt joins new sessions only when the
				// user turns the switch on.
				setByDefault(false);
				setProblem(null);
			};

			const beginEdit = (prompt) => {
				setEditing(prompt.id);
				setTitle(prompt.title);
				setText(prompt.text);
				setByDefault(prompt.byDefault === true);
				setProblem(null);
			};

			const cancel = () => {
				setEditing(null);
				setProblem(null);
			};

			const save = () => {
				const trimmedTitle = title.trim();
				const trimmedText = text.trim();
				if (trimmedTitle === '') {
					setProblem(t('section.titleRequired'));
					return;
				}
				if (trimmedText === '') {
					setProblem(t('section.textRequired'));
					return;
				}
				const entry = {
					id: editing === NEW_PROMPT ? newId() : editing,
					title: trimmedTitle,
					text: trimmedText,
					byDefault,
				};
				// The row list is read when the write runs, so a form filled in against a
				// stale render merges into the current library instead of overwriting it.
				// The editor closes only once the write is accepted: a refused save keeps
				// the draft on screen next to the reason it was refused.
				void store
					.mutate((snapshot) => {
						const exists = snapshot.prompts.some((prompt) => prompt.id === entry.id);
						const next = exists
							? snapshot.prompts.map((prompt) => (prompt.id === entry.id ? entry : prompt))
							: [...snapshot.prompts, entry];
						return [{ op: 'set', path: ['prompts'], value: next }];
					})
					.then((saved) => {
						if (!saved) return;
						setEditing((current) => (current === editing ? null : current));
						setProblem(null);
					});
			};

			const remove = (id) => {
				void store.mutate((snapshot) => [
					{
						op: 'set',
						path: ['prompts'],
						value: snapshot.prompts.filter((prompt) => prompt.id !== id),
					},
				]);
				setConfirming(null);
			};

			/**
			 * Empties the library.
			 *
			 * Only `prompts` is rewritten, never `selection`: a session's pick is a
			 * set of references, and the host already skips ids that no longer
			 * resolve, so dropping them here would cost a write and gain nothing. An
			 * open editor is closed because its draft would otherwise outlive the
			 * entry it was editing.
			 */
			const removeAll = () => {
				void store.write([{ op: 'set', path: ['prompts'], value: [] }]);
				setEditing(null);
				setConfirming(null);
				setProblem(null);
			};

			/**
			 * The confirm/keep pair both destructive actions swap in.
			 *
			 * Confirming replaces the pair with the answer, so the destructive step
			 * never sits one click away; only the accepted action differs between the
			 * per-row delete and the page-wide one.
			 *
			 * @param onConfirm - the destructive action this pair guards.
			 * @returns the two buttons, keyed for use as a list of children.
			 */
			function confirmPair(onConfirm) {
				return [
					h(
						'button',
						{ key: 'confirm', type: 'button', className: css.dangerButton, onClick: onConfirm },
						t('section.confirmYes'),
					),
					h(
						'button',
						{ key: 'keep', type: 'button', className: css.secondaryButton, onClick: () => setConfirming(null) },
						t('section.confirmNo'),
					),
				];
			}

			if (state.status === 'loading') {
				return h(
					'div',
					{ className: css.page },
					h('h2', { className: css.heading }, t('section.title')),
					h('p', { className: css.empty }, t('section.loading')),
				);
			}

			const unavailable = state.status === 'unavailable';
			// `unbound` means the settings remote is not mounted at all: the page still
			// renders, but nothing it offers could be recorded, so it must not present
			// an editable form that silently drops the first click.
			const unbound = state.status === 'unbound';
			const readOnly = unavailable || unbound || state.writable === false;

			return h(
				'div',
				{ className: css.page },
				h('h2', { className: css.heading }, t('section.title')),
				h('p', { className: css.intro }, t('section.intro')),
				readOnly
					? h(
							'p',
							{ className: css.pageNote },
							unavailable
								? t('section.unavailable', { reason: state.error ?? 'unknown' })
								: unbound
									? t('section.unbound')
									: t('section.readOnly'),
						)
					: null,
				state.error !== undefined && !unavailable && !unbound
					? h('p', { className: css.error }, t('section.saveError', { reason: state.error }))
					: null,
				// Confirming replaces the pair with the answer, so the destructive step
				// never sits one click away.
				h(
					'div',
					{ className: css.headerActions },
					confirming === DELETE_ALL
						? confirmPair(removeAll)
						: [
								h(
									'button',
									{ key: 'add', type: 'button', className: css.secondaryButton, onClick: beginNew, disabled: readOnly },
									h(AddGlyph, null),
									t('section.add'),
								),
								h(
									'button',
									{
										key: 'delete-all',
										type: 'button',
										className: css.dangerButton,
										onClick: () => setConfirming(DELETE_ALL),
										disabled: readOnly || state.prompts.length === 0,
									},
									t('section.deleteAll'),
								),
							],
				),
				state.prompts.length === 0 && editing === null
					? h('p', { className: css.empty }, t('section.empty'))
					: null,
				h(
					'div',
					{ className: css.rows },
					state.prompts.map((prompt) =>
						editing === prompt.id
							? h(
									'div',
									{ key: prompt.id, ref: formRef, className: `${css.rowCard} ${css.formCard}` },
									h('div', { className: css.editor }, editorFields()),
								)
							: promptRow(prompt),
					),
					editing === NEW_PROMPT
						? h(
								'div',
								{ ref: formRef, className: `${css.rowCard} ${css.formCard}` },
								h('div', { className: css.editor }, editorFields()),
							)
						: null,
				),
			);

			/** One stored prompt as a settings row: name and actions above, text below. */
			function promptRow(prompt) {
				const confirmingThis = confirming === prompt.id;
				return h(
					'div',
					{ key: prompt.id, className: css.rowCard },
					h(
						'div',
						{ className: css.rowHead },
						h('span', { className: css.rowName }, prompt.title),
						h(
							'div',
							{ className: css.rowActions },
							confirmingThis
								? confirmPair(() => remove(prompt.id))
								: [
										h(
											'button',
											{
												key: 'edit',
												type: 'button',
												className: css.secondaryButton,
												onClick: () => beginEdit(prompt),
												disabled: readOnly,
											},
											t('section.edit'),
										),
										h(
											'button',
											{
												key: 'delete',
												type: 'button',
												className: css.deleteButton,
												onClick: () => setConfirming(prompt.id),
												disabled: readOnly,
												'aria-label': t('section.delete'),
												title: t('section.delete'),
											},
											h(TrashGlyph, null),
										),
									],
						),
					),
					confirmingThis
						? h('div', { className: css.rowText }, t('section.deleteConfirm'))
						: h(ClampedText, { text: prompt.text }),
				);
			}

			/** The shared title/instruction editor, used for both create and edit. */
			function editorFields() {
				return h(
					React.Fragment,
					null,
					h(
						'label',
						{ className: css.field },
						h('span', { className: css.fieldLabel }, t('section.titleLabel')),
						h('input', {
							type: 'text',
							className: css.input,
							value: title,
							maxLength: MAX_TITLE,
							placeholder: t('section.titlePlaceholder'),
							onChange: (event) => setTitle(event.target.value),
						}),
					),
					h(
						'label',
						{ className: css.field },
						h('span', { className: css.fieldLabel }, t('section.textLabel')),
						h('textarea', {
							className: css.textarea,
							value: text,
							maxLength: MAX_TEXT,
							placeholder: t('section.textPlaceholder'),
							onChange: (event) => setText(event.target.value),
						}),
					),
					problem === null ? null : h('p', { className: css.error }, problem),
					h(
						'div',
						{ className: css.formActions },
						// The new-session switch sits at the leading edge of the same
						// row, so "does this prompt apply by itself" reads as a
						// property of the entry, while Cancel and Save stay exactly
						// where the Models editor puts them.
						h(
							'span',
							{ className: css.formToggle },
							h(
								'button',
								{
									type: 'button',
									role: 'switch',
									'aria-checked': byDefault,
									'aria-label': t('section.byDefault'),
									title: t('section.byDefaultHint'),
									className: css.switch,
									disabled: readOnly,
									onClick: () => setByDefault((value) => !value),
								},
								h('span', { className: css.switchThumb }),
							),
							h('span', { className: css.switchLabel }, t('section.byDefault')),
						),
						// Cancel leads the primary action, as the Models editor does. Save is
						// disabled when nothing could be recorded — the editor is normally
						// unreachable then, but the profile can turn read-only underneath an
						// open form, and a live Save button would promise a write it cannot
						// make.
						h('button', { type: 'button', className: css.secondaryButton, onClick: cancel }, t('section.cancel')),
						h(
							'button',
							{ type: 'button', className: css.primaryButton, onClick: save, disabled: readOnly },
							t('section.save'),
						),
					),
				);
			}
		}

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				ctx.effect(() => applyStyles(), 'dsh-prompt-lib: styles');
				ctx.effect(
					() => {
						const disposers = Object.entries(DICTIONARIES).map(([locale, dict]) =>
							ctx.locale.register(NS, locale, dict),
						);
						return () => {
							for (const dispose of disposers) dispose();
						};
					},
					'dsh-prompt-lib: dictionaries',
				);

				const store = createStore();

				// The settings remote is optional: without it both surfaces render
				// their "settings unavailable" state instead of failing to mount.
				// Both names have to be injected — `remote` provides the namespace
				// itself, `remote.settings` the readiness of its contribution.
				ctx.inject(['remote', 'remote.settings'], (scope) => {
					store.bind(
						() => scope.remote.settings.describe(),
						(ops, revision) => scope.remote.settings.mutate(ENTRY_ID, ops, revision),
					);
					scope.effect(() => () => store.unbind(), 'dsh-prompt-lib: settings remote');
				});

				ctx.slots.inject('settings.section', () =>
					ctx.slots.register(
						{
							name: 'settings.section',
							id: 'prompts',
							// Beside Plugins (15) and Agent presets (20), after the
							// built-in configuration pages.
							order: 25,
							// `ctx.locale.bind(ns)` IS the translate function for the
							// namespace; the shell re-reads this thunk whenever the nav
							// ledger or the locale revision changes.
							label: () => ctx.locale.bind(NS)('nav'),
							locale: NS,
							inject: () => ({ store }),
						},
						PromptsSection,
					),
				);

				ctx.slots.inject('conversation.input.left', () =>
					ctx.slots.register(
						{
							name: 'conversation.input.left',
							id: 'prompt-lib',
							order: -10,
							locale: NS,
							inject: () => ({ store }),
						},
						PromptsPicker,
					),
				);

				ctx.effect(
					() => () => {
						store.unbind();
					},
					'dsh-prompt-lib: store',
				);
			},
		};
	},
});
