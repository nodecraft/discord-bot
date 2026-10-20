// A cleared timer, unlike AbortSignal.timeout(), doesn't keep a Durable Object awake; racing covers callers like nc_fetch that drop the signal

export async function withTimeout<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new DOMException(`Timed out after ${ms}ms`, 'TimeoutError')), ms);
	const timedOut = new Promise<never>((_resolve, reject) => {
		controller.signal.addEventListener('abort', () => reject(controller.signal.reason));
	});
	try {
		return await Promise.race([work(controller.signal), timedOut]);
	} finally {
		clearTimeout(timer);
	}
}
