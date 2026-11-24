import { type Manifest, type Unsubscribe } from '@wtop/core';
export type ToolHealth = 'ok' | 'degraded' | 'unreachable' | 'unknown';
export interface RegistryEntry {
    url: string;
    manifest: Manifest;
    hash: string;
    version: string;
    health: ToolHealth;
    addedAt: number;
    updatedAt: number;
}
export interface RegistryClient {
    add(url: string): Promise<RegistryEntry>;
    get(url: string): RegistryEntry | undefined;
    list(): RegistryEntry[];
    refresh(url: string): Promise<RegistryEntry>;
    remove(url: string): void;
    setHealth(url: string, health: ToolHealth): void;
    export(): RegistryEntry[];
    import(entries: RegistryEntry[]): void;
    onChange(cb: () => void): Unsubscribe;
}
export declare function normalizeUrl(url: string): string;
export declare const MANIFEST_PATH = "/.well-known/wtop-manifest.json";
export interface RegistryOptions {
    /** 可注入 fetch（测试用）；默认 globalThis.fetch */
    fetcher?: (url: string) => Promise<{
        ok: boolean;
        status: number;
        json(): Promise<unknown>;
    }>;
    logger?: {
        warn(msg: string, ...args: unknown[]): void;
    };
}
export declare function createRegistryClient(opts?: RegistryOptions): RegistryClient;
//# sourceMappingURL=registry.d.ts.map