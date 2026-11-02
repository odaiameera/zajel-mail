<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import type { EmailAttachment } from '$lib/jmap/types';
	import type { ViewerAttachment } from '$lib/attachments/types';
	import { detectKind } from '$lib/attachments/detect';
	import { attachmentUrl } from '$lib/attachments/fetch';
	import ViewerModal from './viewers/ViewerModal.svelte';

	/**
	 * `attachments` is the list as shown: which of an email's parts are cards
	 * (and which the body already draws) is worked out by
	 * `attachmentCards` in `$lib/attachments/list`.
	 */
	let { emailId, attachments }: {
		emailId: string;
		attachments: EmailAttachment[];
	} = $props();

	let activeAttachment = $state<ViewerAttachment | null>(null);

	function openViewer(a: EmailAttachment) {
		activeAttachment = {
			emailId,
			blobId: a.blobId,
			name: a.name ?? 'attachment',
			type: a.type,
			size: a.size,
			kind: detectKind(a.type, a.name)
		};
	}

	function downloadAttachment(a: EmailAttachment, e: MouseEvent) {
		e.stopPropagation();
		const name = a.name ?? 'attachment';
		const link = document.createElement('a');
		link.href = attachmentUrl(emailId, a.blobId, name);
		link.download = name;
		link.click();
	}

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	type IconKind = 'image' | 'pdf' | 'video' | 'audio' | 'archive' | 'doc' | 'sheet' | 'slides' | 'file';

	function iconKindFor(type: string): IconKind {
		if (type.startsWith('image/')) return 'image';
		if (type === 'application/pdf') return 'pdf';
		if (type.startsWith('video/')) return 'video';
		if (type.startsWith('audio/')) return 'audio';
		if (type.includes('zip') || type.includes('tar') || type.includes('rar')) return 'archive';
		if (type.includes('word') || type.includes('document')) return 'doc';
		if (type.includes('sheet') || type.includes('excel')) return 'sheet';
		if (type.includes('presentation') || type.includes('powerpoint')) return 'slides';
		return 'file';
	}
</script>

{#if attachments.length > 0}
	<div class="border-t border-border px-6 py-3 shrink-0">
		<div class="text-xs text-text-tertiary mb-2">
			{attachments.length} {attachments.length === 1 ? 'attachment' : 'attachments'}
		</div>
		<div class="flex flex-wrap gap-2">
			{#each attachments as a (a.blobId)}
				{@const kind = iconKindFor(a.type)}
				<!-- A body part's size is not always known (then it is 0). -->
				<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
				<div
					onclick={() => openViewer(a)}
					title={a.size > 0 ? `${a.name ?? 'attachment'} · ${formatSize(a.size)}` : (a.name ?? 'attachment')}
					class="flex items-center gap-2 px-3 py-2 bg-surface-hover border border-border rounded-lg hover:border-accent hover:bg-accent/5 transition-colors cursor-pointer group max-w-[280px]"
				>
					<span class="shrink-0 text-text-secondary group-hover:text-accent-fg transition-colors">
						{#if kind === 'image'}
							<Icon name="file-image" size={20} />
						{:else if kind === 'pdf'}
							<Icon name="file-pdf" size={20} />
						{:else if kind === 'video'}
							<Icon name="file-video" size={20} />
						{:else if kind === 'audio'}
							<Icon name="file-audio" size={20} />
						{:else if kind === 'archive'}
							<Icon name="archive" size={20} />
						{:else if kind === 'doc' || kind === 'sheet' || kind === 'slides'}
							<Icon name="file-document" size={20} />
						{:else}
							<Icon name="file" size={20} />
						{/if}
					</span>
					<div class="min-w-0 flex-1">
						<div class="text-sm text-text truncate">{a.name ?? 'unnamed'}</div>
						{#if a.size > 0}
							<div class="text-xs text-text-tertiary">{formatSize(a.size)}</div>
						{/if}
					</div>
					<button
						onclick={(e) => downloadAttachment(a, e)}
						title="Download"
						class="shrink-0 p-1 rounded-md text-text-tertiary hover:text-accent-fg hover:bg-accent/10 transition-colors cursor-pointer opacity-0 group-hover:opacity-100"
					>
						<Icon name="download" size={14} />
					</button>
				</div>
			{/each}
		</div>
	</div>
{/if}

{#if activeAttachment}
	<ViewerModal attachment={activeAttachment} onClose={() => (activeAttachment = null)} />
{/if}
