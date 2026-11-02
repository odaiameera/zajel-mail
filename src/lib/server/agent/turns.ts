/**
 * Chat sessions with a turn still running in this process. The turn carries
 * on when the browser loses its reply (a phone that slept, a network switch),
 * so the panel asks for the session again and waits while this says the
 * reply is still coming.
 */

const running = new Map<string, number>();

/** Mark the session busy until `work` settles. */
export function trackTurn<T>(conversationId: string, work: Promise<T>): Promise<T> {
	running.set(conversationId, (running.get(conversationId) ?? 0) + 1);
	return work.finally(() => {
		const left = (running.get(conversationId) ?? 1) - 1;
		if (left > 0) running.set(conversationId, left);
		else running.delete(conversationId);
	});
}

export function turnRunning(conversationId: string): boolean {
	return running.has(conversationId);
}
