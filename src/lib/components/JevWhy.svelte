<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { INBOX_CATEGORIES, type InboxCategory } from '$lib/types/categories';

	/**
	 * "Why is this here?" — Jev's decision for one email: its tab pick, how
	 * sure it was, where the probability went, what it said about your rules'
	 * Jev conditions, and the facts that were sent with the email. Renders
	 * nothing for mail Jev never answered for.
	 */
	export interface JevSpamCheck {
		spam: number;
		phishing: number;
		stalwartSpam: boolean | null;
		/** 'junked' | 'rescued' | 'flagged', or in watch mode 'would_junk' | 'would_rescue' | 'would_flag'. */
		action: string | null;
		correctedTo: 'spam' | 'ham' | null;
	}

	let {
		emailId,
		onSpamCheck
	}: {
		emailId: string;
		/** Tells the message view about the spam verdict, for its banner. */
		onSpamCheck?: (check: JevSpamCheck | null) => void;
	} = $props();

	interface RuleCheck {
		ruleId: string;
		ruleName: string;
		statement: string;
		probability: number;
		threshold: number;
		negate: boolean;
		fired: boolean;
		/** You said this rule shouldn't have fired here. */
		markedWrong: boolean;
	}

	interface Decision {
		/** Null when only rules were asked about (tabs off). */
		category: InboxCategory | null;
		confidence: number | null;
		applied: InboxCategory | null;
		correctedTo: InboxCategory | null;
		probabilities: Record<string, number>;
		facts: Record<string, boolean | string | null>;
		rules: RuleCheck[];
		/** The sender pin that chose the tab, when one did. */
		pinnedBy: string | null;
		spamCheck: JevSpamCheck | null;
		model: string | null;
		mock: boolean;
	}

	let decision = $state<Decision | null>(null);
	let open = $state(false);
	let rootEl = $state<HTMLElement>();
	let chipEl = $state<HTMLButtonElement>();

	// The card floats over the message, so it closes the way other popovers
	// do: Escape, a click anywhere else, or its close button.
	function onWindowKeydown(e: KeyboardEvent) {
		if (!open || e.key !== 'Escape') return;
		const focusInside = rootEl?.contains(document.activeElement) ?? false;
		open = false;
		if (focusInside) chipEl?.focus();
	}

	function onWindowPointerDown(e: PointerEvent) {
		if (open && !rootEl?.contains(e.target as Node)) open = false;
	}

	// A click in the message body lands inside its iframe, and the page never
	// hears it. Focus moving into the iframe is the signal; the window losing
	// focus for any other reason (switching apps) leaves the card open.
	function onWindowBlur() {
		if (!open) return;
		setTimeout(() => {
			if (document.activeElement?.tagName === 'IFRAME') open = false;
		});
	}

	$effect(() => {
		const id = emailId;
		decision = null;
		open = false;
		onSpamCheck?.(null);
		let cancelled = false;
		fetch(`/api/jev/decision/${encodeURIComponent(id)}`)
			.then((res) => (res.ok ? res.json() : null))
			.then((body) => {
				if (cancelled) return;
				decision = (body?.decision as Decision | null) ?? null;
				onSpamCheck?.(decision?.spamCheck ?? null);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	});

	const labelOf = (key: string) => INBOX_CATEGORIES.find((c) => c.key === key)?.label ?? key;
	const percent = (n: number | null | undefined) => `${Math.round((n ?? 0) * 100)}%`;

	// Plain-language names for the facts, phrased as the "yes" case.
	const FACT_LABELS: Record<string, string> = {
		sender_in_contacts: 'Sender is in your contacts',
		you_have_written_to_sender: 'You’ve written to this sender',
		you_have_written_in_this_thread: 'You’ve written in this conversation',
		addressed_to_you_directly: 'Addressed to you directly',
		has_list_unsubscribe: 'Has an unsubscribe link',
		list_id: 'Sent through a mailing list',
		bulk_precedence: 'Marked as bulk mail',
		auto_submitted: 'Sent automatically',
		sender_looks_automated: 'From a no-reply address',
		contains_sign_in_code: 'Contains a sign-in code'
	};

	// Only these come back null for "couldn't tell"; for the rest (a missing
	// list id, say) null simply means no.
	const LOOKED_UP = new Set(['sender_in_contacts', 'you_have_written_to_sender', 'you_have_written_in_this_thread']);

	const factRows = $derived(
		decision
			? Object.entries(FACT_LABELS).map(([key, label]) => {
					const value = decision!.facts[key];
					const unknown = LOOKED_UP.has(key) && (value === null || value === undefined);
					return { label, state: unknown ? 'unknown' : value ? 'yes' : 'no' };
				})
			: []
	);

	const firedRules = $derived(
		decision ? [...new Map(decision.rules.filter((r) => r.fired).map((r) => [r.ruleId, r.ruleName])).values()] : []
	);

	// Moved by the spam check: its tab pick never applied, so don't show one.
	const spamMoved = $derived(
		decision?.spamCheck?.action === 'junked' || decision?.spamCheck?.action === 'rescued'
	);

	const chipLabel = $derived.by(() => {
		if (!decision) return '';
		if (decision.spamCheck?.action === 'junked') return 'moved to Junk';
		if (decision.spamCheck?.action === 'rescued') return 'rescued from Junk';
		if (decision.category) return labelOf(decision.applied ?? decision.category);
		if (decision.rules.length === 0 && decision.spamCheck) return 'spam check';
		return firedRules.length === 1 ? `rule “${firedRules[0]}”` : firedRules.length > 1 ? `${firedRules.length} rules` : 'rules checked';
	});

	const history = $derived(
		typeof decision?.facts.sender_history === 'string' ? decision.facts.sender_history : null
	);

	let feedbackError = $state('');

	async function markWrong(ruleId: string) {
		if (!decision) return;
		feedbackError = '';
		const res = await fetch('/api/jev/rule-feedback', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ emailId, ruleId })
		}).catch(() => null);
		if (!res?.ok) {
			feedbackError = 'Couldn’t save that. Try again.';
			return;
		}
		decision.rules = decision.rules.map((r) => (r.ruleId === ruleId ? { ...r, markedWrong: true } : r));
	}

	const security = $derived(
		(decision?.facts as Record<string, unknown> | undefined)?.security as
			| {
					spf: string | null;
					dkim: string | null;
					dmarc: string | null;
					reply_to_differs: boolean;
					display_name_mismatch: boolean;
					link_domains: string[];
					stalwart_spam_score: number | null;
				}
			| undefined
	);

	const SPAM_ACTIONS: Record<string, string> = {
		junked: 'Jev moved this to Junk.',
		rescued: 'Jev brought this back from Junk.',
		flagged: 'Jev left this here with a warning.',
		would_junk: 'In active mode, Jev would have moved this to Junk.',
		would_rescue: 'In active mode, Jev would have brought this back from Junk.',
		would_flag: 'In active mode, Jev would have shown a warning.'
	};

	const summary = $derived.by(() => {
		if (!decision?.category || spamMoved) return '';
		if (decision.pinnedBy) {
			return `You pinned ${decision.pinnedBy} to ${labelOf(decision.category)}, so Jev wasn’t asked which tab.`;
		}
		const sure = percent(decision.confidence);
		if (decision.correctedTo && decision.correctedTo !== (decision.applied ?? 'important')) {
			return `Jev picked ${labelOf(decision.category)}; you moved it to ${labelOf(decision.correctedTo)}.`;
		}
		if (decision.applied) return `Jev put this in ${labelOf(decision.applied)} (confidence ${sure}).`;
		return `Jev leaned to ${labelOf(decision.category)} (confidence ${sure}) — not sure enough to move it.`;
	});
