<script lang="ts">
	import type { ViewerAttachment } from '$lib/attachments/types';
	import { fetchArrayBuffer } from '$lib/attachments/fetch';

	let { attachment }: { attachment: ViewerAttachment } = $props();

	let html = $state<string | null>(null);
	let warnings = $state<string[]>([]);
	let error = $state<string | null>(null);
	let loading = $state(true);

	$effect(() => {
		loading = true;
		html = null;
		error = null;
		warnings = [];

		(async () => {
			try {
				const [mammothModule, { sanitizeDocxHtml }, buffer] = await Promise.all([
					import('mammoth'),
					import('$lib/utils/docx-html'),
					fetchArrayBuffer(attachment.emailId, attachment.blobId, attachment.name)
				]);

				// `mammoth` only exposes its API on the default export under ESM.
				const mammoth = mammothModule.default ?? mammothModule;
				const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
				// mammoth passes link targets through as written, `javascript:`
				// included, and this renders in the app's own DOM: clean it first.
				html = sanitizeDocxHtml(result.value);
				warnings = result.messages.slice(0, 3).map((m) => m.message);
				loading = false;
			} catch (err) {
				error = err instanceof Error ? err.message : 'Failed to render document';
				loading = false;
			}
		})();
	});
</script>

<div class="w-full h-full overflow-auto">
	<div class="max-w-3xl mx-auto p-8">
		{#if loading}
			<div class="flex items-center justify-center py-16 text-text-tertiary text-sm">Rendering document…</div>
		{:else if error}
			<div class="flex items-center justify-center py-16 text-danger text-sm">{error}</div>
		{:else}
			<div class="docx-preview bg-white text-zinc-900 p-10 rounded-lg shadow-sm">
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- mammoth's output, passed through sanitizeDocxHtml above -->
				{@html html}
			</div>
			{#if warnings.length > 0}
				<div class="mt-4 text-xs text-text-tertiary">
					Preview is approximate. {warnings.length} formatting detail{warnings.length === 1 ? '' : 's'} not shown — download for exact layout.
				</div>
			{/if}
		{/if}
	</div>
</div>

<style>
	.docx-preview :global(p) { margin: 0 0 0.75em; line-height: 1.6; }
	.docx-preview :global(h1) { font-size: 1.75em; font-weight: 700; margin: 1em 0 0.5em; }
	.docx-preview :global(h2) { font-size: 1.4em; font-weight: 600; margin: 1em 0 0.5em; }
	.docx-preview :global(h3) { font-size: 1.2em; font-weight: 600; margin: 1em 0 0.5em; }
	.docx-preview :global(ul), .docx-preview :global(ol) { padding-left: 1.5em; margin: 0.5em 0; }
	.docx-preview :global(li) { margin: 0.25em 0; }
	.docx-preview :global(table) { border-collapse: collapse; width: 100%; margin: 1em 0; }
	.docx-preview :global(td), .docx-preview :global(th) {
		border: 1px solid #d1d9e0; padding: 6px 10px; vertical-align: top;
	}
	.docx-preview :global(img) { max-width: 100%; height: auto; }
	.docx-preview :global(strong) { font-weight: 600; }
	.docx-preview :global(em) { font-style: italic; }
	/* In the app DOM, so it follows the palette — unlike the email-body
	   iframe, where CSS variables do not reach. */
	.docx-preview :global(a) { color: var(--color-accent); text-decoration: underline; }
</style>
