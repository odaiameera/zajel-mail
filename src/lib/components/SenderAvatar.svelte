<script lang="ts">
	import { avatarColor, initial, normalizeEmail } from '$lib/utils/avatar';

	let {
		email,
		name = '',
		size = 32
	}: {
		email: string | null | undefined;
		name?: string | null;
		size?: number;
	} = $props();

	const normalized = $derived(normalizeEmail(email));
	const letter = $derived(initial(name, normalized));
	const bg = $derived(avatarColor(normalized || letter));
	const src = $derived(normalized ? `/api/avatar?email=${encodeURIComponent(normalized)}` : '');

	/**
	 * The plate a transparent mark sits on. White suits the overwhelming
	 * majority — brand marks are drawn for white — but a mark that is itself
	 * white or near-white disappears on it completely, which is worse than the
	 * clashing colour this replaced. {@link pickPlate} looks at the pixels and
	 * flips to a dark plate for that case.
	 */
	const PLATE_LIGHT = '#ffffff';
	const PLATE_DARK = '#24292f';

	/**
	 * pending: the avatar may still come, so the disc is a quiet neutral, with
	 * no letter and no colour. The hashed chip used to be the placeholder, so
	 * every logo arrived over a flash of red or green, cached ones included.
	 * loaded: the image, on its plate. missing: the server has none (its 204)
	 * or it failed, and only now does the initials chip fade in.
	 */
	let status = $state<'pending' | 'loaded' | 'missing'>(src ? 'pending' : 'missing');
	let plate = $state(PLATE_LIGHT);
	let imgEl = $state<HTMLImageElement>();

	// Reset when the sender changes; a reused row instance must not keep the
	// previous sender's avatar while the new one is still loading.
	//
	// Then catch an image that has already settled. On a reload the list comes
	// from the server and the avatars from the browser's cache, so they finish
	// before hydration attaches onload/onerror. Svelte would replay those
	// through an inline onload="this.__e=event" it writes on server-rendered
	// images, but the app's CSP (svelte.config.js) refuses inline handlers, so
	// the events never arrive. A complete image with no width is a miss or an
	// error.
	$effect(() => {
		src;
		plate = PLATE_LIGHT;
		status = src ? 'pending' : 'missing';
		if (imgEl?.complete) {
			if (imgEl.naturalWidth > 0) onImageReady(imgEl);
			else status = 'missing';
		}
	});

	/**
	 * Decide the plate from the image itself.
	 *
	 * The avatar is same-origin (`/api/avatar`), so the canvas is not tainted
	 * and the pixels are readable. Downsampling to 16x16 first keeps this to a
	 * few hundred samples per avatar regardless of the source resolution.
	 *
	 * Only images that actually carry transparency get a dark plate, and only
	 * when what remains is light — an opaque favicon covers the plate anyway,
	 * so its verdict is irrelevant and it keeps the default.
	 */
	function pickPlate(img: HTMLImageElement): string {
		try {
			const N = 16;
			const canvas = document.createElement('canvas');
			canvas.width = N;
			canvas.height = N;
			const ctx = canvas.getContext('2d', { willReadFrequently: true });
			if (!ctx) return PLATE_LIGHT;
			ctx.drawImage(img, 0, 0, N, N);
			const { data } = ctx.getImageData(0, 0, N, N);

			let transparent = false;
			let lumaSum = 0;
			let opaqueCount = 0;
			for (let i = 0; i < data.length; i += 4) {
				const a = data[i + 3];
				if (a < 250) transparent = true;
				if (a > 128) {
					// Rec. 601 luma is close enough for a light/dark verdict.
					lumaSum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
					opaqueCount++;
				}
			}
			if (!transparent || opaqueCount === 0) return PLATE_LIGHT;
			// 0.62 of full scale: comfortably past mid-grey, so only a genuinely
			// light mark trips it and a mid-tone logo stays on white.
			return lumaSum / opaqueCount > 255 * 0.62 ? PLATE_DARK : PLATE_LIGHT;
		} catch {
			// Canvas unavailable or the read was refused — the default is the
			// right answer for almost every mark anyway.
			return PLATE_LIGHT;
		}
	}

	function onImageReady(img: HTMLImageElement) {
		plate = pickPlate(img);
		status = 'loaded';
	}

	function onImageLoad(event: Event) {
		onImageReady(event.currentTarget as HTMLImageElement);
	}
</script>

<!--
	The disc itself is the pending state: a neutral fill and the same hairline
	ring a loaded avatar has, so the shape is there from the first frame and
	nothing about it changes when a logo lands on it.
-->
<div
	class="relative rounded-full overflow-hidden select-none shrink-0"
	style="width:{size}px;height:{size}px;background-color:var(--color-surface-hover);box-shadow:inset 0 0 0 1px var(--color-border)"
	data-status={status}
>
	<!--
		Initials chip, only once there is no avatar to wait for. Its colour is
		hashed from the address, so it is a different hue per sender: fine as
		a fallback, wrong as a backdrop.
	-->
	<div
		class="absolute inset-0 flex items-center justify-center text-white font-semibold transition-opacity duration-150"
		style="background-color:{bg};font-size:{Math.round(size * 0.42)}px;opacity:{status === 'missing' ? 1 : 0}"
		aria-hidden="true"
	>
		{letter}
	</div>
	{#if src}
		<!--
			Three things matter once an avatar loads.

			The plate underneath is not the hashed chip. A great many brand marks
			are transparent PNGs or SVGs, and the chip used to show through them —
			a random hue behind a logo drawn for a plain background, clashing more
			often than not. It defaults to white, which is what those marks are
			designed against, and `pickPlate` flips it dark for the minority that
			are light-on-transparent and would otherwise vanish into it.

			`object-cover`, deliberately, after trying `contain`. Plenty of
			favicons are an opaque brand square — NVIDIA's green, Substack's
			orange — and those are meant to fill the disc edge to edge, which is
			how they already looked. `contain` plus padding shrinks them into a
			rounded square floating on a circle with the corners showing: strictly
			worse for the common case, to protect a wide wordmark that favicons
			almost never are. Cover keeps opaque marks exactly as they were and
			still fixes the transparent ones, which only ever needed what is
			behind them to change.

			The hairline ring is what stops a white plate from disappearing into a
			white row in light mode — without it the disc has no edge and the mark
			just floats.

			No fade, and no opacity gate: the browser paints the image the moment
			it has it (at once, from the cache), over the neutral disc. The plate
			goes on once it is known; before that the image is transparent, so a
			pending disc shows no white. A miss is hidden rather than removed, so
			the element (and imgEl) stays put.
		-->
		<img
			bind:this={imgEl}
			{src}
			alt=""
			width={size}
			height={size}
			loading="lazy"
			decoding="async"
			class="absolute inset-0 w-full h-full object-cover"
			style="background-color:{status === 'loaded' ? plate : 'transparent'};box-shadow:inset 0 0 0 1px var(--color-border);visibility:{status === 'missing' ? 'hidden' : 'visible'}"
			draggable="false"
			onload={onImageLoad}
			onerror={() => (status = 'missing')}
		/>
	{/if}
</div>
