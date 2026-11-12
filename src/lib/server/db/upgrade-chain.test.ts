import { mkdtempSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from 'better-sqlite3';

vi.mock('$lib/server/log', () => ({ logEvent: vi.fn(), errorFields: (e: unknown) => ({ error: String(e) }) }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

/**
 * The whole upgrade in one start, as the owner will run it: from the
 * database of the build with stages 1 and 2 (SQL migrations up to 027, the
 * two rule data steps done) to this version. Each stage tested its own
 * migration; this tests them together, through the real runner and the real
 * migration files, on rows written the way the app of that build wrote them.
 */

const DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const SQL_FILES = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
/** The migrations, as runMigrations takes them, up to but not including `before`. */
function migrationsBefore(before: string): Record<string, string> {
	return Object.fromEntries(SQL_FILES.filter((f) => f < before).map((f) => [`./migrations/${f}`, readFileSync(join(DIR, f), 'utf8')]));
}
const DATA_STEPS = ['data/rules_exact_only', 'data/rule_tabs_to_pins', 'data/rules_to_table', 'data/drop_unused'];

/** A database of its own, with the app's modules loaded afresh against it. */
async function openDb(tag: string) {
	vi.resetModules();
	process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), `zajel-upgrade-${tag}-`)), 'test.db');
	const { getDb } = await import('./index');
	const migrate = await import('./migrate');
	const { listRules } = await import('../rules/store');
	const autoReply = await import('$lib/server/auto-reply');
	const db = getDb();
	return { db, runMigrations: migrate.runMigrations, MigrationError: migrate.MigrationError, listRules, autoReply };
}
type Opened = Awaited<ReturnType<typeof openDb>>;

const OWNER = 'owner@example.test';
/** The second account's address as it was linked, in mixed case. */
const WORK = 'Work@Example.test';
const A = 'acct-owner';
const B = 'acct-work';
/** A third account, linked since Jev's settings were last saved: it has no row of them. */
const NEW = 'new@example.test';
const C = 'acct-new';
/** The owner's address in another case, as an older login wrote it. */
const OWNER_SHOUTED = 'OWNER@EXAMPLE.TEST';

// ---------------------------------------------------------------------------
// The rules, as the rules page of that build saved them (one JSON list per
// address in `user_rules`): first as written before stage 1, then as the two
// stage 1 and 2 data steps left them.

const c = (id: string, field: string, value: string, op = 'contains') => ({ id, field, op, value, negate: false });
const fromShop = c('c1', 'from', 'shop.example');
const toTeam = c('c2', 'to', 'team@corp.example');
const corpSubject = c('c3', 'subject', '[corp]');
const fromBilling = c('c4', 'from', 'billing');
const jevReceipt = { id: 'c5', field: 'jev', op: 'contains', value: 'it’s an invoice or a receipt', negate: false, strictness: 'strict' };
const projectX = c('c6', 'subject', 'Project X');
const fromNews = c('c7', 'from', 'news@example.com');
const fromLetters = c('c8', 'from', 'letters.example');
const subjectSpam = c('c9', 'subject', 'WIN A PRIZE');
const fromBoss = c('c10', 'from', 'boss@corp.example');

