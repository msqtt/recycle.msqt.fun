import { WtopError } from '@wtop/types';

export interface JsExecutor {
  run(code: string, inputs: unknown, context: unknown, opts: {
    timeoutMs: number;
    signal: AbortSignal;
    onLog(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  }): Promise<unknown>;
}

// 防误伤的隔离（无 DOM/无宿主对象），不是对抗恶意代码的安全边界；fetch 仍受页面 CSP 约束
const WORKER_SRC = `
self.onmessage = async (e) => {
  const { code, inputs, context } = e.data;
  const fmt = (a) => a.map((x) => {
    if (typeof x === 'string') return x;
    try { return JSON.stringify(x); } catch { return String(x); }
  }).join(' ');
  const send = (m) => self.postMessage(m);
  const mk = (l) => (...a) => send({ t: 'log', l, m: fmt(a) });
  const console = { log: mk('info'), info: mk('info'), debug: mk('debug'), warn: mk('warn'), error: mk('error') };
  let v;
  try {
    const fn = new Function('inputs', 'context', 'console',
      '"use strict"; return (async () => {' + code + '\\n})();');
    v = await fn(inputs, context, console);
  } catch (err) {
    send({ t: 'error', m: String((err && err.message) || err) });
    return;
  }
  try { send({ t: 'result', v }); } catch { send({ t: 'clone-error' }); }
};`;

export const defaultJsExecutor: JsExecutor = {
  run(code, inputs, context, opts) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
      const worker = new Worker(url);
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal.removeEventListener('abort', onAbort);
        worker.terminate();
        URL.revokeObjectURL(url);
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new WtopError('TIMEOUT', `函数执行超时（${opts.timeoutMs}ms）`))),
        opts.timeoutMs,
      );
      const onAbort = () => finish(() => reject(new WtopError('CANCELLED', '运行被取消')));
      if (opts.signal.aborted) { onAbort(); return; }
      opts.signal.addEventListener('abort', onAbort, { once: true });
      worker.onerror = (e) => finish(() => reject(new WtopError('BUSINESS_ERROR', e.message || '函数 Worker 错误')));
      worker.onmessage = (e) => {
        const m = e.data as { t: string; l?: 'debug' | 'info' | 'warn' | 'error'; m?: string; v?: unknown };
        if (m.t === 'log') { opts.onLog(m.l ?? 'info', m.m ?? ''); return; }
        if (m.t === 'result') finish(() => resolve(m.v));
        else if (m.t === 'clone-error') finish(() => reject(new WtopError('INVALID_OUTPUT', '函数返回值不可序列化（须为 JSON / Blob / ArrayBuffer）')));
        else finish(() => reject(new WtopError('BUSINESS_ERROR', m.m ?? '函数执行失败')));
      };
      worker.postMessage({ code, inputs, context });
    });
  },
};