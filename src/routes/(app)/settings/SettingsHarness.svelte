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

<Layout>
	<Page {data} />
</Layout>