const T = 1_762_000_000_000;
/** Before stage 1: what a browser sent. */
const RAW_OWNER_RULES = [
	// Only put one sender in a tab: became a pin in stage 2. (First: after
	// a rule that stops processing, stage 2 would have left it a rule.)
	{ id: 'r5', name: 'News to Updates', enabled: true, logic: 'allof', conditions: [fromNews], actions: [{ type: 'setCategory', value: 'updates' }], createdAt: T + 5 },
	// Files in three places, marks read and important, and stops.
	{
		id: 'r1',
		name: 'Receipts',
		enabled: true,
		logic: 'allof',
		conditions: [fromShop],
		actions: [
			{ type: 'applyLabel', value: 'L-receipts' },
			{ type: 'applyLabel', value: 'L-money' },
			{ type: 'moveToFolder', value: 'F-receipts' },
			{ type: 'markRead' },
			{ type: 'markImportant' },
			{ type: 'stopProcessing' }
		],
		createdAt: T + 1
	},
	// One target.
	{ id: 'r2', name: 'Work', enabled: true, logic: 'anyof', conditions: [toTeam, corpSubject], actions: [{ type: 'applyLabel', value: 'L-work' }], createdAt: T + 2 },
	// A condition Jev judged: switched off and flagged by stage 1.
	{
		id: 'r3',
		name: 'Invoices',
		enabled: true,
		logic: 'allof',
		conditions: [fromBilling, jevReceipt],
		actions: [{ type: 'moveToFolder', value: 'F-receipts' }],
		createdAt: T + 3
	},
	// Its folder was deleted long ago.
	{ id: 'r4', name: 'Old project', enabled: true, logic: 'allof', conditions: [projectX], actions: [{ type: 'moveToFolder', value: 'F-deleted' }], createdAt: T + 4 },
	// A label and a tab: the tab dropped in stage 2, the label kept.
	{
		id: 'r6',
		name: 'Letters',
		enabled: true,
		logic: 'allof',
		conditions: [fromLetters],
		actions: [
			{ type: 'applyLabel', value: 'L-news' },
			{ type: 'setCategory', value: 'newsletters' }
		],
		createdAt: T + 6
	},
	// Switched off, deletes; and an action the page added but nothing was picked for.
	{
		id: 'r7',
		name: 'Prizes',
		enabled: false,
		logic: 'allof',
		conditions: [subjectSpam],
		actions: [{ type: 'delete' }, { type: 'applyLabel' }],
		createdAt: T + 7
	}
];
const RAW_WORK_RULES = [
	{ id: 'b1', name: 'Boss', enabled: true, logic: 'allof', conditions: [fromBoss], actions: [{ type: 'applyLabel', value: 'BL-boss' }], createdAt: T + 8 }
];
/** Under another spelling of the owner's address: never the owner's, who has a list of their own. */
const RAW_SHOUTED_RULES = [{ id: 's1', name: 'Stale', enabled: true, logic: 'allof', conditions: [fromShop], actions: [{ type: 'applyLabel', value: 'L-stale' }], createdAt: T + 10 }];
/** An address no account has any more: its rules are left where they are. */
const RAW_GONE_RULES = [{ id: 'g1', name: 'Gone', enabled: true, logic: 'allof', conditions: [fromShop], actions: [{ type: 'markRead' }], createdAt: T + 9 }];

const legacy = (rule: (typeof RAW_OWNER_RULES)[number]) => ({
	enabled: rule.enabled,
	logic: rule.logic,
	conditions: rule.conditions,
	actions: rule.actions
});
const [r5, r1, r2, r3, r4, r6, r7] = RAW_OWNER_RULES;
/** After the stage 1 and 2 data steps, as the owner's database holds them. */
const STAGE2_OWNER_RULES = [
	{
		...r5,
		enabled: false,
		actions: [],
		attention: 'tab_pinned',
		legacy: legacy(r5),
		tabNote: { tab: 'updates', pin: { sender: 'news@example.com', category: 'updates' }, op: 'contains', said: 'news@example.com' }
	},
	r1,
	r2,
	{ ...r3, enabled: false, attention: 'jev_condition', conditions: [fromBilling], legacy: legacy(r3) },
	r4,
	{ ...r6, actions: [{ type: 'applyLabel', value: 'L-news' }], attention: 'tab_removed', legacy: legacy(r6) },
	r7
];

