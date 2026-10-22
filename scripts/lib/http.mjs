// Retrying a request that failed for a reason that may pass: the network, or a 429 or 5xx answer.

/** Thrown for an answer worth retrying; anything else ends the attempts at once. */
export class Retryable extends Error {
	name = 'Retryable';
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True for statuses that may pass on their own. */
export function transient(status) {
	return status === 429 || status >= 500;
}

/**
 * Runs `attempt(n)` until it returns, up to `attempts` times, waiting `delayMs * 2^(n-1)` between
 * tries. A Retryable or a network error (fetch's TypeError) is tried again; the last one is thrown.
 */
export async function withRetries(attempt, { attempts = 3, delayMs = 2000, wait = sleep, log = () => {} } = {}) {
	for (let n = 1; ; n++) {
		try {
			return await attempt(n);
		} catch (err) {
			const retry = err instanceof Retryable || err instanceof TypeError;
			if (!retry || n >= attempts) throw err;
			log(`attempt ${n} failed (${err.message}); trying again`);
			await wait(delayMs * 2 ** (n - 1));
		}
	}
}

/** A response body as JSON, or null when it isn't JSON. */
export async function jsonBody(response) {
	try {
		return await response.json();
	} catch {
		return null;
	}
}
