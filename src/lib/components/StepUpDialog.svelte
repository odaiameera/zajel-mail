<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { startAuthentication } from '@simplewebauthn/browser';
	import { stepUpPrompt } from '$lib/auth/step-up';

	// The ways this login can re-check, fetched each time the dialog opens.
	let methods = $state<{ passkey: boolean; totp: boolean; password: boolean } | null>(null);
	let value = $state('');
	let busy = $state(false);
	let failed = $state<string | null>(null);

	const resolve = $derived($stepUpPrompt);

	$effect(() => {
		if (!resolve) return;
		methods = null;
		value = '';
		failed = null;
		void fetch('/api/auth/step-up')
			.then((res) => (res.ok ? res.json() : null))
			.then((m) => (methods = m));
	});

	async function send(body: Record<string, unknown>) {
		const res = await fetch('/api/auth/step-up', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (res.ok) {
			resolve?.(true);
			return;
		}
		failed = res.status === 429 ? 'Too many attempts. Try again in a few minutes.' : 'That didn’t work';
	}

	async function usePasskey() {
		if (busy) return;
		busy = true;
		failed = null;
		try {
			const options = await fetch('/api/auth/passkey/login/options', { method: 'POST' }).then((r) => r.json());
			const passkey = await startAuthentication({ optionsJSON: options });
			await send({ passkey });
		} catch (err) {
			if ((err as Error)?.name !== 'NotAllowedError') failed = 'That didn’t work';
		} finally {
			busy = false;
		}
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (busy || !value.trim() || !methods) return;
		busy = true;
		failed = null;
		try {
			await send(methods.password ? { password: value } : { code: value });
		} finally {
			busy = false;
		}
	}

	const inputClass =
		'w-full bg-surface-hover border border-border rounded-lg px-3 py-2 text-sm text-text ' +
		'placeholder-text-tertiary outline-none focus:border-accent transition-colors';
</script>

{#if resolve}
	<div
		class="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
		role="dialog"
		aria-modal="true"
		aria-labelledby="step-up-title"
		tabindex="-1"
		onclick={(e) => {
			if (e.target === e.currentTarget) resolve(false);
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				resolve(false);
			}
		}}
	>
		<div class="bg-surface border border-border rounded-xl w-full max-w-sm mx-4 p-6 shadow-[0_8px_32px_rgba(0,0,0,0.45)]" role="document">
			<h2 id="step-up-title" class="text-base font-semibold text-text mb-4">Confirm it’s you</h2>

			{#if failed}
				<div class="bg-danger/10 border border-danger/20 text-danger text-sm rounded-lg px-3 py-2 mb-3">{failed}</div>
			{/if}

			{#if methods}
				<div class="space-y-3">
					{#if methods.passkey}
						<button type="button" class="btn btn-secondary btn-lg w-full" disabled={busy} onclick={usePasskey}>
							<Icon name="passkey" size={16} />
							Use a passkey
						</button>
					{/if}
					{#if methods.totp || methods.password}
						<form class="space-y-3" onsubmit={submit}>
							{#if methods.password}
								<input bind:value type="password" autocomplete="current-password" aria-label="Password" placeholder="Password" class={inputClass} />
							{:else}
								<input
									bind:value
									inputmode="numeric"
									autocomplete="one-time-code"
									aria-label="Code"
									placeholder="Code"
									class={inputClass}
								/>
							{/if}
							<button type="submit" class="btn btn-primary btn-lg w-full" disabled={busy || !value.trim()}>Confirm</button>
						</form>
					{/if}
				</div>
			{/if}

			<div class="flex justify-end mt-4">
				<button type="button" class="btn btn-ghost" onclick={() => resolve(false)}>Cancel</button>
			</div>
		</div>
	</div>
{/if}