/** The rules table after the upgrade, for the first account, as stage 5 specified it. */
const EXPECTED_OWNER_RULES = [
	{
		id: 'r5',
		position: 0,
		name: 'News to Updates',
		enabled: false,
		logic: 'allof',
		conditions: [fromNews],
		target: { kind: 'none' },
		markRead: false,
		star: false,
		stop: false,
		createdAt: T + 5,
		attention: 'tab_pinned',
		note: { tab: { tab: 'updates', pin: { sender: 'news@example.com', category: 'updates' }, op: 'contains', said: 'news@example.com' } },
		legacy: legacy(r5)
	},
	{ id: 'r1', position: 1, name: 'Receipts', enabled: true, logic: 'allof', conditions: [fromShop], target: { kind: 'label', mailboxId: 'L-receipts' }, markRead: true, star: true, stop: false, createdAt: T + 1 },
	{
		id: 'r1~2',
		position: 2,
		name: 'Receipts',
		enabled: true,
		logic: 'allof',
		conditions: [fromShop],
		target: { kind: 'label', mailboxId: 'L-money' },
		markRead: false,
		star: false,
		stop: false,
		createdAt: T + 1,
		attention: 'split',
		note: { splitInto: 3 }
	},
	{
		id: 'r1~3',
		position: 3,
		name: 'Receipts',
		enabled: true,
		logic: 'allof',
		conditions: [fromShop],
		target: { kind: 'folder', mailboxId: 'F-receipts' },
		markRead: false,
		star: false,
		stop: true,
		createdAt: T + 1,
		attention: 'split',
		note: { splitInto: 3 }
	},
	{ id: 'r2', position: 4, name: 'Work', enabled: true, logic: 'anyof', conditions: [toTeam, corpSubject], target: { kind: 'label', mailboxId: 'L-work' }, markRead: false, star: false, stop: false, createdAt: T + 2 },
	{
		id: 'r3',
		position: 5,
		name: 'Invoices',
		enabled: false,
		logic: 'allof',
		conditions: [fromBilling],
		target: { kind: 'folder', mailboxId: 'F-receipts' },
		markRead: false,
		star: false,
		stop: false,
		createdAt: T + 3,
		attention: 'jev_condition',
		legacy: legacy(r3)
	},
	{ id: 'r4', position: 6, name: 'Old project', enabled: true, logic: 'allof', conditions: [projectX], target: { kind: 'folder', mailboxId: 'F-deleted' }, markRead: false, star: false, stop: false, createdAt: T + 4 },
	{
		id: 'r6',
		position: 7,
		name: 'Letters',
		enabled: true,
		logic: 'allof',
		conditions: [fromLetters],
		target: { kind: 'label', mailboxId: 'L-news' },
		markRead: false,
		star: false,
		stop: false,
		createdAt: T + 6,
		attention: 'tab_removed',
		legacy: legacy(r6)
	},
	{ id: 'r7', position: 8, name: 'Prizes', enabled: false, logic: 'allof', conditions: [subjectSpam], target: { kind: 'trash' }, markRead: false, star: false, stop: false, createdAt: T + 7 }
];
const EXPECTED_WORK_RULES = [
	{ id: 'b1', position: 0, name: 'Boss', enabled: true, logic: 'allof', conditions: [fromBoss], target: { kind: 'label', mailboxId: 'BL-boss' }, markRead: false, star: false, stop: false, createdAt: T + 8 }
];

/** A rule as listed, without the time of the upgrade. */
const rulesOf = (o: Opened, accountId: string) => o.listRules(accountId).map(({ updatedAt: _u, ...r }) => r);

const PREFS = JSON.stringify({
	theme: 'dark',
	auto_reply_enabled: 'on',
	auto_reply_subject: 'Away',
	auto_reply_body: 'Back on Monday.'
});
const SORT_CURSOR = '2026-11-10T08:15:00Z';
/**
 * The second account's place in Jev's settings: Jev is off there, but its
 * pins sorted new mail, and the worker moved this on as they did, written
 * by toISOString.
 */
const WORK_SORT_CURSOR = '2026-11-10T08:15:42.317Z';

/**
 * The owner's database at the build before this upgrade, or (with
 * `beforeStage1`) at the build before that, whose rules hadn't been through
 * the stage 1 and 2 data steps yet.
 */
