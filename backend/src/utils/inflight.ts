export const inFlight = new Map<string, Promise<any>>();

export function withCoalescing<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (inFlight.has(key)) {
    return inFlight.get(key) as Promise<T>;
  }
  const p = fn().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}
