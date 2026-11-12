<script lang="ts">
	import PageHeader from '$lib/components/settings/PageHeader.svelte';
	import Section from '$lib/components/settings/Section.svelte';
	import RowMenu from '$lib/components/settings/RowMenu.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { onMount } from 'svelte';
	import { pageTitle } from '$lib/utils/title';
	import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
	import { fetchWithStepUp } from '$lib/auth/step-up';
	import { describeDevice, relativeTime } from '$lib/devices';

	interface PasskeyInfo {
		id: string;
		name: string;
		createdAt: string;
		lastUsedAt: string | null;
	}
	interface SessionInfo {
		id: string;
		createdAt: string;
		lastSeenAt: string;
		userAgent: string | null;
		ip: string | null;
		current: boolean;
	}

	// --- Change password ---
	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	let pwBusy = $state(false);
	let pwError = $state<string | null>(null);
	let pwSaved = $state(false);

	// --- Passkeys ---
	let passkeys = $state<PasskeyInfo[]>([]);
	let passkeySupported = $state(false);
	let pkBusy = $state(false);
	let pkError = $state<string | null>(null);
	let renameId = $state<string | null>(null);
	let renameValue = $state('');

	// --- Authenticator app ---
	let totp = $state<{ enabled: boolean; recoveryCodesLeft: number } | null>(null);
	let setup = $state<{ secret: string; uri: string; qr: string } | null>(null);
	let setupCode = $state('');
	let recoveryCodes = $state<string[] | null>(null);
	let totpBusy = $state(false);
	let totpError = $state<string | null>(null);

	// --- Sessions ---
	let sessions = $state<SessionInfo[]>([]);

	onMount(async () => {
		passkeySupported = browserSupportsWebAuthn();
		await Promise.all([loadPasskeys(), loadSessions(), loadTotp()]);
	});

	async function loadTotp() {
		const res = await fetch('/api/auth/totp');
		if (res.ok) totp = await res.json();
	}

	async function totpAction(action: string, extra: Record<string, unknown> = {}) {
		if (totpBusy) return null;
		totpBusy = true;
		totpError = null;
		try {
			const res = await fetchWithStepUp('/api/auth/totp', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action, ...extra })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				if (!body?.stepUp) totpError = body?.message ?? 'That didn’t work';
				return null;
			}
			return body;
		} finally {
			totpBusy = false;
		}
	}

	async function beginTotp() {
		const body = await totpAction('begin');
		if (body) {
			setup = body;
			setupCode = '';
		}
	}

	async function confirmTotp() {
		const body = await totpAction('confirm', { code: setupCode });
		if (!body) return;
		setup = null;
		recoveryCodes = body.recoveryCodes;
		await loadTotp();
	}

	async function newRecoveryCodes() {
		const body = await totpAction('recovery-codes');
		if (body) recoveryCodes = body.recoveryCodes;
		await loadTotp();
	}

	async function disableTotp() {
		if (await totpAction('disable')) await loadTotp();
	}

	function downloadRecoveryCodes() {
		if (!recoveryCodes) return;
		const blob = new Blob([`Zajel Mail recovery codes\n\n${recoveryCodes.join('\n')}\n`], { type: 'text/plain' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = 'zajel-recovery-codes.txt';
		a.click();
		URL.revokeObjectURL(a.href);
	}

	/** The secret in groups of four, easier to type into an app by hand. */
	function grouped(secret: string): string {
		return secret.replace(/(.{4})/g, '$1 ').trim();
	}

	async function loadPasskeys() {
		const res = await fetch('/api/auth/passkeys');
		if (res.ok) passkeys = (await res.json()).passkeys;
	}

	async function loadSessions() {
		const res = await fetch('/api/auth/sessions');
		if (res.ok) sessions = (await res.json()).sessions;
	}

	async function changePassword() {
		if (pwBusy) return;
		pwError = null;
		pwSaved = false;
		if (newPassword.length < 8) {
			pwError = 'New password must be at least 8 characters';
			return;
		}
		if (newPassword !== confirmPassword) {
			pwError = 'New passwords do not match';
			return;
		}
		pwBusy = true;
		try {
			const res = await fetchWithStepUp('/api/auth/change-password', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ current: currentPassword, next: newPassword })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				if (!body?.stepUp) pwError = body?.message ?? 'Could not change password';
				return;
			}
			currentPassword = '';
			newPassword = '';
			confirmPassword = '';
			pwSaved = true;
			// Other sessions were revoked server-side; refresh the list.
			await loadSessions();
		} finally {
			pwBusy = false;
		}
	}

	async function registerPasskey() {
		if (pkBusy) return;
		pkBusy = true;
		pkError = null;
		try {
			const optRes = await fetchWithStepUp('/api/auth/passkey/register/options', { method: 'POST' });
			if (!optRes.ok) {
				const body = await optRes.json().catch(() => null);
				if (!body?.stepUp) pkError = 'Could not start passkey registration';
				return;
			}
			const options = await optRes.json();
			const response = await startRegistration({ optionsJSON: options });
			const name = defaultPasskeyName();
			const verifyRes = await fetchWithStepUp('/api/auth/passkey/register/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ response, name })
			});
			if (!verifyRes.ok) {
				pkError = 'Passkey could not be verified';
				return;
			}
			await loadPasskeys();
		} catch (err) {
			if ((err as Error)?.name !== 'NotAllowedError') {
				pkError = 'Passkey registration failed';
			}
		} finally {
			pkBusy = false;
		}
	}

	function defaultPasskeyName(): string {
		const ua = navigator.userAgent;
		if (/iPhone|iPad/.test(ua)) return 'iOS device';
		if (/Mac/.test(ua)) return 'Mac';
		if (/Android/.test(ua)) return 'Android device';
		if (/Windows/.test(ua)) return 'Windows device';
		return 'Passkey';
	}

	async function renamePasskey(id: string) {
		if (!renameValue.trim()) return;
		await fetch(`/api/auth/passkeys/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: renameValue.trim() })
		});
		renameId = null;
		await loadPasskeys();
	}

	async function deletePasskey(id: string) {
		await fetchWithStepUp(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
		await loadPasskeys();
	}

	async function revokeSession(id: string) {
		await fetch(`/api/auth/sessions/${id}`, { method: 'DELETE' });
		await loadSessions();
	}

	const inputClass =
		'w-full h-9 bg-transparent border border-border rounded-md px-3 text-sm text-text ' +
		'placeholder-text-tertiary outline-none focus:border-accent transition-colors';
</script>

<svelte:head><title>{pageTitle({ page: 'Security', subtitle: 'Settings' })}</title></svelte:head>

<PageHeader title="Security" />

<!-- The sign-in to this webmail; each mail account keeps its own password. -->
<Section title="Password" bare>
	<div class="max-w-sm space-y-3">
		{#if pwError}
			<div class="bg-danger/10 border border-danger/20 text-danger text-sm rounded-lg px-3 py-2">{pwError}</div>
		{/if}
		{#if pwSaved}
			<div class="bg-accent/10 border border-accent/20 text-accent-fg text-sm rounded-lg px-3 py-2">
				Password changed. Other devices have been signed out.
			</div>
		{/if}
		<input bind:value={currentPassword} type="password" placeholder="Current password" aria-label="Current password" autocomplete="current-password" class={inputClass} />
		<input bind:value={newPassword} type="password" placeholder="New password (8+ characters)" aria-label="New password" autocomplete="new-password" class={inputClass} />
		<input bind:value={confirmPassword} type="password" placeholder="Confirm new password" aria-label="Confirm new password" autocomplete="new-password" class={inputClass} />
		<button
			type="button"
			onclick={changePassword}
			disabled={pwBusy || !currentPassword || !newPassword || !confirmPassword}
			class="btn btn-secondary"
		>
			{pwBusy ? 'Changing…' : 'Change password'}
		</button>
	</div>
</Section>

<!-- Authenticator app: the second step after the password -->
<Section title="Authenticator app" bare>
	{#if totpError}
		<div class="bg-danger/10 border border-danger/20 text-danger text-sm rounded-lg px-3 py-2 mb-3">{totpError}</div>
	{/if}

	{#if recoveryCodes}
		<div class="max-w-sm border border-border rounded-xl p-4 mb-3">
			<p class="text-sm font-medium text-text mb-2">Recovery codes</p>
			<ul class="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-sm text-text mb-3">
				{#each recoveryCodes as code (code)}
					<li>{code}</li>
				{/each}
			</ul>
			<div class="flex gap-2">
				<button type="button" class="btn btn-secondary btn-sm" onclick={() => navigator.clipboard.writeText(recoveryCodes!.join('\n'))}>Copy</button>
				<button type="button" class="btn btn-secondary btn-sm" onclick={downloadRecoveryCodes}>Download</button>
				<button type="button" class="btn btn-ghost btn-sm" onclick={() => (recoveryCodes = null)}>Done</button>
			</div>
		</div>
	{/if}

	{#if setup}
		<div class="max-w-sm space-y-3">
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- an SVG drawn on the server by qrcode-generator; the otpauth URI becomes QR cells, never markup -->
			<div class="w-44 h-44 bg-white rounded-lg p-2 [&>svg]:w-full [&>svg]:h-full">{@html setup.qr}</div>
			<p class="font-mono text-sm text-text select-all">{grouped(setup.secret)}</p>
			<a href={setup.uri} class="text-sm text-accent-fg hover:underline">Open in app</a>
			<input
				bind:value={setupCode}
				inputmode="numeric"
				autocomplete="one-time-code"
				aria-label="Code"
				placeholder="Code"
				class={inputClass}
			/>
			<div class="flex gap-2">
				<button type="button" onclick={confirmTotp} disabled={totpBusy || !setupCode.trim()} class="btn btn-primary">Turn on</button>
				<button type="button" onclick={() => (setup = null)} class="btn btn-ghost">Cancel</button>
			</div>
		</div>
	{:else if totp}
		<div class="rounded-xl border border-border">
			<div class="flex flex-wrap items-center gap-x-4 gap-y-2 min-h-14 px-5 max-md:px-4 py-2.5">
				<div class="flex-1 min-w-[9rem]">
					<p class="text-sm font-medium text-text">{totp.enabled ? 'On' : 'Off'}</p>
					{#if totp.enabled}
						<p class="text-[0.8125rem] text-text-tertiary mt-0.5">{totp.recoveryCodesLeft} recovery codes left</p>
					{/if}
				</div>
				{#if totp.enabled}
					<button type="button" onclick={newRecoveryCodes} disabled={totpBusy} class="btn btn-ghost btn-sm">New recovery codes</button>
					<button type="button" onclick={disableTotp} disabled={totpBusy} class="btn btn-ghost btn-sm hover:text-danger">Turn off</button>
				{:else}
					<button type="button" onclick={beginTotp} disabled={totpBusy} class="btn btn-secondary btn-sm">Set up</button>
				{/if}
			</div>
		</div>
	{/if}
</Section>

<!-- Passkeys: Touch ID, Face ID or a security key in place of the password -->
<Section title="Passkeys" bare>
	{#snippet action()}
		{#if passkeySupported}
			<button type="button" onclick={registerPasskey} disabled={pkBusy} class="btn btn-secondary btn-sm">
				<Icon name="add" size={14} />
				{pkBusy ? 'Waiting…' : 'Add passkey'}
			</button>
		{/if}
	{/snippet}

	{#if pkError}
		<div class="bg-danger/10 border border-danger/20 text-danger text-sm rounded-lg px-3 py-2 mb-3">{pkError}</div>
	{/if}
	<div class="rounded-xl border border-border divide-y divide-border">
		{#if !passkeySupported}
			<p class="px-5 max-md:px-4 py-4 text-sm text-text-tertiary">This browser doesn't support passkeys.</p>
		{:else if passkeys.length === 0}
			<p class="px-5 max-md:px-4 py-4 text-sm text-text-tertiary">No passkeys</p>
		{:else}
			{#each passkeys as pk (pk.id)}
				<div class="flex items-center gap-3 min-h-14 pl-5 pr-3 max-md:pl-4 max-md:pr-2 py-2.5">
					<Icon name="passkey" size={16} class="text-text-tertiary" />
					<div class="flex-1 min-w-0">
						{#if renameId === pk.id}
							<input
								bind:value={renameValue}
								aria-label="Passkey name"
								onkeydown={(e) => { if (e.key === 'Enter') renamePasskey(pk.id); if (e.key === 'Escape') renameId = null; }}
								class="h-8 w-[200px] max-w-full bg-transparent border border-accent rounded-md px-2 text-sm text-text outline-none"
							/>
						{:else}
							<p class="text-sm font-medium text-text truncate">{pk.name}</p>
						{/if}
						<p class="text-[0.8125rem] text-text-tertiary mt-0.5">
							{pk.lastUsedAt ? `Last used ${relativeTime(pk.lastUsedAt)}` : 'Never used'}
						</p>
					</div>
					{#if renameId === pk.id}
						<button type="button" onclick={() => renamePasskey(pk.id)} class="btn btn-primary btn-sm">Save</button>
						<button type="button" onclick={() => (renameId = null)} class="btn btn-ghost btn-sm">Cancel</button>
					{:else}
						<RowMenu
							ariaLabel="{pk.name} options"
							items={[
								{ label: 'Rename', onSelect: () => { renameId = pk.id; renameValue = pk.name; } },
								{ label: 'Remove', danger: true, onSelect: () => deletePasskey(pk.id) }
							]}
						/>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</Section>

<!-- Sessions: the one in use carries a check mark -->
<Section title="Signed-in devices">
	{#each sessions as s (s.id)}
		<div class="flex items-center gap-3 min-h-14 pl-5 pr-3 max-md:pl-4 max-md:pr-2 py-2.5">
			<div class="flex-1 min-w-0">
				<p class="text-sm font-medium text-text truncate">{describeDevice(s.userAgent)}</p>
				<p class="text-[0.8125rem] text-text-tertiary mt-0.5">
					Active {relativeTime(s.lastSeenAt)}{s.ip ? ` · ${s.ip}` : ''}
				</p>
			</div>
			{#if s.current}
				<Icon name="check" size={16} class="text-accent-fg mr-2" aria-label="This device" />
			{:else}
				<button type="button" onclick={() => revokeSession(s.id)} class="btn btn-ghost btn-sm hover:text-danger">Sign out</button>
			{/if}
		</div>
	{/each}
</Section>
