/** Bound a request even when its implementation ignores cancellation. */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([controller.signal, parentSignal])
    : controller.signal;
  let rejectAbort: () => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(signal.reason);
    if (signal.aborted) rejectAbort();
    else signal.addEventListener("abort", rejectAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return operation(signal);
      }),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", rejectAbort!);
  }
}
