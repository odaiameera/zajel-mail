/**
 * A JSON reply for work that may outlast a proxy's patience.
 *
 * An agent turn can take up to two and a half minutes, longer than a reverse proxy
 * waits by default (nginx 60 s, Cloudflare 100 s). A proxy that gives up
 * answers with its own error page, which the panel can only report as "could
 * not answer". So the reply starts at once and a space goes out every 15 s
 * until the JSON is ready; JSON allows leading whitespace, so the client
 * parses it unchanged. The status is 200 from the start, and a failure
 * arrives as `{ error }`, which the panel already shows.
 */
export function heldOpen(work: Promise<Record<string, unknown>>, heartbeatMs = 15_000): Response {
	const encoder = new TextEncoder();
	let timer: ReturnType<typeof setInterval> | undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (text: string) => {
				try {
					controller.enqueue(encoder.encode(text));
				} catch {
					// The browser went away; the turn still finishes and is logged.
				}
			};
			send(' ');
			timer = setInterval(() => send(' '), heartbeatMs);
			void work.then((payload) => {
				clearInterval(timer);
				send(JSON.stringify(payload));
				try {
					controller.close();
				} catch {
					// Already cancelled.
				}
			});
		},
		cancel() {
			clearInterval(timer);
		}
	});
	return new Response(body, {
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }
	});
}
