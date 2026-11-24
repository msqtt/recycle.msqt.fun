import { DEFAULTS } from '@wtop/types';
/**
 * 固定 iframe 层（协议 §5.5/§7.1 硬约束）：
 * - 所有 iframe 永久挂在同一 layerRoot 下，绝不 reparent；
 * - 隐藏 = offscreen 定位（保持真实尺寸，rAF 活跃），禁止 display:none；
 * - 查看 = 同一 wrapper 改 CSS 定位到目标 rect。
 */
export class IframeLayer {
    constructor(root) {
        this.root = root;
        this.wrappers = new Map();
        this.viewports = new Map();
    }
    create(id, opts) {
        const viewport = opts.viewport ?? DEFAULTS.viewport;
        const wrapper = document.createElement('div');
        wrapper.dataset.wtopId = id;
        wrapper.style.cssText =
            `position:fixed;left:-99999px;top:0;width:${viewport.width}px;height:${viewport.height}px;` +
                `border:0;padding:0;margin:0;background:#fff;`;
        const iframe = document.createElement('iframe');
        let sandbox = 'allow-scripts allow-forms allow-downloads';
        if (opts.allowSameOrigin)
            sandbox += ' allow-same-origin';
        iframe.setAttribute('sandbox', sandbox);
        iframe.setAttribute('allow', 'clipboard-write');
        iframe.setAttribute('referrerpolicy', 'no-referrer');
        iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;';
        const sep = opts.url.includes('?') ? '&' : '?';
        iframe.src = `${opts.url}${sep}wtop=1`;
        wrapper.appendChild(iframe);
        this.root.appendChild(wrapper);
        this.wrappers.set(id, wrapper);
        this.viewports.set(id, viewport);
        return iframe;
    }
    show(id, rect) {
        const w = this.wrappers.get(id);
        if (!w)
            return;
        const vp = this.viewports.get(id) ?? DEFAULTS.viewport;
        const r = rect ?? {
            left: Math.max(0, (window.innerWidth - vp.width) / 2),
            top: Math.max(0, (window.innerHeight - vp.height) / 2),
            width: vp.width,
            height: vp.height,
        };
        w.style.left = `${r.left}px`;
        w.style.top = `${r.top}px`;
        w.style.width = `${r.width}px`;
        w.style.height = `${r.height}px`;
        w.style.zIndex = '2147483000';
        w.style.boxShadow = '0 8px 40px rgba(0,0,0,.35)';
    }
    hide(id) {
        const w = this.wrappers.get(id);
        if (!w)
            return;
        const vp = this.viewports.get(id) ?? DEFAULTS.viewport;
        w.style.left = '-99999px';
        w.style.top = '0';
        w.style.width = `${vp.width}px`;
        w.style.height = `${vp.height}px`;
        w.style.zIndex = '';
        w.style.boxShadow = '';
    }
    destroy(id) {
        const w = this.wrappers.get(id);
        if (w) {
            w.remove();
            this.wrappers.delete(id);
            this.viewports.delete(id);
        }
    }
    dispose() {
        for (const id of [...this.wrappers.keys()])
            this.destroy(id);
    }
}
//# sourceMappingURL=layer.js.map