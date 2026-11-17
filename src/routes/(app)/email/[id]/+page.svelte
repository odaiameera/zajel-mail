<script lang="ts">
	import EmailDetail from '$lib/components/EmailDetail.svelte';
	import ConversationView from '$lib/components/ConversationView.svelte';
	import { pageTitle, truncateSubject } from '$lib/utils/title';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{pageTitle({ page: truncateSubject(data.email.subject) })}</title>
</svelte:head>

<!-- With Conversation view on, a message that has others in its thread opens
     with them; one that stands alone opens as it always did. -->
{#if data.thread}
	{#key data.thread.threadId}
		<ConversationView thread={data.thread} focusId={data.email.id} />
	{/key}
{:else}
	<EmailDetail email={data.email} />
{/if}
