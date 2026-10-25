<script lang="ts" module>
	import type { ContactsLoadResponse as LoadResponse } from '$lib/contacts/api';

	// The last full list, per account, so coming back to Contacts shows it at
	// once while the fresh one loads.
	const lastLists = new Map<string, LoadResponse>();
</script>

<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { onMount, untrack } from 'svelte';
	import { page } from '$app/state';
	import { get } from 'svelte/store';
	import { isPhone } from '$lib/stores/viewport';
	import { pageTitle } from '$lib/utils/title';
	import { openCompose } from '$lib/stores/compose';
	import {
		apiCreateContact,
		apiCreateList,
		apiDeleteContact,
		apiDeleteList,
		apiLoadContacts,
		apiRenameList,
		apiSetListMembers,
		apiUpdateContact,
		type ContactsLoadResponse
	} from '$lib/contacts/api';
	import type { ContactList } from '$lib/jmap/contacts';
	import { showToast } from '$lib/stores/toast';
	import {
		contactDisplayName,
		contactEmails,
		contactPhones,
		contactPrimaryEmail,
		groupContactsAlphabetically,
		type ContactFormValue
	} from '$lib/contacts/model';
	import type { ContactCard } from '$lib/jmap/types';
	import { takePendingContact } from '$lib/contacts/navigation';
	import ContactFormModal from './ContactFormModal.svelte';
	import ImportContactsModal from './ImportContactsModal.svelte';
	import { appDrawerCloser, hostAppPanel } from '$lib/app-panel';
	import { newRequest } from '$lib/stores/create';

	let {
		initial = undefined
	}: {
		/** From the page's load: the list itself, or (moving here from another
		 *  page) a promise of it; null when that failed. Absent outside the page. */
		initial?: ContactsLoadResponse | null | Promise<ContactsLoadResponse | null>;
	} = $props();

	const accountKey = page.data.activeAccountId ?? '';
	// Start with what the page brought, or else the list from last time.
	const startWith = untrack(() => (initial && !(initial instanceof Promise) ? initial : (lastLists.get(accountKey) ?? null)));

	let loading = $state(startWith === null);
	let error = $state('');
	let data = $state<ContactsLoadResponse | null>(startWith);
	let selectedId = $state<string | null>(null);
	let query = $state('');
	let requestController: AbortController | null = null;
	let formOpen = $state(false);
	let createInitial = $state<Partial<ContactFormValue> | null>(null);
	let importOpen = $state(false);
	let openingImport = $state(false);
	let importExistingContacts = $state<ContactCard[]>([]);
	let editingContact = $state<ContactCard | null>(null);
	let deleteOpen = $state(false);
	let deleting = $state(false);
	let deleteError = $state('');

	// --- Lists (group cards; see ContactList) ---
	const lists = $derived(data?.lists ?? []);
	const listsSupported = $derived(data?.listsSupported ?? false);
	let activeListId = $state<string | null>(null);
	const activeList = $derived(lists.find((list) => list.id === activeListId) ?? null);
	let creatingList = $state(false);
	let newListName = $state('');
	// Enter submits and the field's blur saves too; this keeps one entry from
	// creating the list twice.
	let savingList = false;
	// People in the address book (the server's total also counts lists).
	// Taken from an unfiltered load, so a search doesn't change it.
	let everyoneCount = $state<number | null>(null);
	let renamingListId = $state<string | null>(null);
	let renameValue = $state('');
	let listMenuFor = $state<string | null>(null);
	let deleteListTarget = $state<ContactList | null>(null);
	let deletingList = $state(false);
	let addToListOpen = $state(false);
	const closeDrawer = appDrawerCloser();

	const allContacts = $derived(data?.contacts ?? []);
	// The list pane shows everyone, or just the open list's members.
	const contacts = $derived.by(() => {
		if (!activeList) return allContacts;
		const members = new Set(activeList.memberUids);
		return allContacts.filter((contact) => members.has(contact.uid));
	});
	const groups = $derived(groupContactsAlphabetically(contacts));
	const selected = $derived(allContacts.find((contact) => contact.id === selectedId) ?? null);
	const selectedLists = $derived(
		selected ? lists.filter((list) => list.memberUids.includes(selected.uid)) : []
	);
	const otherLists = $derived(
		selected ? lists.filter((list) => !list.memberUids.includes(selected.uid)) : []
	);
	const activeListEmails = $derived(
		contacts.map((contact) => contactPrimaryEmail(contact)).filter((email) => !!email)
	);
	const canMutate = $derived(
		data?.supported === true && data.addressBooks.some((book) => book.myRights.mayWrite)
	);
	const canMutateSelected = $derived.by(() => {
		if (!canMutate || !selected || !data?.supported) return false;
		const selectedBookIds = Object.entries(selected.addressBookIds)
			.filter(([, included]) => included)
			.map(([id]) => id);
		const writableBookIds = new Set(
			data.addressBooks.filter((book) => book.myRights.mayWrite).map((book) => book.id)
		);
		return selectedBookIds.length > 0 && selectedBookIds.every((id) => writableBookIds.has(id));
	});

	function applyResult(result: ContactsLoadResponse, search: string, phone = get(isPhone)) {
		data = result;
		error = '';
		if (!search.trim()) {
			everyoneCount = result.contacts.length;
			lastLists.set(accountKey, result);
		}
		if (selectedId && !result.contacts.some((contact) => contact.id === selectedId)) {
			selectedId = null;
		}
		// Open the first contact so the detail pane isn't empty — except on a
		// phone, where the detail replaces the list and would hide it on load.
		if (!selectedId && result.contacts.length > 0 && !phone) selectedId = result.contacts[0].id;
	}

	async function loadContacts(search = query) {
		requestController?.abort();
		requestController = new AbortController();
		loading = true;
		error = '';
		try {
			const result = await apiLoadContacts(search, { signal: requestController.signal });
			applyResult(result, search);
		} catch (caught) {
			if ((caught as Error).name !== 'AbortError') {
				error = (caught as Error).message || 'Unable to load contacts';
			}
		} finally {
			loading = false;
		}
	}

	function submitSearch(event: SubmitEvent) {
		event.preventDefault();
		loadContacts(query);
	}

	function openCreate(initial: Partial<ContactFormValue> | null = null) {
		editingContact = null;
		createInitial = initial;
		formOpen = true;
	}

	function openEdit() {
		if (!selected || !canMutateSelected) return;
		createInitial = null;
		editingContact = selected;
		formOpen = true;
	}

	async function openImport() {
		if (!canMutate || openingImport) return;
		openingImport = true;
		error = '';
		try {
			const result = await apiLoadContacts('');
			if (!result.supported) {
				error = 'Contacts are no longer available for this account.';
				return;
			}
			importExistingContacts = result.contacts;
			importOpen = true;
		} catch (caught) {
			error = (caught as Error).message || 'Unable to load contacts for import';
		} finally {
			openingImport = false;
		}
	}

	async function saveContact(form: ContactFormValue): Promise<{ ok: boolean; error?: string }> {
		try {
			if (editingContact) {
				const editedId = editingContact.id;
				await apiUpdateContact(editedId, form);
				formOpen = false;
				await loadContacts(query);
				selectedId = editedId;
			} else {
				const created = await apiCreateContact(form);
				if (data) {
					data = {
						...data,
						contacts: [...data.contacts, created],
						total: data.total + 1
					};
				}
				if (everyoneCount !== null) everyoneCount += 1;
				selectedId = created.id;
				formOpen = false;
				// Created while a list is open: it joins that list.
				if (activeList) void setMembership(activeList, created.uid, true);
			}
			return { ok: true };
		} catch (caught) {
			return { ok: false, error: (caught as Error).message || 'Unable to save contact' };
		}
	}

	async function confirmDelete() {
		if (!selected || !canMutateSelected || deleting) return;
		deleting = true;
		deleteError = '';
		try {
			const deletedUid = selected.uid;
			const listsWithIt = lists.filter((list) => list.memberUids.includes(deletedUid));
			await apiDeleteContact(selected.id);
			for (const list of listsWithIt) void setMembership(list, deletedUid, false);
			if (data) {
				const remaining = data.contacts.filter((contact) => contact.id !== selected.id);
				data = { ...data, contacts: remaining, total: Math.max(0, data.total - 1) };
				if (everyoneCount !== null) everyoneCount = Math.max(0, everyoneCount - 1);
				selectedId = remaining[0]?.id ?? null;
			}
			deleteOpen = false;
		} catch (caught) {
			deleteError = (caught as Error).message || 'Unable to delete contact';
		} finally {
			deleting = false;
		}
	}

	function showList(id: string | null) {
		activeListId = id;
		listMenuFor = null;
		if (selected && id) {
			const list = lists.find((l) => l.id === id);
			if (list && !list.memberUids.includes(selected.uid)) selectedId = null;
		}
		closeDrawer();
	}

	function replaceList(next: ContactList) {
		if (!data) return;
		data = {
			...data,
			lists: [...data.lists.filter((l) => l.id !== next.id), next].sort((a, b) =>
				a.name.localeCompare(b.name)
			)
		};
	}

	async function createList() {
		if (savingList) return;
		const name = newListName.trim();
		if (!name) {
			creatingList = false;
			return;
		}
		savingList = true;
		try {
			const list = await apiCreateList(name);
			replaceList(list);
			creatingList = false;
			newListName = '';
			showList(list.id);
		} catch (caught) {
			showToast({ message: (caught as Error).message || 'Unable to create list' });
		} finally {
			savingList = false;
		}
	}

	function startRename(list: ContactList) {
		listMenuFor = null;
		renamingListId = list.id;
		renameValue = list.name;
	}

	async function renameList(list: ContactList) {
		// Escape already closed the field; the blur that follows isn't a save.
		if (renamingListId !== list.id) return;
		const name = renameValue.trim();
		renamingListId = null;
		if (!name || name === list.name) return;
		replaceList({ ...list, name });
		try {
			await apiRenameList(list.id, name);
		} catch (caught) {
			replaceList(list);
			showToast({ message: (caught as Error).message || 'Unable to rename list' });
		}
	}

	async function confirmDeleteList() {
		const list = deleteListTarget;
		if (!list || !data || deletingList) return;
		deletingList = true;
		try {
			await apiDeleteList(list.id);
			data = { ...data, lists: data.lists.filter((l) => l.id !== list.id) };
			if (activeListId === list.id) activeListId = null;
			deleteListTarget = null;
		} catch (caught) {
			showToast({ message: (caught as Error).message || 'Unable to delete list' });
		} finally {
			deletingList = false;
		}
	}

	// Membership changes show at once and roll back if the server refuses.
	async function setMembership(list: ContactList, uid: string, member: boolean) {
		addToListOpen = false;
		const memberUids = member
			? [...new Set([...list.memberUids, uid])]
			: list.memberUids.filter((u) => u !== uid);
		replaceList({ ...list, memberUids });
		try {
			await apiSetListMembers(list.id, member ? { add: [uid] } : { remove: [uid] });
		} catch (caught) {
			replaceList(list);
			showToast({ message: (caught as Error).message || 'Unable to update list' });
		}
	}

	function emailActiveList() {
		if (activeListEmails.length > 0) openCompose({ to: activeListEmails.join(', ') });
	}

	function closeListMenus() {
		listMenuFor = null;
		addToListOpen = false;
	}

	function composeToSelected() {
		if (!selected) return;
		const email = contactPrimaryEmail(selected);
		if (email) openCompose({ to: email });
	}

	// What the page started with is shown in the first paint (server and
	// browser alike, so they agree); the phone check waits for onMount.
	if (startWith) untrack(() => applyResult(startWith, '', false));

	onMount(() => {
		// On a phone the detail would cover the list; start on the list.
		if (get(isPhone) && selectedId === startWith?.contacts[0]?.id) selectedId = null;
		void (async () => {
			const fresh = initial instanceof Promise ? await initial : initial;
			if (fresh) {
				if (fresh !== startWith) applyResult(fresh, '');
				loading = false;
			} else {
				await loadContacts('');
			}
			const pending = takePendingContact();
			const email = pending?.email.trim().slice(0, 320) ?? '';
			const name = pending?.name.trim().slice(0, 255) ?? '';
			if (data?.supported && /^[^\s@]+@[^\s@]+$/.test(email)) {
				openCreate({
					name,
					emails: [{ address: email, type: 'other' }]
				});
			}
		})();
		return () => requestController?.abort();
	});

	// Import and the lists live in the shell's left column, where Mail keeps
	// its folders; New contact is in the corner's + menu. Without a
	// shell (tests) they render above the list instead.
	const hosted = hostAppPanel(contactsPanel);

	// New contact from the corner's + menu, once the address book is here
	// (the form needs to know which books can take it). Like the button it
	// replaced, it does nothing when no address book can take a contact.
	$effect(() => {
		if ($newRequest !== 'contact' || !data) return;
		newRequest.set(null);
		if (untrack(() => canMutate)) untrack(() => openCreate());
		else showToast({ message: 'None of your address books can take new contacts' });
	});
