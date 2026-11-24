import { type Viewport } from '@wtop/types';
export interface ViewRect {
    left: number;
    top: number;
    width: number;
    height: number;
}
/**
 * 固定 iframe 层（协议 §5.5/§7.1 硬约束）：
 * - 所有 iframe 永久挂在同一 layerRoot 下，绝不 reparent；
 * - 隐藏 = offscreen 定位（保持真实尺寸，rAF 活跃），禁止 display:none；
 * - 查看 = 同一 wrapper 改 CSS 定位到目标 rect。
 */
export declare class IframeLayer {
    private root;
    private wrappers;
    private viewports;
    constructor(root: HTMLElement);
    create(id: string, opts: {
        url: string;
        viewport?: Viewport;
        allowSameOrigin?: boolean;
    }): HTMLIFrameElement;
    show(id: string, rect?: ViewRect): void;
    hide(id: string): void;
    destroy(id: string): void;
    dispose(): void;
}
//# sourceMappingURL=layer.d.ts.map