function buildOldDatabase(o: Opened, { beforeStage1 = false } = {}): void {
	const { db } = o;
	// The real migration files up to 027. The runner records the two rule
	// steps as it goes (there are no rules yet): the owner's database has
	// both. One from before stage 1 has neither.
	o.runMigrations(migrationsBefore('028'));
	if (beforeStage1) db.prepare(`DELETE FROM _migrations WHERE name LIKE 'data/%'`).run();

	db.exec(`
		INSERT INTO app_user (id, email, password_hash) VALUES ('u1', 'login@example.test', 'scrypt-hash');
		INSERT INTO mail_accounts (id, user_id, email, server_url, jmap_account_id, secret_enc, display_name, sort_order) VALUES
			('${A}', 'u1', '${OWNER}', 'https://mail.example.test', 'jmap-a', 'iv.tag.secret', 'Owner', 0),
			('${B}', 'u1', '${WORK}', 'https://mail.example.test', 'jmap-b', 'iv.tag.secret', NULL, 1),
			('${C}', 'u1', '${NEW}', 'https://mail.example.test', 'jmap-c', 'iv.tag.secret', NULL, 2);
		-- Its password was changed on the mail server: it waits to be signed in again.
		UPDATE mail_accounts SET needs_reauth = 1 WHERE id = '${B}';
		INSERT INTO app_prefs (user_id, prefs) VALUES ('u1', '${PREFS}');

		-- The rules scheduler's place, by address: the owner's is earlier than
		-- Jev's. Another spelling of the owner's, earlier still, is not theirs.
		INSERT INTO rules_cursor (user_email, last_run) VALUES
			('${OWNER}', '2026-11-10T08:14:30.000Z'),
			('${OWNER_SHOUTED}', '2026-11-01T00:00:00.000Z'),
			('${WORK}', '2026-11-10T08:16:00.000Z'),
			('${NEW}', '2026-11-10T08:17:00.000Z'),
			('gone@example.test', '2026-01-01T00:00:00.000Z');

		-- Colours and icons, by address; '' for "no icon", as the labels page
		-- saved it. The folder row for the second account was written under
		-- its address in lower case. A newer row under another spelling of
		-- the owner's address was never what the owner saw.
		INSERT INTO label_meta (user_email, mailbox_id, display_name, color, icon, updated_at) VALUES
			('${OWNER}', 'L-receipts', 'Receipts', '#f59e0b', 'receipt', '2026-10-01 09:00:00'),
			('${OWNER}', 'L-work', 'Work stuff', '#3b82f6', '', '2026-10-02 09:00:00'),
			('${OWNER_SHOUTED}', 'L-receipts', 'Stale', '#000000', '', '2026-10-20 09:00:00'),
			('${WORK}', 'BL-boss', 'Boss', '#8b5cf6', '', '2026-10-03 09:00:00');
		INSERT INTO folder_meta (user_email, mailbox_id, display_name, color, icon, updated_at) VALUES
			('${OWNER}', 'F-receipts', 'Receipts', '#10b981', 'folder', '2026-10-04 09:00:00'),
			('work@example.test', 'BF-clients', 'Clients', '#ef4444', 'briefcase', '2026-10-05 09:00:00');

		-- Jev on for the first account (tabs on, watching for spam), off for
		-- the second (tabs on, sorted by its pin). None saved for the third.
		INSERT INTO jev_settings (account_id, inbox_tabs, jev_enabled, sort_cursor, spam_mode, updated_at) VALUES
			('${A}', 1, 1, '${SORT_CURSOR}', 'watch', ${T}),
			('${B}', 1, 0, '${WORK_SORT_CURSOR}', 'off', ${T});

		INSERT INTO jev_sender_pins (account_id, sender, category, created_at) VALUES
			('${A}', '@shop.example', 'promotions', ${T}),
			('${B}', 'ceo@corp.example', 'important', ${T});
		INSERT INTO jev_sender_moves (account_id, sender, category, moves, last_moved_at) VALUES
			('${A}', 'deals@shop.example', 'promotions', 3, ${T});
		INSERT INTO jev_usage (account_id, month, requests, input_tokens) VALUES ('${A}', '2026-11', 42, 54000);

		-- Jev's queue and record: one waiting, one answered (with its answers
		-- about a rule's Jev condition, from before stage 1), one you moved
		-- afterwards, and one you chose before Jev saw it.
		INSERT INTO jev_decisions (account_id, email_id, status, attempts, created_at) VALUES ('${A}', 'e-pending', 'pending', 1, ${T + 100});
		INSERT INTO jev_decisions
			(account_id, email_id, status, attempts, category, confidence, applied, answers_json, facts_json, model, input_tokens,
			 created_at, decided_at, rules_json, pinned_by, spam, phishing, stalwart_spam, spam_action)
		VALUES
			('${A}', 'e-done', 'done', 1, 'updates', 0.92, 'updates', '{"category":{"probabilities":{"updates":0.92}}}', '{"sender_known":true}',
			 'jev-model', 1200, ${T + 200}, ${T + 201}, '[{"ruleId":"r3","probability":0.97,"fired":true}]', NULL, 0.02, 0.01, 0, NULL),
			('${A}', 'e-corrected', 'done', 1, 'promotions', 0.81, 'promotions', '{}', '{}', 'jev-model', 900, ${T + 300}, ${T + 301}, NULL,
			 NULL, NULL, NULL, NULL, NULL),
			('${A}', 'e-pinned', 'done', 1, 'promotions', NULL, 'promotions', NULL, '{}', NULL, NULL, ${T + 400}, ${T + 401}, NULL,
			 '@shop.example', NULL, NULL, NULL, NULL);
		UPDATE jev_decisions SET corrected_to = 'important' WHERE email_id = 'e-corrected';
		INSERT INTO jev_decisions (account_id, email_id, status, backfill, corrected_to, created_at, decided_at)
			VALUES ('${A}', 'e-chosen', 'done', 0, 'newsletters', ${T + 500}, ${T + 500});
		-- One given up on, one that left the Inbox first, and a sort of
		-- existing mail you asked for: one sorted, one waiting.
		INSERT INTO jev_decisions (account_id, email_id, status, attempts, last_error, backfill, created_at, decided_at) VALUES
			('${A}', 'e-failed', 'failed', 5, 'TypeSafe: 503', 0, ${T + 700}, ${T + 760}),
			('${A}', 'e-skipped', 'skipped', 0, NULL, 0, ${T + 800}, ${T + 801}),
			('${A}', 'e-backfill-done', 'done', 1, NULL, 1, ${T + 900}, ${T + 901}),
			('${A}', 'e-backfill-pending', 'pending', 0, NULL, 1, ${T + 1000}, NULL);
		UPDATE jev_decisions SET category = 'updates', applied = 'updates', model = 'jev-model' WHERE email_id = 'e-backfill-done';
		INSERT INTO jev_rule_feedback (account_id, rule_id, email_id, created_at) VALUES ('${A}', 'r3', 'e-done', ${T + 600});
	`);

	const storeRules = db.prepare('INSERT INTO user_rules (user_email, rules_json) VALUES (?, ?)');
	if (beforeStage1) {
		storeRules.run(OWNER, JSON.stringify(RAW_OWNER_RULES));
	} else {
		storeRules.run(OWNER, JSON.stringify(STAGE2_OWNER_RULES));
		// The pin stage 2 made of rule r5.
		db.prepare(`INSERT INTO jev_sender_pins (account_id, sender, category, created_at) VALUES (?, 'news@example.com', 'updates', ?)`).run(A, T + 10);
	}
	storeRules.run(WORK, JSON.stringify(RAW_WORK_RULES));
	storeRules.run(OWNER_SHOUTED, JSON.stringify(RAW_SHOUTED_RULES));
	storeRules.run('gone@example.test', JSON.stringify(RAW_GONE_RULES));
}