</script>

<svelte:head>
	<title>{pageTitle({ page: 'Contacts' })}</title>
</svelte:head>

<svelte:window onclick={closeListMenus} />

{#snippet contactsPanel()}
	<div class="px-3 pt-1.5 pb-1 flex flex-col gap-2 shrink-0">
		<button
			type="button"
			aria-label="Import contacts"
			disabled={!canMutate || openingImport}
			onclick={openImport}
			class="btn btn-secondary w-full"
		>
			Import
		</button>
	</div>
	<nav class="flex-1 min-h-0 overflow-y-auto px-2 py-2" aria-label="Contacts">
		<button
			type="button"
			onclick={() => showList(null)}
			aria-current={activeListId === null ? 'page' : undefined}
			class="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-sm transition-colors cursor-pointer
				{activeListId === null ? 'bg-accent/10 text-accent-fg' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}"
		>
			<Icon name="contacts" size={16} />
			<span class="flex-1 text-left">All contacts</span>
			{#if data?.supported && everyoneCount !== null}
				<span class="text-xs tabular-nums">{everyoneCount}</span>
			{/if}
		</button>

		{#if listsSupported}
			<div class="flex items-center justify-between pl-3 pr-1 pt-4 pb-1">
				<span class="text-3xs font-semibold uppercase tracking-wider text-text-tertiary">Lists</span>
				{#if canMutate}
					<button
						type="button"
						class="w-6 h-6 rounded-md flex items-center justify-center text-text-tertiary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer"
						aria-label="New list"
						title="New list"
						onclick={() => { creatingList = true; newListName = ''; }}
					>
						<Icon name="add" size={14} />
					</button>
				{/if}
			</div>

			{#each lists as list (list.id)}
				{#if renamingListId === list.id}
					<form class="px-1 py-0.5" onsubmit={(e) => { e.preventDefault(); void renameList(list); }}>
						<!-- svelte-ignore a11y_autofocus -->
						<input
							bind:value={renameValue}
							autofocus
							maxlength="100"
							aria-label="List name"
							onblur={() => void renameList(list)}
							onkeydown={(e) => { if (e.key === 'Escape') renamingListId = null; }}
							class="w-full h-8 px-2.5 rounded-lg bg-bg border border-accent text-sm text-text outline-none"
						/>
					</form>
				{:else}
					<div class="group relative">
						<button
							type="button"
							onclick={() => showList(list.id)}
							aria-current={activeListId === list.id ? 'page' : undefined}
							class="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-sm transition-colors cursor-pointer
								{activeListId === list.id ? 'bg-accent/10 text-accent-fg' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}"
						>
							<Icon name="group" size={16} />
							<span class="flex-1 text-left truncate">{list.name}</span>
							<span class="text-xs tabular-nums {canMutate ? 'group-hover:invisible' : ''}">{list.memberUids.length}</span>
						</button>
						{#if canMutate}
							<button
								type="button"
								class="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md flex items-center justify-center text-text-tertiary hover:text-text hover:bg-surface-hover opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer {listMenuFor === list.id ? 'opacity-100' : ''}"
								aria-label="List options for {list.name}"
								onclick={(e) => { e.stopPropagation(); listMenuFor = listMenuFor === list.id ? null : list.id; }}
							>
								<Icon name="more" size={14} />
							</button>
							{#if listMenuFor === list.id}
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div class="absolute right-1 top-full mt-1 z-30 w-36 bg-surface border border-border rounded-lg shadow-lg py-1" onclick={(e) => e.stopPropagation()}>
									<button type="button" class="w-full text-left px-3 py-1.5 text-sm text-text hover:bg-surface-hover cursor-pointer" onclick={() => startRename(list)}>Rename</button>
									<button type="button" class="w-full text-left px-3 py-1.5 text-sm text-danger hover:bg-danger/10 cursor-pointer" onclick={() => { listMenuFor = null; deleteListTarget = list; }}>Delete list</button>
								</div>
							{/if}
						{/if}
					</div>
				{/if}
			{/each}

			{#if creatingList}
				<form class="px-1 py-0.5" onsubmit={(e) => { e.preventDefault(); void createList(); }}>
					<!-- svelte-ignore a11y_autofocus -->
					<input
						bind:value={newListName}
						autofocus
						maxlength="100"
						placeholder="List name"
						aria-label="New list name"
						onblur={() => void createList()}
						onkeydown={(e) => { if (e.key === 'Escape') { creatingList = false; newListName = ''; } }}
						class="w-full h-8 px-2.5 rounded-lg bg-bg border border-accent text-sm text-text placeholder-text-tertiary outline-none"
					/>
				</form>
			{/if}
		{/if}
	</nav>
{/snippet}

<div class="h-full min-h-0 flex flex-col bg-bg">
	{#if !hosted}
		<div class="shrink-0 border-b border-border">{@render contactsPanel()}</div>
	{/if}

	{#if loading && !data}
		<div class="flex-1 grid place-items-center" role="status" aria-live="polite">
			<div class="text-center">
				<div class="w-8 h-8 mx-auto mb-3 rounded-full border-2 border-border border-t-accent animate-spin"></div>
				<p class="text-sm text-text-secondary">Loading contacts…</p>
			</div>
		</div>
	{:else if error && !data}
		<div class="flex-1 grid place-items-center px-6">
			<div class="max-w-sm text-center">
				<h2 class="text-base font-semibold text-text mb-1">Contacts could not be loaded</h2>
				<p class="text-sm text-text-tertiary mb-4">{error}</p>
				<button type="button" class="btn btn-primary btn-lg" onclick={() => loadContacts()}>
					Try again
				</button>
			</div>
		</div>
	{:else if data && !data.supported}
		<div class="flex-1 grid place-items-center px-6">
			<div class="max-w-md text-center">
				<div class="w-14 h-14 mx-auto mb-4 rounded-2xl bg-surface border border-border grid place-items-center text-text-tertiary">
					<Icon name="contacts" size={20} />
				</div>
				<h2 class="text-lg font-semibold text-text mb-1">Contacts are not available</h2>
				<p class="text-sm text-text-tertiary">This mail account does not advertise JMAP Contacts support.</p>
			</div>
		</div>
	{:else}
		<div class="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[minmax(260px,360px)_1fr]">
			<section class="min-h-0 border-r border-border flex flex-col {selected ? 'hidden md:flex' : 'flex'}" aria-label="Contact list">
				<!-- 48px top bar, like the mail list header beside its reading pane. -->
				<form class="h-12 shrink-0 px-3 flex items-center border-b border-border" onsubmit={submitSearch}>
					<label class="relative block w-full">
						<span class="sr-only">Search contacts</span>
						<Icon name="search" size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
						<input
							type="search"
							bind:value={query}
							placeholder="Search contacts"
							maxlength="255"
							class="w-full h-8 pl-9 pr-3 rounded-lg bg-surface-hover border border-border focus:border-accent text-sm text-text placeholder-text-tertiary outline-none"
						/>
					</label>
				</form>

				{#if activeList}
					<div class="shrink-0 px-4 py-2.5 border-b border-border flex items-center gap-3">
						<div class="min-w-0 flex-1">
							<p class="text-sm font-medium text-text truncate">{activeList.name}</p>
							<p class="text-2xs text-text-tertiary">{contacts.length} {contacts.length === 1 ? 'person' : 'people'}</p>
						</div>
						<button
							type="button"
							class="btn btn-secondary btn-sm"
							disabled={activeListEmails.length === 0}
							onclick={emailActiveList}
							title={activeListEmails.length === 0 ? 'No one in this list has an email address' : `Email all ${activeListEmails.length}`}
						>
							<Icon name="mail" size={14} />
							Email list
						</button>
					</div>
				{/if}

				{#if error}
					<div class="mx-3 mt-3 p-3 rounded-lg bg-danger/10 text-danger text-sm" role="alert">{error}</div>
				{/if}

				{#if contacts.length === 0}
					<div class="flex-1 grid place-items-center px-6 text-center">
						<div>
							{#if activeList && !query}
								<h2 class="text-sm font-medium text-text">No one in {activeList.name} yet</h2>
							{:else}
								<h2 class="text-sm font-medium text-text">{query ? 'No matching contacts' : 'No contacts yet'}</h2>
							{/if}
						</div>
					</div>
				{:else}
					<div class="flex-1 overflow-y-auto py-2">
						{#each groups as group (group.letter)}
							<div class="px-3 pt-2 pb-1 text-3xs font-semibold tracking-wider text-text-tertiary" aria-hidden="true">{group.letter}</div>
							{#each group.contacts as contact (contact.id)}
								<button
									type="button"
									onclick={() => selectedId = contact.id}
									aria-current={selectedId === contact.id ? 'true' : undefined}
									class="w-full px-3 py-2.5 flex items-center gap-3 text-left transition-colors cursor-pointer {selectedId === contact.id ? 'bg-accent/10' : 'hover:bg-surface-hover'}"
								>
									<span class="w-9 h-9 shrink-0 rounded-full bg-accent/15 text-accent-fg grid place-items-center text-sm font-semibold">
										{contactDisplayName(contact).slice(0, 1).toUpperCase()}
									</span>
									<span class="flex-1 min-w-0">
										<span class="block text-sm font-medium text-text truncate">{contactDisplayName(contact)}</span>
										<span class="block text-xs text-text-tertiary truncate">{contactPrimaryEmail(contact) || contactPhones(contact)[0]?.number || 'No email or phone'}</span>
									</span>
								</button>
							{/each}
						{/each}
					</div>
				{/if}
			</section>

			<section class="min-h-0 flex-col {selected ? 'flex' : 'hidden md:flex'}" aria-label="Contact details">
				{#if selected}
					<!-- Actions sit in a 48px top bar that lines up with the search bar
					     across the divider, the way the reading pane's toolbar lines up
					     with the mail list header. -->
					<div class="h-12 shrink-0 px-3 flex items-center gap-2 border-b border-border">
						<button type="button" class="md:hidden btn btn-ghost btn-sm -ml-1" onclick={() => selectedId = null}>
							<Icon name="back" size={14} />
							All contacts
						</button>
						<div class="flex-1"></div>
						<button
							type="button"
							aria-label="Compose email"
							disabled={!contactPrimaryEmail(selected)}
							onclick={composeToSelected}
							class="btn btn-primary btn-sm"
						>
							Compose email
						</button>
						<button type="button" aria-label="Edit contact" disabled={!canMutateSelected} onclick={openEdit} class="btn btn-secondary btn-sm">
							Edit
						</button>
						<button type="button" aria-label="Delete contact" disabled={!canMutateSelected} onclick={() => { deleteError = ''; deleteOpen = true; }} class="btn btn-danger btn-sm">
							Delete
						</button>
					</div>
					<div class="flex-1 min-h-0 overflow-y-auto">
						<div class="max-w-3xl px-5 md:px-8 py-6">
							<div class="flex items-center gap-5 pb-6 border-b border-border">
								<div class="w-16 h-16 shrink-0 rounded-full bg-accent/15 text-accent-fg grid place-items-center text-xl font-semibold">
									{contactDisplayName(selected).slice(0, 1).toUpperCase()}
								</div>
								<div class="min-w-0 flex-1">
									<h2 class="text-xl font-semibold text-text break-words">{contactDisplayName(selected)}</h2>
									{#if Object.values(selected.organizations ?? {})[0]?.name}
										<p class="text-sm text-text-tertiary mt-1">{Object.values(selected.organizations ?? {})[0].name}</p>
									{/if}
								</div>
							</div>

							<div class="py-6 space-y-6">
								{#if contactEmails(selected).length > 0}
									<div>
										<h3 class="text-xs font-semibold uppercase tracking-wide text-text-tertiary mb-2">Email</h3>
										<div class="space-y-2">
											{#each contactEmails(selected) as email}
												<a class="block text-sm text-accent-fg hover:underline" href={`mailto:${encodeURIComponent(email.address)}`}>{email.address}</a>
											{/each}
										</div>
									</div>
								{/if}
								{#if contactPhones(selected).length > 0}
									<div>
										<h3 class="text-xs font-semibold uppercase tracking-wide text-text-tertiary mb-2">Phone</h3>
										{#each contactPhones(selected) as phone}
											<a class="block text-sm text-text" href={`tel:${phone.number}`}>{phone.number}</a>
										{/each}
									</div>
								{/if}
								{#if Object.values(selected.notes ?? {})[0]?.note}
									<div>
										<h3 class="text-xs font-semibold uppercase tracking-wide text-text-tertiary mb-2">Notes</h3>
										<p class="text-sm text-text-secondary whitespace-pre-wrap">{Object.values(selected.notes ?? {})[0].note}</p>
									</div>
								{/if}
								{#if listsSupported && (selectedLists.length > 0 || (canMutate && lists.length > 0))}
									<div>
										<h3 class="text-xs font-semibold uppercase tracking-wide text-text-tertiary mb-2">Lists</h3>
										<div class="flex flex-wrap items-center gap-1.5">
											{#each selectedLists as list (list.id)}
												<span class="inline-flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-full bg-accent/10 text-accent-fg text-xs font-medium">
													{list.name}
													{#if canMutate}
														<button
															type="button"
															class="w-5 h-5 rounded-full grid place-items-center hover:bg-accent/20 cursor-pointer"
															aria-label="Remove from {list.name}"
															onclick={() => setMembership(list, selected.uid, false)}
														>
															<Icon name="close" size={12} />
														</button>
													{/if}
												</span>
											{/each}
											{#if canMutate && otherLists.length > 0}
												<div class="relative">
													<button
														type="button"
														class="btn btn-ghost btn-sm rounded-full"
														aria-haspopup="menu"
														aria-expanded={addToListOpen}
														onclick={(e) => { e.stopPropagation(); addToListOpen = !addToListOpen; }}
													>
														<Icon name="add" size={14} />
														Add to list
													</button>
													{#if addToListOpen}
														<!-- svelte-ignore a11y_click_events_have_key_events -->
														<!-- svelte-ignore a11y_no_static_element_interactions -->
														<div class="absolute left-0 top-full mt-1 z-30 min-w-44 max-h-64 overflow-y-auto bg-surface border border-border rounded-lg shadow-lg py-1" role="menu" tabindex="-1" onclick={(e) => e.stopPropagation()}>
															{#each otherLists as list (list.id)}
																<button type="button" role="menuitem" class="w-full text-left px-3 py-1.5 text-sm text-text hover:bg-surface-hover truncate cursor-pointer" onclick={() => setMembership(list, selected.uid, true)}>
																	{list.name}
																</button>
															{/each}
														</div>
													{/if}
												</div>
											{/if}
										</div>
									</div>
								{/if}
							</div>
						</div>
					</div>
				{:else}
					<div class="h-full grid place-items-center text-center px-6">
						<div>
							<div class="w-12 h-12 mx-auto mb-3 rounded-2xl bg-surface-hover grid place-items-center text-text-tertiary">
								<Icon name="contacts" size={20} />
							</div>
							<h2 class="text-sm font-medium text-text">No contact selected</h2>
						</div>
					</div>
				{/if}
			</section>
		</div>
	{/if}
</div>

<ContactFormModal
	open={formOpen}
	contact={editingContact}
	initialValue={createInitial}
	addressBooks={data?.addressBooks ?? []}
	onClose={() => { formOpen = false; }}
	onSave={saveContact}
/>

<ImportContactsModal
	open={importOpen}
	addressBooks={data?.addressBooks ?? []}
	existingContacts={importExistingContacts}
	onClose={() => { importOpen = false; }}
	onImported={(summary) => {
		if (summary.imported > 0) loadContacts(query);
	}}
/>

{#if deleteOpen && selected}
	<div
		class="fixed inset-0 z-[70] bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-4"
		role="dialog"
		aria-modal="true"
		aria-labelledby="delete-contact-title"
	>
		<div class="w-full max-w-sm rounded-xl bg-surface border border-border shadow-2xl p-5">
			<h2 id="delete-contact-title" class="text-lg font-semibold text-text">Delete contact?</h2>
			<p class="mt-2 text-sm text-text-secondary">
				This permanently deletes {contactDisplayName(selected)} from Stalwart.
			</p>
			{#if deleteError}
				<div class="mt-3 p-3 rounded-lg bg-danger/10 text-danger text-sm" role="alert">{deleteError}</div>
			{/if}
			<div class="mt-5 flex justify-end gap-2">
				<button type="button" disabled={deleting} class="btn btn-ghost btn-lg" onclick={() => { deleteOpen = false; }}>
					Cancel
				</button>
				<button type="button" disabled={deleting} aria-label="Confirm delete contact" class="btn btn-danger-solid btn-lg" onclick={confirmDelete}>
					{deleting ? 'Deleting…' : 'Delete contact'}
				</button>
			</div>
		</div>
	</div>
{/if}

{#if deleteListTarget}
	<div
		class="fixed inset-0 z-[70] bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-4"
		role="dialog"
		aria-modal="true"
		aria-labelledby="delete-list-title"
	>
		<div class="w-full max-w-sm rounded-xl bg-surface border border-border shadow-2xl p-5">
			<h2 id="delete-list-title" class="text-lg font-semibold text-text">Delete “{deleteListTarget.name}”?</h2>
			<p class="mt-2 text-sm text-text-secondary">
				The list is removed everywhere it syncs. The people in it stay in your contacts.
			</p>
			<div class="mt-5 flex justify-end gap-2">
				<button type="button" disabled={deletingList} class="btn btn-ghost btn-lg" onclick={() => { deleteListTarget = null; }}>
					Cancel
				</button>
				<button type="button" disabled={deletingList} class="btn btn-danger-solid btn-lg" onclick={confirmDeleteList}>
					{deletingList ? 'Deleting…' : 'Delete list'}
				</button>
			</div>
		</div>
	</div>
{/if}
