import { type Transport, type Viewport } from '@wtop/core';
import { type CallState, type CancelReason, type Logger, type MethodMode, type Progress, type Unsubscribe, type WaitingHumanInfo } from '@wtop/types';
import { type ViewRect } from './layer.js';
import { type RegistryClient, type RegistryOptions } from './registry.js';
export interface HostInstance {
    transport: Transport;
    show(rect?: ViewRect): void;
    hide(): void;
    destroy(): void;
}
export type InstanceFactory = (opts: {
    id: string;
    toolUrl: string;
    viewport?: Viewport;
    allowSameOrigin?: boolean;
}) => HostInstance;
export interface HostOptions {
    allowedOrigins: string[];
    maxConcurrent?: number;
    preserveFailedMs?: number;
    /** 成功调用被用户展示（show）后的保活上限；hide 即回收，到期兜底回收 */
    keepShownMs?: number;
    handshakeTimeoutMs?: number;
    defaultTimeoutMs?: number;
    humanTimeoutMs?: number;
    largeFileThresholdBytes?: number;
    cancelGraceMs?: number;
    heartbeatIntervalMs?: number;
    progressSilenceMs?: number;
    layerRoot?: HTMLElement;
    /** 测试/devtools 注入实例工厂；默认固定 iframe 层 + postMessage */
    instanceFactory?: InstanceFactory;
    registry?: RegistryClient;
    registryOptions?: RegistryOptions;
    /** 本宿主 origin（写入 ack.hostOrigin）；默认 location.origin */
    hostOrigin?: string;
    logger?: Logger;
}
export interface ExecuteOptions {
    toolUrl: string;
    method: string;
    params: unknown;
    timeoutMs?: number;
    attempt?: number;
    allowSameOrigin?: boolean;
    viewport?: Viewport;
    preserveScene?: boolean;
    /** 覆盖 manifest 方法模式（HOST 节点配置）；hybrid/interactive 覆盖会禁用池化复用 */
    modeOverride?: MethodMode;
    onProgress?: (p: Progress) => void;
    onWaitingHuman?: (info: WaitingHumanInfo) => void;
    onState?: (s: CallState) => void;
}
export interface Call {
    readonly id: string;
    readonly state: CallState;
    readonly result: Promise<unknown>;
    readonly progress: Progress;
    onProgress(cb: (p: Progress) => void): Unsubscribe;
    onWaitingHuman(cb: (info: WaitingHumanInfo) => void): Unsubscribe;
    onState(cb: (s: CallState) => void): Unsubscribe;
    cancel(reason?: CancelReason): void;
}
export type HostEvent = 'call:state' | 'call:progress' | 'call:waiting-human' | 'registry:changed' | 'pool:queued' | 'iframe:crashed';
export interface Host {
    readonly registry: RegistryClient;
    execute(opts: ExecuteOptions): Call;
    getCall(id: string): Call | undefined;
    show(id: string, rect?: ViewRect): void;
    hide(id: string): void;
    cancel(id: string, reason?: CancelReason): void;
    on(event: HostEvent, cb: (payload: unknown) => void): Unsubscribe;
    dispose(): void;
}
export declare function createHost(options: HostOptions): Host;
//# sourceMappingURL=host.d.ts.map