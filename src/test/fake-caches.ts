// Map-backed CacheStorage shim for tests (happy-dom ships Response/fetch
// types but no `caches`), same pattern as fake-storage.ts. Install with
// vi.stubGlobal('caches', fakeCaches().storage). Only the surface
// artifact-store.ts touches: open/match/put/delete/keys, string keys.

export class FakeCache {
  readonly store = new Map<string, Response>()

  async match(key: string): Promise<Response | undefined> {
    // Real caches consume a Response body once; hand out clones like the
    // real thing so repeated matches keep working.
    return this.store.get(key)?.clone()
  }

  async put(key: string, res: Response): Promise<void> {
    this.store.set(key, res)
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key)
  }

  async keys(): Promise<string[]> {
    return [...this.store.keys()]
  }
}

export function fakeCaches(): { storage: unknown; caches: Map<string, FakeCache> } {
  const caches = new Map<string, FakeCache>()
  return {
    caches,
    storage: {
      async open(name: string): Promise<FakeCache> {
        let c = caches.get(name)
        if (!c) {
          c = new FakeCache()
          caches.set(name, c)
        }
        return c
      },
    },
  }
}
