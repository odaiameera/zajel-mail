<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import RuleAttention from './RuleAttention.svelte';
	import RuleEditor from './RuleEditor.svelte';
	import type { Mailbox } from '$lib/jmap/types';
	import type { Label } from '$lib/types/labels';
	import type { Rule, RuleTarget } from '$lib/types/rules';

	/**
	 * One rule in a dialog: what an upgrade did to it, if anything, and its
	 * editor. Full width on a phone. Nothing is sent until Save.
	 */
	let {
		rule,
		initialTarget,
		mailboxes,
		labels,
		busy,
		error = '',
		onSaved,
		onDeleted,
		onDismiss,
		onPin,
		onClose
	}: {
		/** The rule to edit, or null for a new one. */
		rule: Rule | null;
		/** For a new rule: where it files mail to begin with. */
		initialTarget?: RuleTarget;
		mailboxes: Mailbox[];
		labels: Label[];
		/** A change to the list is being saved. */
		busy: boolean;
		/** What went wrong with the last change made from here (a "Got it", a pin). */
		error?: string;
		onSaved: (rule: Rule, apply: boolean) => void;
		onDeleted: (id: string) => void;
		onDismiss: (id: string) => void;
		onPin: (id: string) => void;
		onClose: () => void;
	} = $props();

	let panel = $state<HTMLElement | null>(null);

	$effect(() => {
		panel?.focus();
	});

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
		}
	}
</script>

<div
	class="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
	role="presentation"
	onclick={(e) => {
		if (e.target === e.currentTarget) onClose();
	}}
	{onkeydown}
>
	<div
		bind:this={panel}
		class="bg-surface border border-border rounded-xl w-full max-w-2xl mx-4 max-h-[calc(100dvh-2rem)] overflow-y-auto p-6 shadow-[0_8px_32px_rgba(0,0,0,0.45)] outline-none
			max-md:mx-0 max-md:h-full max-md:max-h-none max-md:rounded-none max-md:border-0 max-md:p-4 max-md:pt-[calc(1rem+env(safe-area-inset-top))]"
		role="dialog"
		aria-modal="true"
		aria-labelledby="rule-dialog-title"
		tabindex="-1"
	>
		<div class="flex items-start justify-between gap-4 mb-4">
			<h2 id="rule-dialog-title" class="text-lg font-semibold text-text min-w-0 truncate">
				{rule ? rule.name || 'Untitled rule' : 'New rule'}
			</h2>
			<button
				type="button"
				class="text-text-tertiary hover:text-text transition-colors cursor-pointer shrink-0"
				onclick={onClose}
				aria-label="Close"
			>
				<Icon name="close" size={20} />
			</button>
		</div>

		<div class="flex flex-col gap-5">
			{#if error}
				<p class="px-3 py-2 rounded-lg bg-danger/10 border border-danger/20 text-danger text-xs" role="alert">{error}</p>
			{/if}
			{#if rule}
				<RuleAttention {rule} {busy} {onDismiss} {onPin} />
			{/if}
			<!-- What is left of a rule that became a pin is only its note: there is nothing to edit. -->
			{#if rule?.attention !== 'tab_pinned'}
				<RuleEditor {rule} {initialTarget} {mailboxes} {labels} {onSaved} {onDeleted} onCancel={onClose} />
			{/if}
		</div>
	</div>
</div>
