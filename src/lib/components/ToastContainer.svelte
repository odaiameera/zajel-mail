<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { toasts, dismissToast, type Toast, type ToastAction } from '$lib/stores/toast';
	import { fly } from 'svelte/transition';

	function actionsOf(toast: Toast): ToastAction[] {
		return [...(toast.action ? [toast.action] : []), ...(toast.extraActions ?? [])];
	}

	function handleAction(id: string, run: () => void) {
		run();
		dismissToast(id);
	}
</script>

<!-- Above the tab bar on phones. -->
<div class="fixed bottom-4 right-4 max-md:left-4 max-md:bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-50 flex flex-col gap-2 max-w-sm pointer-events-none">
	{#each $toasts as toast (toast.id)}
		<div
			role="status"
			aria-live="polite"
			class="pointer-events-auto bg-surface border border-border rounded-lg shadow-lg px-4 py-3 flex items-center gap-3"
			in:fly={{ y: 12, duration: 180 }}
			out:fly={{ y: 12, duration: 120 }}
		>
			<span class="text-sm text-text flex-1 min-w-0">{toast.message}</span>
			{#each actionsOf(toast) as action (action.label)}
				<button
					onclick={() => handleAction(toast.id, action.onClick)}
					class="text-xs font-medium text-accent-fg hover:text-accent-fg-hover transition-colors cursor-pointer shrink-0"
				>
					{action.label}
				</button>
			{/each}
			<button
				onclick={() => dismissToast(toast.id)}
				title="Dismiss"
				class="p-1 rounded-md text-text-tertiary hover:text-text hover:bg-surface-hover transition-colors cursor-pointer shrink-0"
			>
				<Icon name="close" size={14} />
			</button>
		</div>
	{/each}
</div>
