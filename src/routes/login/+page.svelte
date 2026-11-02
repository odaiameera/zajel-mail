<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { enhance } from '$app/forms';
	import { pageTitle } from '$lib/utils/title';
	import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
	import type { ActionData, PageData } from './$types';

	let { form, data }: { form: ActionData; data: PageData } = $props();
	let loading = $state(false);

	// The second step after a correct password: from the action that just
	// ran, or from a reload while one is pending.
	const second = $derived.by(() => {
		if (form) return 'secondStep' in form && form.secondStep ? form : null;
		return data.pending;
	});
	let passkeyError = $state<string | null>(null);
	let passkeySupported = $state(false);

	$effect(() => {
		passkeySupported = browserSupportsWebAuthn();
	});

	async function passkeyLogin() {
		passkeyError = null;
		try {
			const optRes = await fetch('/api/auth/passkey/login/options', { method: 'POST' });
			if (!optRes.ok) {
				passkeyError = optRes.status === 404 ? 'No passkeys registered yet' : 'Passkey sign-in unavailable';
				return;
			}
			const options = await optRes.json();
			const assertion = await startAuthentication({ optionsJSON: options });
			const verifyRes = await fetch('/api/auth/passkey/login/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(assertion)
			});
			if (!verifyRes.ok) {
				passkeyError = 'Passkey sign-in failed';
				return;
			}
			window.location.href = '/inbox';
		} catch (err) {
			// User dismissing the platform dialog throws — stay quiet for that.
			if ((err as Error)?.name !== 'NotAllowedError') {
				passkeyError = 'Passkey sign-in failed';
			}
		}
	}
</script>

<svelte:head>
	<title>{pageTitle({ page: 'Sign in' })}</title>
</svelte:head>

<div class="min-h-screen flex items-center justify-center px-4">
	<div class="w-full max-w-sm">
		<div class="text-center mb-8">
			<h1 class="text-2xl font-bold text-text">zajel. <span class="text-text-tertiary font-normal">Mail</span></h1>
			<p class="text-text-tertiary mt-1 text-sm">Sign in to your webmail</p>
		</div>

		{#if second}
			<form
				method="POST"
				action="?/code"
				use:enhance={() => {
					loading = true;
					return async ({ update }) => {
						loading = false;
						await update();
					};
				}}
				class="space-y-4"
			>
				{#if form?.error}
					<div class="bg-danger/10 border border-danger/20 text-danger text-sm rounded-lg px-4 py-3">
						{form.error}
					</div>
				{/if}
				{#if passkeyError}
					<div class="bg-danger/10 border border-danger/20 text-danger text-sm rounded-lg px-4 py-3">
						{passkeyError}
					</div>
				{/if}

				{#if second.totp}
					<div>
						<label for="code" class="block text-sm text-text-secondary mb-1.5">Code</label>
						<input
							id="code"
							name="code"
							type="text"
							autocomplete="one-time-code"
							required
							class="w-full bg-surface border border-border rounded-lg px-3.5 py-2.5 text-text
								focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-colors"
						/>
					</div>
					<button type="submit" disabled={loading} class="btn btn-primary btn-lg w-full">
						{loading ? 'Checking...' : 'Verify'}
					</button>
				{/if}
			</form>

			{#if second.passkey && passkeySupported}
				<button type="button" onclick={passkeyLogin} class="btn btn-secondary btn-lg w-full mt-4">
					<Icon name="passkey" size={16} />
					Use a passkey
				</button>
			{/if}

			<form method="POST" action="?/cancel" use:enhance class="mt-4">
				<button type="submit" class="btn btn-ghost w-full">Back</button>
			</form>
		{:else}
		<form
			method="POST"
			action="?/password"
			use:enhance={() => {
				loading = true;
				return async ({ update }) => {
					loading = false;
					await update();
				};
			}}
			class="space-y-4"
		>
			{#if form?.error}
				<div class="bg-danger/10 border border-danger/20 text-danger text-sm rounded-lg px-4 py-3">
					{form.error}
				</div>
			{/if}
			{#if passkeyError}
				<div class="bg-danger/10 border border-danger/20 text-danger text-sm rounded-lg px-4 py-3">
					{passkeyError}
				</div>
			{/if}

			<div>
				<label for="email" class="block text-sm text-text-secondary mb-1.5">Email</label>
				<input
					id="email"
					name="email"
					type="text"
					autocomplete="username webauthn"
					required
					value={form?.email ?? ''}
					class="w-full bg-surface border border-border rounded-lg px-3.5 py-2.5 text-text
						focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-colors"
				/>
			</div>

			<div>
				<label for="password" class="block text-sm text-text-secondary mb-1.5">Password</label>
				<input
					id="password"
					name="password"
					type="password"
					autocomplete="current-password"
					required
					class="w-full bg-surface border border-border rounded-lg px-3.5 py-2.5 text-text
						focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-colors"
				/>
			</div>

			<button
				type="submit"
				disabled={loading}
				class="btn btn-primary btn-lg w-full"
			>
				{loading ? 'Signing in...' : 'Sign in'}
			</button>
		</form>

		{#if passkeySupported}
			<div class="flex items-center gap-3 my-5">
				<div class="flex-1 border-t border-border"></div>
				<span class="text-xs text-text-tertiary">or</span>
				<div class="flex-1 border-t border-border"></div>
			</div>

			<button
				type="button"
				onclick={passkeyLogin}
				class="btn btn-secondary btn-lg w-full"
			>
				<Icon name="passkey" size={16} />
				Sign in with a passkey
			</button>
		{/if}
		{/if}
	</div>
</div>
