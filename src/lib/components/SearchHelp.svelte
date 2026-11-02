<script lang="ts">
	let { onClose }: { onClose: () => void } = $props();

	const examples: { token: string; meaning: string }[] = [
		{ token: 'from:abeer', meaning: 'Emails from addresses matching "abeer"' },
		{ token: 'to:team@acme.com', meaning: 'Sent to that address' },
		{ token: 'subject:"quarterly report"', meaning: 'Exact-phrase subject match' },
		{ token: 'body:invoice', meaning: 'Word in the message body' },
		{ token: 'is:unread', meaning: 'Only unread messages' },
		{ token: 'is:starred', meaning: 'Only starred messages' },
		{ token: 'has:attachment', meaning: 'Only messages with attachments' },
		{ token: 'before:2026-01-01', meaning: 'Before that date' },
		{ token: 'after:2025-10-01', meaning: 'On or after that date' },
		{ token: 'in:inbox', meaning: 'Restrict to a system folder' },
		{ token: 'label:"Work Stuff"', meaning: 'Messages with that label' },
		{ token: 'quarterly q4', meaning: 'Bare words search every field, and by meaning once the index is ready' }
	];
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="fixed inset-0 z-40"
	onclick={onClose}
></div>

<div
	class="absolute top-full left-0 mt-2 w-[520px] bg-surface border border-border rounded-lg shadow-xl z-50 p-4 max-h-[400px] overflow-y-auto"
>
	<p class="text-xs font-semibold text-text mb-2">Search operators</p>
	<p class="text-2xs text-text-tertiary mb-3">
		Combine operators with spaces (implicit AND). Quote values with spaces.
		With semantic search on (Settings → Search), bare words also find mail that means the same, in any
		language, and matches are ranked by relevance; <code class="font-mono">body:</code> turns that off.
	</p>
	<div class="grid grid-cols-[180px_1fr] gap-x-3 gap-y-1.5 text-xs">
		{#each examples as ex}
			<code class="text-accent-fg font-mono">{ex.token}</code>
			<span class="text-text-secondary">{ex.meaning}</span>
		{/each}
	</div>
</div>
