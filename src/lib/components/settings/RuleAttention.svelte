<script lang="ts">
	import { needsRewrite, type Rule } from '$lib/types/rules';
	import { conditionText, legacyTab, pinDifference, pinReach, tabName, whyNotPinned } from '$lib/rules/describe';

	/**
	 * What an upgrade did to a rule, and what its owner can do about it:
	 * shown above the rule's editor. Nothing for a rule it didn't change.
	 */
	let {
		rule,
		busy,
		onDismiss,
		onPin
	}: {
		rule: Rule;
		busy: boolean;
		/** "Got it": the note is read (a rule that became a pin goes with it). */
		onDismiss: (id: string) => void;
		/** Make the pin a flagged tab rule names, and remove the rule. */
		onPin: (id: string) => void;
	} = $props();
</script>

{#snippet pinnedSenders()}
	<a href="/settings/jev" class="underline">Settings → Jev → Pinned senders</a>
{/snippet}

{#if rule.attention === 'jev_condition'}
	<div class="rounded-xl border border-warning/30 bg-warning/10 p-4 flex flex-col gap-2" role="note">
		<p class="text-sm font-medium text-text">This rule is switched off</p>
		<p class="text-xs text-text-secondary">
			It had a condition Jev judged, and rules now match exactly: by sender, recipient,
			subject, body, size or attachment. Without that condition it would act on more mail
			than you wrote it for, so it no longer runs. This is what it said:
		</p>
		{#if rule.legacy}
			<ul class="text-xs text-text list-disc pl-5 flex flex-col gap-0.5">
				{#each rule.legacy.conditions as c, i (i)}
					<li>{conditionText(c)}</li>
				{/each}
			</ul>
			<p class="text-2xs text-text-tertiary">
				It matched {rule.legacy.logic === 'anyof' ? 'ANY' : 'ALL'} of these{rule.legacy.enabled ? '' : ', and was already switched off'}.
			</p>
		{/if}
		{#if legacyTab(rule)}
			<p class="text-xs text-text-secondary">
				It also moved that mail to {legacyTab(rule)}, which a rule can no longer do.
			</p>
		{/if}
		<p class="text-xs text-text-secondary">
			Rewrite it below with exact conditions and press
			<span class="text-text">Save as exact rule</span> to switch it back on, or delete it.
		</p>
	</div>
{:else if rule.attention === 'tab_rule'}
	{@const note = rule.note?.tab}
	<div class="rounded-xl border border-warning/30 bg-warning/10 p-4 flex flex-col gap-2" role="note">
		<p class="text-sm font-medium text-text">This rule is switched off</p>
		<p class="text-xs text-text">{whyNotPinned(note)}</p>
		<p class="text-xs text-text-secondary">
			All it did was move mail to {legacyTab(rule) ?? 'an Inbox tab'}, and rules no longer
			put mail in a tab: sender pins do that now, whether Jev is on or off. It matched mail
			like this:
		</p>
		{#if rule.legacy}
			<ul class="text-xs text-text list-disc pl-5 flex flex-col gap-0.5">
				{#each rule.legacy.conditions as c, i (i)}
					<li>{conditionText(c)}</li>
				{/each}
			</ul>
			{#if rule.legacy.conditions.length > 1}
				<p class="text-2xs text-text-tertiary">
					It matched {rule.legacy.logic === 'anyof' ? 'ANY' : 'ALL'} of these.
				</p>
			{/if}
		{/if}
		{#if note?.pin}
			{@const pin = note.pin}
			<p class="text-xs text-text-secondary">
				A pin can do this instead. It would act on new mail from {pinReach(pin.sender)}.
				{pinDifference(note)}
			</p>
			<button onclick={() => onPin(rule.id)} disabled={busy} class="btn btn-primary self-start">
				{note.kept?.sender === pin.sender
					? `Pin to ${tabName(pin.category)} instead`
					: `Pin ${pin.sender} to ${tabName(pin.category)}`}
			</button>
			<p class="text-xs text-text-secondary">
				That makes the pin and removes this rule. Or give the rule something else to do
				below, a label or a folder, and press <span class="text-text">Save as exact rule</span>.
			</p>
		{:else}
			<p class="text-xs text-text-secondary">
				To keep those senders in their tab, pin them under
				{@render pinnedSenders()} and delete
				this rule. Or give it something else to do below, a label or a folder, and press
				<span class="text-text">Save as exact rule</span>.
			</p>
		{/if}
	</div>
{:else if rule.attention === 'tab_pinned'}
	{@const note = rule.note?.tab}
	<div class="rounded-xl border border-warning/30 bg-warning/10 p-4 flex flex-col gap-2" role="note">
		{#if note?.pin}
			{@const pin = note.pin}
			<p class="text-sm font-medium text-text">
				{note.existing
					? `${pin.sender} was already pinned to ${tabName(pin.category)}.`
					: `This rule became a sender pin: ${pin.sender} → ${tabName(pin.category)}.`}
			</p>
			<p class="text-xs text-text-secondary">
				{note.existing
					? 'All it did was move mail to that tab, and you had already pinned this sender there, so your pin does its work now.'
					: 'All it did was move mail to that tab. Rules no longer do that; a pin does, whether Jev is on or off.'}
				The pin acts on new mail from {pinReach(pin.sender)}.
				{pinDifference(note)}
			</p>
		{:else}
			<p class="text-sm font-medium text-text">This rule became a sender pin</p>
		{/if}
		<p class="text-xs text-text-secondary">
			You can change or remove the pin under
			{@render pinnedSenders()}. The rule is
			switched off and has nothing left to do; it stays here only until you have seen this.
		</p>
		<button onclick={() => onDismiss(rule.id)} disabled={busy} class="btn btn-secondary self-start">
			Got it
		</button>
	</div>
{:else if rule.attention === 'tab_removed'}
	<div class="rounded-xl border border-warning/30 bg-warning/10 p-4 flex flex-col gap-2" role="note">
		<p class="text-sm font-medium text-text">
			This rule no longer puts mail in {legacyTab(rule) ?? 'an Inbox tab'}.
		</p>
		<p class="text-xs text-text-secondary">
			It used to move mail to {legacyTab(rule) ?? 'an Inbox tab'} as well. Rules no longer
			put mail in a tab, so that part was removed; the rest of the rule runs as before. To
			keep a sender’s mail in that tab, pin the sender under
			{@render pinnedSenders()}.
			“Got it” beside it in the list clears this note.
		</p>
	</div>
{/if}
{#if rule.note?.splitInto}
	<div class="rounded-xl border border-warning/30 bg-warning/10 p-4 flex flex-col gap-2" role="note">
		<p class="text-sm font-medium text-text">
			This rule filed mail in several places, so it is now {rule.note.splitInto} rules.
		</p>
		<p class="text-xs text-text-secondary">
			A rule files into one place now. The rules it became sit side by side in the list and
			together do what it did, except that where it moved mail to two folders, the first one
			decides.
		</p>
		<!-- A rule that runs has its "Got it" on its row in the list. -->
		{#if needsRewrite(rule)}
			<button onclick={() => onDismiss(rule.id)} disabled={busy} class="btn btn-secondary self-start">
				Got it
			</button>
		{/if}
	</div>
{/if}
