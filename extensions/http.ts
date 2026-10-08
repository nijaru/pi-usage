/** Bounded, cancellable JSON transport shared by quota and balance endpoints. */
export type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

const MAX_RESPONSE_BYTES = 1024 * 1024;

export async function getJsonHeaders(
	url: string, headers: Record<string, string>, signal: AbortSignal, fetcher: Fetcher = globalThis.fetch,
	errorPrefix = "Usage",
): Promise<unknown> {
	signal.throwIfAborted();
	const response = await fetcher(url, { method: "GET", headers: { ...headers, Accept: "application/json" }, redirect: "error", signal });
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new Error(`${errorPrefix} request failed (${response.status})`);
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Empty usage response");
	const chunks: Uint8Array[] = [];
	let size = 0;
	const abort = () => { void reader.cancel().catch(() => {}); };
	signal.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			signal.throwIfAborted();
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > MAX_RESPONSE_BYTES) throw new Error("Usage response exceeds 1 MiB");
			chunks.push(value);
		}
		signal.throwIfAborted();
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
		try { return JSON.parse(new TextDecoder().decode(bytes)); }
		catch { throw new Error("Invalid usage JSON"); }
	} finally {
		signal.removeEventListener("abort", abort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
