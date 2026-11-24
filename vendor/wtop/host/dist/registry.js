import { manifestHash, validateManifest } from '@wtop/core';
export function normalizeUrl(url) {
    return url.replace(/\/+$/, '');
}
export const MANIFEST_PATH = '/.well-known/wtop-manifest.json';
export function createRegistryClient(opts = {}) {
    const fetcher = opts.fetcher ?? ((url) => fetch(url));
    const entries = new Map();
    const listeners = new Set();
    const notify = () => { for (const cb of listeners)
        cb(); };
    const pull = async (url) => {
        const res = await fetcher(normalizeUrl(url) + MANIFEST_PATH);
        if (!res.ok)
            throw new Error(`拉取 manifest 失败: HTTP ${res.status}`);
        const manifest = await res.json();
        validateManifest(manifest);
        return { manifest, hash: await manifestHash(manifest) };
    };
    return {
        async add(url) {
            const key = normalizeUrl(url);
            const { manifest, hash } = await pull(key);
            const now = Date.now();
            const entry = {
                url: key, manifest, hash, version: manifest.version,
                health: 'unknown', addedAt: entries.get(key)?.addedAt ?? now, updatedAt: now,
            };
            entries.set(key, entry);
            notify();
            return entry;
        },
        get(url) { return entries.get(normalizeUrl(url)); },
        list() { return [...entries.values()]; },
        async refresh(url) {
            const key = normalizeUrl(url);
            const { manifest, hash } = await pull(key);
            const prev = entries.get(key);
            const entry = {
                url: key, manifest, hash, version: manifest.version,
                health: prev?.health ?? 'unknown',
                addedAt: prev?.addedAt ?? Date.now(), updatedAt: Date.now(),
            };
            entries.set(key, entry);
            notify();
            return entry;
        },
        remove(url) { entries.delete(normalizeUrl(url)); notify(); },
        setHealth(url, health) {
            const e = entries.get(normalizeUrl(url));
            if (e) {
                e.health = health;
                notify();
            }
        },
        export() { return [...entries.values()]; },
        import(list) {
            entries.clear();
            for (const e of list)
                entries.set(normalizeUrl(e.url), e);
            notify();
        },
        onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    };
}
//# sourceMappingURL=registry.js.map