</script>

<svelte:window onkeydown={onWindowKeydown} onpointerdown={onWindowPointerDown} onblur={onWindowBlur} />

{#if decision}
	<!-- The card floats over the message. In the header's flow it made the
	     header as tall as the card and pushed the message body down.
	     Desktop: it hangs under the chip. Phones: this wrapper isn't
	     positioned, so the card takes its width from the message view and
	     its top from where the chip's line ends. -->
	<div bind:this={rootEl} class="md:relative md:flex md:flex-col md:items-end">
		<button
			bind:this={chipEl}
			type="button"
			onclick={() => (open = !open)}
			aria-expanded={open}
			aria-haspopup="dialog"
			title="Why is this here?"
			class="inline-flex items-center gap-1 text-2xs px-2 py-0.5 rounded-full cursor-pointer bg-accent/10 text-accent-fg hover:bg-accent/15"
		>
			Jev · {chipLabel}{decision.mock ? ' (mock)' : ''}
			<Icon name="dropdown" size={12} class="transition-transform {open ? 'rotate-180' : ''}" />
		</button>

		{#if open}
			<div
				role="dialog"
				aria-label="Why is this here?"
				class="absolute z-20 mt-1 md:right-0 md:top-full max-md:inset-x-4 w-72 max-md:w-auto max-h-[min(30rem,60dvh)] max-md:max-h-[50dvh] overflow-y-auto overscroll-contain rounded-lg border border-border bg-surface p-3 text-xs text-left shadow-xl"
			>
				<div class="flex items-start justify-between gap-2">
					<p class={summary ? 'text-text' : 'text-text-secondary'}>{summary || 'Why is this here?'}</p>
					<button
						type="button"
						onclick={() => (open = false)}
						aria-label="Close"
						class="-mr-1 -mt-0.5 shrink-0 p-0.5 rounded-md cursor-pointer text-text-tertiary hover:text-text hover:bg-surface-hover"
					>
						<Icon name="close" size={12} />
					</button>
				</div>
				{#if decision.mock}
					<p class="mt-1 text-warning">
						Mock answer: worked out locally from the facts below. Jev wasn’t asked.
					</p>
				{/if}

				{#if decision.spamCheck}
					{@const sc = decision.spamCheck}
					<p class="mt-2.5 mb-1 text-3xs uppercase tracking-wider text-text-tertiary font-semibold">Spam check</p>
					<p class="text-text">
						Spam {percent(sc.spam)} · phishing {percent(sc.phishing)}
						{#if sc.stalwartSpam !== null}
							<span class="text-text-tertiary">— Stalwart {sc.stalwartSpam ? 'flagged it' : 'let it through'}{security?.stalwart_spam_score != null ? ` (score ${security.stalwart_spam_score})` : ''}</span>
						{/if}
					</p>
					{#if sc.action && SPAM_ACTIONS[sc.action]}
						<p class="text-text-secondary">{SPAM_ACTIONS[sc.action]}</p>
					{/if}
					{#if sc.correctedTo}
						<p class="text-text-tertiary italic">You marked it {sc.correctedTo === 'spam' ? 'spam' : 'not spam'}.</p>
					{/if}
					{#if security}
						<p class="text-text-tertiary mt-1">
							SPF {security.spf ?? '—'} · DKIM {security.dkim ?? '—'} · DMARC {security.dmarc ?? '—'}
							{#if security.reply_to_differs}<br />Replies go to a different domain.{/if}
							{#if security.display_name_mismatch}<br />The display name names another domain.{/if}
							{#if security.link_domains.length > 0}<br />Links to: {security.link_domains.join(', ')}{/if}
						</p>
					{/if}
				{/if}

				{#if decision.rules.length > 0}
					<p class="mt-2.5 mb-1 text-3xs uppercase tracking-wider text-text-tertiary font-semibold">Your rules</p>
					<ul class="space-y-1.5">
						{#each decision.rules as check, i (i)}
							<li>
								<p class="text-text">
									<Icon name={check.fired ? 'check' : 'rule-miss'} size={12} class="inline align-[-1px] {check.fired ? 'text-success' : 'text-text-tertiary'}" />
									{check.ruleName}{check.fired ? ' fired' : ' didn’t fire'}
								</p>
								<p class="text-text-tertiary">
									{check.negate ? 'Not: ' : ''}“{check.statement}” — {percent(check.probability)}, needs {percent(check.threshold)}
								</p>
								{#if check.fired && (i === 0 || decision.rules[i - 1].ruleId !== check.ruleId)}
									{#if check.markedWrong}
										<p class="text-text-tertiary italic">Noted — counted against this rule.</p>
									{:else}
										<button
											type="button"
											onclick={() => markWrong(check.ruleId)}
											class="text-accent-fg hover:text-accent-fg-hover cursor-pointer"
										>
											Shouldn’t have fired
										</button>
									{/if}
								{/if}
							</li>
						{/each}
					</ul>
					{#if feedbackError}
						<p class="mt-1 text-danger">{feedbackError}</p>
					{/if}
				{/if}

				{#if decision.category && !decision.pinnedBy && !spamMoved}
				<ul class="mt-2.5 space-y-1">
					{#each INBOX_CATEGORIES as c (c.key)}
						{@const p = decision.probabilities[c.key] ?? 0}
						<li class="flex items-center gap-2">
							<span class="w-20 shrink-0 {c.key === decision.category ? 'text-text font-medium' : 'text-text-secondary'}">{c.label}</span>
							<span class="flex-1 h-1.5 rounded-full bg-surface-hover overflow-hidden">
								<span class="block h-full rounded-full bg-accent" style="width: {Math.round(p * 100)}%"></span>
							</span>
							<span class="w-9 shrink-0 text-right tabular-nums text-text-tertiary">{percent(p)}</span>
						</li>
					{/each}
				</ul>
				{/if}

				{#if decision.model}
				<!-- Only when Jev was called: a pinned sender's mail sends nothing. -->
				<p class="mt-3 mb-1 text-3xs uppercase tracking-wider text-text-tertiary font-semibold">
					Sent with the email
				</p>
				<ul class="space-y-0.5">
					{#if history}
						<li class="flex items-start gap-1.5 text-text-secondary">
							<span class="w-3 text-center" aria-hidden="true">↺</span>
							<span>{history}</span>
						</li>
					{/if}
					{#each factRows as f (f.label)}
						<li class="flex items-center gap-1.5 {f.state === 'yes' ? 'text-text-secondary' : 'text-text-tertiary'}">
							<Icon name={f.state === 'yes' ? 'check' : f.state === 'no' ? 'rule-miss' : 'help'} size={12} />
							<span>{f.label}{f.state === 'no' ? ': no' : f.state === 'unknown' ? ': couldn’t check' : ''}</span>
						</li>
					{/each}
				</ul>

					<p class="mt-2 text-3xs text-text-tertiary">Model: {decision.model}</p>
				{/if}
			</div>
		{/if}
	</div>
{/if}
