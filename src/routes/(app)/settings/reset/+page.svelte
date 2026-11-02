<script lang="ts">
	import { pageTitle } from '$lib/utils/title';
	import { goto, invalidateAll } from '$app/navigation';

	let resetting = $state(false);

	async function resetAll() {
		if (!confirm('Reset these settings to their defaults on every browser?')) return;
		resetting = true;
		try {
			await fetch('/api/preferences/reset', { method: 'POST' });
			await invalidateAll();
			goto('/settings/account');
		} finally {
			resetting = false;
		}
	}
</script>

<svelte:head><title>{pageTitle({ page: 'Reset', subtitle: 'Settings' })}</title></svelte:head>

<header class="mb-6">
	<h1 class="text-xl font-semibold text-text">Reset</h1>
	<p class="text-sm text-text-tertiary mt-1 max-w-prose">
		Put the settings that Import / Export covers back to their defaults, on every browser.
	</p>
</header>

<section>
	<div class="rounded-xl border border-danger/30 bg-danger/5 p-4 flex items-start gap-4">
		<div class="flex-1">
			<p class="text-sm font-medium text-danger">Reset all preferences</p>
			<p class="text-xs text-text-tertiary mt-1">
				Appearance, Messages, Composer, Notifications, Calendar and Auto-reply text, messages per page
				and which folders are expanded. Your mail, name and photo, linked accounts, sign-in, signatures,
				rules, folder and label colours, and Jev, Search, Agent and Telegram settings stay. Auto-reply on the mail
				server stays on until you save Settings → Auto-reply.
			</p>
		</div>
		<button
			onclick={resetAll}
			disabled={resetting}
			class="btn btn-danger shrink-0"
		>
			{resetting ? 'Resetting…' : 'Reset'}
		</button>
	</div>
</section>
