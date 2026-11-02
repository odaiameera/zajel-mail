<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import type { AddressBook, ContactCard } from '$lib/jmap/types';
	import {
		emptyContactForm,
		contactToForm,
		type ContactFormValue
	} from '$lib/contacts/model';

	let {
		open,
		contact = null,
		initialValue = null,
		addressBooks,
		onClose,
		onSave
	}: {
		open: boolean;
		contact?: ContactCard | null;
		initialValue?: Partial<ContactFormValue> | null;
		addressBooks: AddressBook[];
		onClose: () => void;
		onSave: (form: ContactFormValue) => Promise<{ ok: boolean; error?: string }>;
	} = $props();

	let form = $state<ContactFormValue>(emptyContactForm());
	let saving = $state(false);
	let error = $state('');
	let previousOpen = false;
	let nameInput = $state<HTMLInputElement | null>(null);

	const title = $derived(contact ? 'Edit contact' : 'New contact');

	$effect(() => {
		if (open && !previousOpen) {
			const writableBooks = addressBooks.filter((book) => book.myRights.mayWrite);
			const defaultBook = writableBooks.find((book) => book.isDefault)?.id ?? writableBooks[0]?.id ?? '';
			const empty = emptyContactForm(defaultBook);
			form = contact
				? contactToForm(contact)
				: {
						...empty,
						...initialValue,
						emails: initialValue?.emails ?? empty.emails,
						phones: initialValue?.phones ?? empty.phones,
						addressBookIds: initialValue?.addressBookIds ?? empty.addressBookIds
					};
			if (form.emails.length === 0) form.emails = [{ address: '', type: 'other' }];
			error = '';
			saving = false;
			setTimeout(() => nameInput?.focus(), 0);
		}
		previousOpen = open;
	});

	function addEmail() {
		if (form.emails.length < 20) form.emails.push({ address: '', type: 'other' });
	}

	function removeEmail(index: number) {
		form.emails.splice(index, 1);
		if (form.emails.length === 0) form.emails.push({ address: '', type: 'other' });
	}

	function addPhone() {
		if (form.phones.length < 20) form.phones.push({ number: '', type: 'other' });
	}

	function removePhone(index: number) {
		form.phones.splice(index, 1);
	}

	function toggleAddressBook(id: string, checked: boolean) {
		if (!addressBooks.find((book) => book.id === id)?.myRights.mayWrite) return;
		if (checked && !form.addressBookIds.includes(id)) form.addressBookIds.push(id);
		if (!checked) form.addressBookIds = form.addressBookIds.filter((bookId) => bookId !== id);
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (saving) return;
		saving = true;
		error = '';
		try {
			const result = await onSave(form);
			if (!result.ok) error = result.error ?? 'Unable to save contact';
		} catch (caught) {
			error = (caught as Error).message || 'Unable to save contact';
		} finally {
			saving = false;
		}
	}

	function cancel() {
		if (!saving) onClose();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			cancel();
		}
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-[70] bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-3 md:p-6"
		role="dialog"
		aria-modal="true"
		aria-labelledby="contact-form-title"
		tabindex="-1"
		onkeydown={handleKeydown}
		onclick={(event) => {
			if (event.target === event.currentTarget) cancel();
		}}
	>
		<form class="w-full max-w-2xl max-h-full bg-surface border border-border rounded-xl shadow-2xl flex flex-col" onsubmit={submit}>
			<header class="h-14 shrink-0 px-5 border-b border-border flex items-center justify-between">
				<h2 id="contact-form-title" class="text-lg font-semibold text-text">{title}</h2>
				<button type="button" aria-label="Close contact form" class="p-2 rounded-lg text-text-tertiary hover:text-text hover:bg-surface-hover cursor-pointer" onclick={cancel}>
					<Icon name="close" size={20} />
				</button>
			</header>

			<div class="flex-1 overflow-y-auto p-5 space-y-6">
				<div class="grid sm:grid-cols-2 gap-4">
					<label class="block sm:col-span-2">
						<span class="block text-sm font-medium text-text mb-1.5">Name</span>
						<input bind:this={nameInput} bind:value={form.name} maxlength="255" class="w-full h-10 px-3 rounded-lg bg-surface-hover border border-border focus:border-accent text-sm text-text outline-none" />
					</label>
					<label class="block">
						<span class="block text-sm font-medium text-text mb-1.5">Organization</span>
						<input bind:value={form.organization} maxlength="255" class="w-full h-10 px-3 rounded-lg bg-surface-hover border border-border focus:border-accent text-sm text-text outline-none" />
					</label>
					<label class="flex items-center gap-2 self-end h-10 text-sm text-text cursor-pointer">
						<input type="checkbox" bind:checked={form.favorite} class="accent-accent" />
						Favorite
					</label>
				</div>

				<fieldset>
					<div class="flex items-center justify-between mb-2">
						<legend class="text-sm font-medium text-text">Email addresses</legend>
						<button type="button" class="text-xs text-accent-fg hover:underline cursor-pointer" onclick={addEmail}>+ Add email</button>
					</div>
					<div class="space-y-2">
						{#each form.emails as email, index}
							<div class="grid grid-cols-[minmax(0,1fr)_100px_36px] gap-2">
								<input
									type="email"
									aria-label={`Email address ${index + 1}`}
									bind:value={email.address}
									maxlength="320"
									class="h-10 min-w-0 px-3 rounded-lg bg-surface-hover border border-border focus:border-accent text-sm text-text outline-none"
								/>
								<select aria-label={`Email type ${index + 1}`} bind:value={email.type} class="h-10 px-2 rounded-lg bg-surface-hover border border-border text-sm text-text outline-none">
									<option value="other">Other</option><option value="home">Home</option><option value="work">Work</option>
								</select>
								<button type="button" aria-label={`Remove email ${index + 1}`} class="h-10 rounded-lg grid place-items-center text-text-tertiary hover:text-danger hover:bg-surface-hover cursor-pointer" onclick={() => removeEmail(index)}><Icon name="close" /></button>
							</div>
						{/each}
					</div>
				</fieldset>

				<fieldset>
					<div class="flex items-center justify-between mb-2">
						<legend class="text-sm font-medium text-text">Phone numbers</legend>
						<button type="button" class="text-xs text-accent-fg hover:underline cursor-pointer" onclick={addPhone}>+ Add phone</button>
					</div>
					{#if form.phones.length > 0}
						<div class="space-y-2">
							{#each form.phones as phone, index}
								<div class="grid grid-cols-[minmax(0,1fr)_100px_36px] gap-2">
									<input aria-label={`Phone number ${index + 1}`} bind:value={phone.number} maxlength="100" class="h-10 min-w-0 px-3 rounded-lg bg-surface-hover border border-border focus:border-accent text-sm text-text outline-none" />
									<select aria-label={`Phone type ${index + 1}`} bind:value={phone.type} class="h-10 px-2 rounded-lg bg-surface-hover border border-border text-sm text-text outline-none">
										<option value="other">Other</option><option value="home">Home</option><option value="work">Work</option>
									</select>
									<button type="button" aria-label={`Remove phone ${index + 1}`} class="h-10 rounded-lg grid place-items-center text-text-tertiary hover:text-danger hover:bg-surface-hover cursor-pointer" onclick={() => removePhone(index)}><Icon name="close" /></button>
								</div>
							{/each}
						</div>
					{/if}
				</fieldset>

				<!-- Only when there's a choice: with one address book, it's that one. -->
				{#if addressBooks.length > 1}
					<fieldset>
						<legend class="text-sm font-medium text-text mb-2">Address books</legend>
						<div class="grid sm:grid-cols-2 gap-2">
							{#each addressBooks as book (book.id)}
								<label class="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-hover border border-border text-sm text-text cursor-pointer">
									<input
										type="checkbox"
										disabled={!book.myRights.mayWrite}
										checked={form.addressBookIds.includes(book.id)}
										onchange={(event) => toggleAddressBook(book.id, event.currentTarget.checked)}
										class="accent-accent"
									/>
									{book.name}
								</label>
							{/each}
						</div>
					</fieldset>
				{/if}

				<label class="block">
					<span class="block text-sm font-medium text-text mb-1.5">Notes</span>
					<textarea bind:value={form.notes} maxlength="10000" rows="4" class="w-full px-3 py-2 rounded-lg bg-surface-hover border border-border focus:border-accent text-sm text-text outline-none resize-y"></textarea>
				</label>

				{#if error}
					<div class="p-3 rounded-lg bg-danger/10 text-danger text-sm" role="alert" aria-live="polite">{error}</div>
				{/if}
			</div>

			<footer class="shrink-0 px-5 py-4 border-t border-border flex justify-end gap-2">
				<button type="button" disabled={saving} class="btn btn-ghost btn-lg" onclick={cancel}>Cancel</button>
				<button type="submit" disabled={saving} aria-label="Save contact" class="btn btn-primary btn-lg">
					{saving ? 'Saving…' : 'Save contact'}
				</button>
			</footer>
		</form>
	</div>
{/if}
