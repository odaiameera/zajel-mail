<script lang="ts">
	import type { Component } from 'svelte';
	import Layout from './+layout.svelte';

	/**
	 * Test only: a settings page inside the settings layout, the way the
	 * router puts them together, so a test can press the layout's Save bar
	 * and see what the page then sends.
	 */
	let { page: Page, data }: { page: Component<{ data?: unknown }>; data?: unknown } = $props();
</script>

<!-- The layout gets the page's data too, as SvelteKit gives a layout its
     own and its parents' (the account in use among them). -->
<Layout data={data as { activeAccountId?: string | null }}>
	<Page {data} />
</Layout>
