let draining = false;

/** Flipped on SIGTERM so health checks can fail before the listener actually closes. */
export function beginDraining(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}

/**
 * Bounds an operation that has no timeout of its own, so one unresponsive dependency cannot
 * hold a request open for as long as its driver's default allows.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