const markers = (db: Database) => (db.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[]).map((r) => r.name);
const hasTable = (db: Database, name: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
const columnsOf = (db: Database, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const decisions = (db: Database) => db.prepare('SELECT * FROM jev_decisions ORDER BY email_id').all() as Record<string, unknown>[];
const pins = (db: Database) => db.prepare('SELECT account_id, sender, category FROM jev_sender_pins ORDER BY account_id, sender').all();
const meta = (db: Database) =>
	db.prepare('SELECT account_id, mailbox_id, color, icon, display_name FROM mailbox_meta ORDER BY account_id, mailbox_id').all();

/** Every table's rows and the schema: the whole database, to compare. */
function snapshot(db: Database) {
	const tables = (db.prepare(`SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string; sql: string | null }[]);
	return tables.map(({ name, sql }) => ({
		name,
		sql,
		rows: sql?.startsWith('CREATE TABLE') ? db.prepare(`SELECT * FROM "${name}" ORDER BY 1, 2`).all() : null
	}));
}

/** What every upgraded database holds, however it got there. */
function expectUpgraded(o: Opened) {
	const { db } = o;
	// Every rule, in order, split, flagged and noted as stage 5 specified.
	expect(rulesOf(o, A)).toEqual(EXPECTED_OWNER_RULES);
	expect(rulesOf(o, B)).toEqual(EXPECTED_WORK_RULES);
	expect(rulesOf(o, C)).toEqual([]);
	// The pin rule r5 became, beside the owner's own.
	expect(pins(db)).toEqual([
		{ account_id: A, sender: '@shop.example', category: 'promotions' },
		{ account_id: A, sender: 'news@example.com', category: 'updates' },
		{ account_id: B, sender: 'ceo@corp.example', category: 'important' }
	]);
	// Colours and icons per account; the lower-case address found its
	// account, and the other spelling of the owner's changed nothing.
	expect(meta(db)).toEqual([
		{ account_id: A, mailbox_id: 'F-receipts', color: '#10b981', icon: 'folder', display_name: null },
		{ account_id: A, mailbox_id: 'L-receipts', color: '#f59e0b', icon: 'receipt', display_name: 'Receipts' },
		{ account_id: A, mailbox_id: 'L-work', color: '#3b82f6', icon: null, display_name: 'Work stuff' },
		{ account_id: B, mailbox_id: 'BF-clients', color: '#ef4444', icon: 'briefcase', display_name: null },
		{ account_id: B, mailbox_id: 'BL-boss', color: '#8b5cf6', icon: null, display_name: 'Boss' }
	]);
	// The pipeline starts each account from the earlier of its two old
	// places (the third has only the rules'), never another spelling's.
	expect(db.prepare('SELECT account_id, cursor FROM mail_pipeline ORDER BY account_id').all()).toEqual([
		{ account_id: C, cursor: '2026-11-10T08:17:00.000Z' },
		{ account_id: A, cursor: '2026-11-10T08:14:30.000Z' },
		{ account_id: B, cursor: WORK_SORT_CURSOR }
	]);
	// Jev's own place is renamed, kept as it was, Jev on or off (a pass
	// clears it where Jev is off). Still no settings for the third account.
	expect(db.prepare('SELECT account_id, inbox_tabs, jev_enabled, jev_since, spam_mode FROM jev_settings ORDER BY account_id').all()).toEqual([
		{ account_id: A, inbox_tabs: 1, jev_enabled: 1, jev_since: SORT_CURSOR, spam_mode: 'watch' },
		{ account_id: B, inbox_tabs: 1, jev_enabled: 0, jev_since: WORK_SORT_CURSOR, spam_mode: 'off' }
	]);
	// The accounts as they were, the one waiting to be signed in again still waiting.
	expect(db.prepare('SELECT id, email, needs_reauth FROM mail_accounts ORDER BY sort_order').all()).toEqual([
		{ id: A, email: OWNER, needs_reauth: 0 },
		{ id: B, email: WORK, needs_reauth: 1 },
		{ id: C, email: NEW, needs_reauth: 0 }
	]);
	// New tables there and empty.
	for (const table of ['account_tasks', 'auto_reply_log', 'mail_arrivals']) {
		expect(hasTable(db, table)).toBe(true);
		expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
	}
	// What nothing uses is gone; the old rules and colours are kept as they were.
	expect(hasTable(db, 'rules_cursor')).toBe(false);
	expect(hasTable(db, 'jev_rule_feedback')).toBe(false);
	expect(columnsOf(db, 'jev_decisions')).not.toContain('rules_json');
	for (const table of ['user_rules', 'label_meta', 'folder_meta']) expect(hasTable(db, table)).toBe(true);
	expect(db.prepare('SELECT user_email FROM user_rules ORDER BY user_email').all()).toEqual([
		{ user_email: OWNER_SHOUTED },
		{ user_email: WORK },
		{ user_email: 'gone@example.test' },
		{ user_email: OWNER }
	]);
	expect(db.prepare('SELECT COUNT(*) AS n FROM label_meta').get()).toEqual({ n: 4 });
	expect(db.prepare('SELECT COUNT(*) AS n FROM folder_meta').get()).toEqual({ n: 2 });
	// The preferences are as they were; out-of-office, never sent by this
	// build, stays off until it is saved again.
	const { prefs } = db.prepare(`SELECT prefs FROM app_prefs WHERE user_id = 'u1'`).get() as { prefs: string };
	expect(prefs).toBe(PREFS);
	expect(o.autoReply.autoReplyActiveAt(o.autoReply.autoReplySettings(JSON.parse(prefs)), new Date())).toBe(false);
	// Every migration and step recorded.
	expect(markers(db)).toEqual([...SQL_FILES, ...DATA_STEPS].sort());
}

describe('upgrading the owner’s database (stages 1 and 2 done) in one start', () => {
	let o: Opened;
	let decisionsBefore: Record<string, unknown>[];
	let before: ReturnType<typeof snapshot>;

	let announced: string[];

	beforeAll(async () => {
		o = await openDb('owner');
		buildOldDatabase(o);
		expect(markers(o.db)).toEqual([...SQL_FILES.filter((f) => f < '028'), 'data/rule_tabs_to_pins', 'data/rules_exact_only'].sort());
		decisionsBefore = decisions(o.db);
		// What the upgrade says, and that it says it before it changes anything.
		const said = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
			if (String(line).includes('Upgrading')) expect(markers(o.db)).not.toContain('028_account_tasks.sql');
		});
		o.runMigrations();
		announced = said.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('Upgrading'));
		said.mockRestore();
	});

	it('says, before it starts, which database it is upgrading and what is to run', () => {
		expect(announced).toEqual([
			`[migrate] Upgrading the database at ${process.env.DATABASE_PATH}: 6 migrations and 2 one-time steps to apply`
		]);
	});

	it('brings every rule, colour, place and setting across, and drops only what nothing uses', () => {
		expectUpgraded(o);
	});

	it('leaves Jev’s decisions as they were, but for the rule answers nothing reads', () => {
		expect(decisions(o.db)).toEqual(decisionsBefore.map(({ rules_json: _r, ...row }) => row));
		expect(decisions(o.db).map((d) => [d.email_id, d.status, d.backfill, d.corrected_to])).toEqual([
			['e-backfill-done', 'done', 1, null],
			['e-backfill-pending', 'pending', 1, null],
			['e-chosen', 'done', 0, 'newsletters'],
			['e-corrected', 'done', 0, 'important'],
			['e-done', 'done', 0, null],
			['e-failed', 'failed', 0, null],
			['e-pending', 'pending', 0, null],
			['e-pinned', 'done', 0, null],
			['e-skipped', 'skipped', 0, null]
		]);
	});

	it('changes nothing when the app starts again, and says nothing', () => {
		before = snapshot(o.db);
		const said = vi.spyOn(console, 'log').mockImplementation(() => {});
		o.runMigrations();
		expect(snapshot(o.db)).toEqual(before);
		expect(said.mock.calls.filter(([line]) => String(line).includes('Upgrading'))).toEqual([]);
		said.mockRestore();
	});

	it('changes nothing when its last step runs again, its marker lost', () => {
		const withoutMarkers = () => snapshot(o.db).filter((t) => t.name !== '_migrations');
		const before = withoutMarkers();
		o.db.prepare(`DELETE FROM _migrations WHERE name = 'data/drop_unused'`).run();
		expect(() => o.runMigrations()).not.toThrow();
		expect(withoutMarkers()).toEqual(before);
		expect(markers(o.db)).toContain('data/drop_unused');
	});
});

describe('upgrading from before stage 1 in one start', () => {
	let o: Opened;
	let announced: string[];

	beforeAll(async () => {
		o = await openDb('before-stage-1');
		buildOldDatabase(o, { beforeStage1: true });
		expect(markers(o.db).filter((m) => m.startsWith('data/'))).toEqual([]);
		const said = vi.spyOn(console, 'log').mockImplementation(() => {});
		o.runMigrations();
		announced = said.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('Upgrading'));
		said.mockRestore();
	});

	it('runs the three rule steps in order and ends in the same shape', () => {
		expectUpgraded(o);
		expect(announced).toEqual([
			`[migrate] Upgrading the database at ${process.env.DATABASE_PATH}: 6 migrations and 4 one-time steps to apply`
		]);
	});

	it('leaves the old list exactly as the stage 1 and 2 steps would have, the copy the owner’s database holds', () => {
		const stored = (email: string) => JSON.parse((o.db.prepare('SELECT rules_json FROM user_rules WHERE user_email = ?').get(email) as { rules_json: string }).rules_json);
		expect(stored(OWNER)).toEqual(STAGE2_OWNER_RULES);
		expect(stored(WORK)).toEqual(RAW_WORK_RULES);
		expect(stored('gone@example.test')).toEqual(RAW_GONE_RULES);
	});
});

describe('an upgrade interrupted in its last step', () => {
	let o: Opened;

	beforeAll(async () => {
		o = await openDb('interrupted');
		buildOldDatabase(o);
		// Something in the database the last step can't get past: a view on
		// the column it drops. The step fails after dropping the tables.
		o.db.exec('CREATE VIEW boom AS SELECT rules_json FROM jev_decisions');
	});

	it('keeps what the earlier steps did, leaves nothing of the failed one, and finishes on the next start', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		let thrown: unknown;
		try {
			o.runMigrations();
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(o.MigrationError);
		expect((thrown as InstanceType<typeof o.MigrationError>).migration).toBe('data/drop_unused');

		// The earlier steps' work is kept.
		expect(markers(o.db)).toEqual([...SQL_FILES, ...DATA_STEPS.filter((s) => s !== 'data/drop_unused')].sort());
		expect(rulesOf(o, A)).toEqual(EXPECTED_OWNER_RULES);
		expect(meta(o.db)).toHaveLength(5);
		// Nothing of the failed step: both tables and the column are still there, with their rows.
		expect(o.db.prepare('SELECT COUNT(*) AS n FROM rules_cursor').get()).toEqual({ n: 5 });
		expect(o.db.prepare('SELECT COUNT(*) AS n FROM jev_rule_feedback').get()).toEqual({ n: 1 });
		expect(columnsOf(o.db, 'jev_decisions')).toContain('rules_json');

		// Once what stopped it is gone, the next start completes.
		o.db.exec('DROP VIEW boom');
		o.runMigrations();
		expectUpgraded(o);
	});
});
