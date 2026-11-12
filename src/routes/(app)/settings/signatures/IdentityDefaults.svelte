<script lang="ts">
	import { untrack } from 'svelte';
	import {
		userState,
		setIdentitySignature,
		clearIdentitySignature,
		refreshIdentities
	} from '$lib/stores/userState';
	import { showToast } from '$lib/stores/toast';
	import { useDraft } from '$lib/settings/draft.svelte';
	import { saveEach } from '$lib/settings/send';

	/**
	 * Which signature each sending address starts a message with. A
	 * preference, so it waits for Save in the bar at the foot of the page
	 * like the other settings. It is a component of its own so that its
	 * unsaved choices live only while these pickers are on the page, which
	 * shows them only to someone with more than one address and at least
	 * one signature.
	 */

	const identities = $derived($userState.identities);
	const signatures = $derived($userState.signatures);

	/**
	 * Identity id → signature id, as the pickers hold it; '' for an address
	 * on the global default. One setting per address, so one that saved
	 * stays saved when another is refused.
	 */
	type Overrides = Record<string, string>;

	const savedFor = (identityId: string): string =>
		$userState.identitySignatures.get(identityId)?.toString() ?? '';

	const draft = useDraft<Overrides>({
		// The addresses as the page opened; one fetched later is added when picked.
		initial: untrack(() =>
			Object.fromEntries(identities.map((identity) => [identity.jmapId, savedFor(identity.jmapId)]))
		),
		async persist(changed, _all, stored) {
			// Each address is its own request: only the ones that moved are sent.
			await saveEach(
				stored,
				Object.entries(changed).map(([id, next]) => ({
					label: `The signature for ${identities.find((i) => i.jmapId === id)?.email ?? id}`,
					values: { [id]: next ?? '' },
					run: () => (next ? setIdentitySignature(id, parseInt(next, 10)) : clearIdentitySignature(id))
				}))
			);
		}
	});

	// What the pickers point at can go while a choice waits for Save: a
	// signature deleted with the editor above, or an address no longer on
	// the account. A choice of either is dropped, so Save can't store it.
	$effect(() => {
		const ids = identities.map((identity) => identity.jmapId);
		const existing = new Set(signatures.map((sig) => sig.id.toString()));
		untrack(() => {
			draft.present(ids);
			const gone = (value: unknown) => typeof value === 'string' && value !== '' && !existing.has(value);
			// A saved choice of a deleted signature went with it on the server.
			const cleared = Object.keys(draft.baseline).filter((id) => gone(draft.baseline[id]));
			if (cleared.length > 0) draft.seed(Object.fromEntries(cleared.map((id) => [id, ''])));
			for (const [id, value] of Object.entries(draft.value)) {
				if (gone(value)) draft.value[id] = draft.baseline[id] ?? '';
			}
		});
	});

	function pick(identityId: string, raw: string) {
		// An address fetched since the page opened starts from what is saved for it.
		if (!(identityId in draft.baseline)) draft.seed({ [identityId]: savedFor(identityId) });
		draft.value[identityId] = raw;
	}

	// Fetching the address list again is an action, not a setting: it runs at once.
	let refreshing = $state(false);
	async function refreshIdentitiesNow() {
		refreshing = true;
		try {
			const list = await refreshIdentities();
			showToast({ message: `Refreshed — ${list.length} identit${list.length === 1 ? 'y' : 'ies'}` });
		} catch {
			showToast({ message: 'Refresh failed' });
		} finally {
			refreshing = false;
		}
	}
</script>

<section class="mt-10 pt-6 border-t border-border">
	<header class="mb-4 flex items-start justify-between gap-4">
		<div>
			<h2 class="text-base font-semibold text-text">Default signatures per identity</h2>
			<p class="text-sm text-text-tertiary mt-1 max-w-prose">
				For each address, pick the signature that auto-applies when you compose from it. Anything
				left on "Use global default" follows the default chosen above.
			</p>
		</div>
		<button
			type="button"
			onclick={refreshIdentitiesNow}
			disabled={refreshing}
			class="btn btn-secondary shrink-0"
		>
			{refreshing ? 'Refreshing…' : 'Refresh from server'}
		</button>
	</header>

	<div class="flex flex-col gap-2">
		{#each identities as identity (identity.jmapId)}
			<div class="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-hover/50 border border-border/60">
				<div class="flex-1 min-w-0">
					<div class="text-sm text-text truncate">{identity.email}</div>
					{#if identity.name}
						<div class="text-xs text-text-tertiary truncate">{identity.name}</div>
					{/if}
				</div>
				{#if identity.isPrimary}
					<span class="text-3xs uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-accent/15 text-accent-fg shrink-0">
						Primary
					</span>
				{/if}
				<select
					value={draft.value[identity.jmapId] ?? savedFor(identity.jmapId)}
					onchange={(e) => pick(identity.jmapId, (e.target as HTMLSelectElement).value)}
					aria-label="Default signature for {identity.email}"
					class="bg-surface border border-border rounded-md px-2 py-1 text-sm text-text outline-none focus:border-accent transition-colors cursor-pointer max-w-[220px]"
				>
					<option value="">— Use global default —</option>
					{#each signatures as sig (sig.id)}
						<option value={sig.id.toString()}>{sig.name}</option>
					{/each}
				</select>
			</div>
		{/each}
	</div>
</section>
