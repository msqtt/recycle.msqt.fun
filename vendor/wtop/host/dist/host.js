import { PostMessageTransport, assertParamsFiles, assertData, negotiateVersion, randomId, } from '@wtop/core';
import { DEFAULTS, PROTOCOL_VERSION, WtopError, } from '@wtop/types';
import { IframeLayer } from './layer.js';
import { createRegistryClient, normalizeUrl, } from './registry.js';
export function createHost(options) {
    const { allowedOrigins, maxConcurrent = DEFAULTS.maxConcurrent, preserveFailedMs = DEFAULTS.preserveFailedMs, handshakeTimeoutMs = DEFAULTS.handshakeTimeoutMs, defaultTimeoutMs = DEFAULTS.defaultTimeoutMs, humanTimeoutMs = DEFAULTS.humanTimeoutMs, largeFileThresholdBytes = DEFAULTS.largeFileThresholdBytes, cancelGraceMs = DEFAULTS.cancelGraceMs, heartbeatIntervalMs = DEFAULTS.heartbeatIntervalMs, progressSilenceMs = DEFAULTS.progressSilenceMs, logger = console, } = options;
    const registry = options.registry ?? createRegistryClient(options.registryOptions);
    const layer = options.layerRoot ? new IframeLayer(options.layerRoot) : null;
    const factory = options.instanceFactory ?? ((opts) => {
        if (!layer)
            throw new Error('createHost 需要 layerRoot（固定 iframe 层容器）或 instanceFactory');
        const iframe = layer.create(opts.id, {
            url: opts.toolUrl, viewport: opts.viewport, allowSameOrigin: opts.allowSameOrigin,
        });
        const origin = new URL(opts.toolUrl).origin;
        const transport = new PostMessageTransport({
            remote: () => iframe.contentWindow,
            allowedOrigins: [origin],
            remoteOpaque: !opts.allowSameOrigin,
            logger,
        });
        return {
            transport,
            show: (rect) => layer.show(opts.id, rect),
            hide: () => layer.hide(opts.id),
            destroy: () => { transport.dispose(); layer.destroy(opts.id); },
        };
    });
    const recs = new Map();
    const queue = [];
    const pool = new Map();
    const bus = new Map();
    let disposed = false;
    const emit = (event, payload) => {
        for (const cb of bus.get(event) ?? [])
            cb(payload);
    };
    const setState = (rec, s) => {
        rec.state = s;
        for (const cb of rec.stateCbs)
            cb(s);
        emit('call:state', { callId: rec.id, state: s });
    };
    const clearTimers = (rec) => {
        for (const t of [rec.handshakeTimer, rec.execTimer, rec.humanTimer, rec.silenceTimer, rec.graceTimer]) {
            if (t)
                clearTimeout(t);
        }
        rec.handshakeTimer = rec.execTimer = rec.humanTimer = rec.silenceTimer = rec.graceTimer = null;
    };
    const send = (rec, msg) => {
        rec.instance?.transport.send(msg, new URL(rec.toolUrl).origin);
    };
    const activeCount = () => {
        let n = 0;
        for (const r of recs.values()) {
            if (!r.finalized && r.instance)
                n++;
        }
        return n;
    };
    const destroyInstance = (rec) => {
        rec.unsubTransport?.();
        rec.unsubTransport = null;
        rec.instance?.destroy();
        rec.instance = null;
    };
    const pump = () => {
        while (queue.length && activeCount() < maxConcurrent) {
            const rec = queue.shift();
            if (rec.finalized)
                continue;
            startCall(rec);
        }
    };
    const finalizeError = (rec, err) => {
        if (rec.finalized)
            return;
        rec.finalized = true;
        clearTimers(rec);
        rec.reject(err);
        if (err.code === 'CANCELLED') {
            setState(rec, 'cancelled');
            const inst = rec.instance;
            rec.unsubTransport?.();
            rec.unsubTransport = null;
            rec.instance = null;
            if (inst)
                setTimeout(() => inst.destroy(), cancelGraceMs);
        }
        else if (rec.preserveScene && rec.instance) {
            setState(rec, 'failed');
            setState(rec, 'preserving');
            rec.preserveTimer = setTimeout(() => {
                destroyInstance(rec);
                recs.delete(rec.id);
                emit('call:state', { callId: rec.id, state: 'destroyed' });
                pump();
            }, preserveFailedMs);
        }
        else {
            setState(rec, 'failed');
            destroyInstance(rec);
            recs.delete(rec.id);
        }
        pump();
    };
    const finalizeSuccess = (rec, data) => {
        if (rec.finalized)
            return;
        if (rec.methodDef) {
            try {
                assertData(rec.methodDef.output, data, 'INVALID_OUTPUT', `方法 ${rec.method} 出参`);
            }
            catch (e) {
                finalizeError(rec, e);
                return;
            }
        }
        rec.finalized = true;
        clearTimers(rec);
        setState(rec, 'succeeded');
        rec.resolve(data);
        const reusable = rec.methodDef?.mode === 'headless' && rec.methodDef?.stateless === true;
        if (reusable && rec.instance && rec.sessionId) {
            poolInstance(rec);
        }
        else {
            destroyInstance(rec);
            recs.delete(rec.id);
        }
        pump();
    };
    const poolInstance = (rec) => {
        const key = normalizeUrl(rec.toolUrl);
        pool.get(key)?.instance.destroy();
        const pooled = {
            instance: rec.instance, sessionId: rec.sessionId, negotiated: rec.negotiated,
            heartbeatTimer: null, misses: 0, unsub: () => { },
        };
        rec.unsubTransport?.();
        pooled.unsub = pooled.instance.transport.onMessage((msg) => {
            if (msg.type === 'pong')
                pooled.misses = 0;
        });
        pooled.heartbeatTimer = setInterval(() => {
            pooled.misses++;
            if (pooled.misses > DEFAULTS.heartbeatMissLimit) {
                logger.warn(`[wtop/host] 心跳丢失，判定 TOOL_CRASHED: ${key}`);
                dropPooled(key);
                emit('iframe:crashed', { toolUrl: key });
                return;
            }
            pooled.instance.transport.send({ wtop: pooled.negotiated, type: 'ping', sessionId: pooled.sessionId, payload: { ts: Date.now() } }, new URL(key).origin);
        }, heartbeatIntervalMs);
        pool.set(key, pooled);
        rec.instance = null;
        rec.unsubTransport = null;
        recs.delete(rec.id);
    };
    const dropPooled = (key) => {
        const p = pool.get(key);
        if (!p)
            return;
        if (p.heartbeatTimer)
            clearInterval(p.heartbeatTimer);
        p.unsub();
        p.instance.destroy();
        pool.delete(key);
    };
    const startExecTimer = (rec) => {
        rec.execStartedAt = Date.now();
        rec.execTimer = setTimeout(() => {
            rec.execTimer = null;
            rec.forcedCode = 'TIMEOUT';
            if (rec.humanTimer) {
                clearTimeout(rec.humanTimer);
                rec.humanTimer = null;
            }
            if (rec.silenceTimer) {
                clearTimeout(rec.silenceTimer);
                rec.silenceTimer = null;
            }
            send(rec, { wtop: rec.negotiated, type: 'cancel', sessionId: rec.sessionId, callId: rec.id, payload: { reason: 'timeout' } });
            rec.graceTimer = setTimeout(() => {
                finalizeError(rec, new WtopError('TIMEOUT', `执行超时（${rec.execRemaining}ms）`));
            }, cancelGraceMs);
        }, rec.execRemaining);
    };
    const pauseExecTimer = (rec) => {
        if (rec.execTimer) {
            clearTimeout(rec.execTimer);
            rec.execTimer = null;
            rec.execRemaining = Math.max(1, rec.execRemaining - (Date.now() - rec.execStartedAt));
        }
    };
    const resetSilenceTimer = (rec) => {
        if (rec.silenceTimer)
            clearTimeout(rec.silenceTimer);
        rec.silenceTimer = setTimeout(() => {
            rec.silenceTimer = null;
            rec.forcedCode = 'TOOL_CRASHED';
            pauseExecTimer(rec);
            send(rec, { wtop: rec.negotiated, type: 'cancel', sessionId: rec.sessionId, callId: rec.id, payload: { reason: 'crashed' } });
            rec.graceTimer = setTimeout(() => {
                finalizeError(rec, new WtopError('TOOL_CRASHED', `进度静默超过 ${progressSilenceMs}ms，疑似卡死`));
            }, cancelGraceMs);
        }, progressSilenceMs);
    };
    const sendInvoke = (rec) => {
        setState(rec, 'running');
        send(rec, {
            wtop: rec.negotiated, type: 'invoke', sessionId: rec.sessionId, callId: rec.id,
            payload: { method: rec.method, params: rec.params, timeoutMs: rec.timeoutMs, attempt: rec.attempt },
        });
        startExecTimer(rec);
        resetSilenceTimer(rec);
    };
    const handleReady = async (rec, msg) => {
        const entry = registry.get(rec.toolUrl);
        try {
            if (entry) {
                if (msg.payload.toolName !== entry.manifest.name) {
                    throw new WtopError('HANDSHAKE_FAILED', `toolName 不符: ${msg.payload.toolName} != ${entry.manifest.name}`);
                }
                if (msg.payload.manifestHash !== entry.hash) {
                    logger.info(`[wtop/host] manifest 漂移，刷新: ${rec.toolUrl}`);
                    const refreshed = await registry.refresh(rec.toolUrl);
                    if (msg.payload.manifestHash !== refreshed.hash) {
                        throw new WtopError('HANDSHAKE_FAILED', 'manifestHash 漂移且刷新后仍不一致');
                    }
                }
            }
            const negotiated = negotiateVersion(PROTOCOL_VERSION, msg.payload.protocolVersion);
            if (rec.finalized || !rec.instance)
                return;
            rec.negotiated = negotiated;
            rec.sessionId = randomId();
            if (rec.handshakeTimer) {
                clearTimeout(rec.handshakeTimer);
                rec.handshakeTimer = null;
            }
            const entryNow = registry.get(rec.toolUrl);
            rec.methodDef = entryNow?.manifest.methods.find((m) => m.name === rec.method) ?? null;
            rec.execRemaining = rec.timeoutMs ?? rec.methodDef?.timeoutMs ?? defaultTimeoutMs;
            send(rec, {
                wtop: negotiated, type: 'ack', sessionId: rec.sessionId,
                payload: {
                    sessionId: rec.sessionId, nonce: msg.payload.nonce,
                    negotiatedVersion: negotiated, hostOrigin: options.hostOrigin ?? globalThis.location?.origin ?? 'null',
                },
            });
            setState(rec, 'ready');
            if (rec.userShown) {
                send(rec, { wtop: negotiated, type: 'ui.visibility', sessionId: rec.sessionId, callId: rec.id, payload: { visible: true } });
            }
            sendInvoke(rec);
        }
        catch (e) {
            const err = e instanceof WtopError ? e : new WtopError('HANDSHAKE_FAILED', String(e));
            destroyInstance(rec);
            finalizeError(rec, err);
        }
    };
    const attachHandler = (rec) => {
        rec.unsubTransport = rec.instance.transport.onMessage((msg, origin) => {
            // opaque sandbox 时 origin 恒为 'null'，transport 已用 event.source 鉴权
            const opaque = !rec.allowSameOrigin && origin === 'null';
            if (!opaque && origin !== new URL(rec.toolUrl).origin)
                return;
            if (msg.type === 'ready') {
                if (rec.state !== 'handshaking' || rec.sessionId)
                    return;
                void handleReady(rec, msg);
                return;
            }
            if (!rec.sessionId || msg.sessionId !== rec.sessionId)
                return;
            if (msg.callId && msg.callId !== rec.id)
                return;
            if (rec.finalized)
                return;
            switch (msg.type) {
                case 'progress': {
                    rec.progress = msg.payload;
                    for (const cb of rec.progressCbs)
                        cb(msg.payload);
                    emit('call:progress', { callId: rec.id, progress: msg.payload });
                    if (rec.state === 'running')
                        resetSilenceTimer(rec);
                    return;
                }
                case 'result': {
                    if (rec.forcedCode) {
                        finalizeError(rec, new WtopError(rec.forcedCode, '超时已触发，迟到的 result 被丢弃'));
                    }
                    else {
                        finalizeSuccess(rec, msg.payload.data);
                    }
                    return;
                }
                case 'error': {
                    if (rec.forcedCode) {
                        finalizeError(rec, new WtopError(rec.forcedCode, '超时已触发'));
                    }
                    else {
                        finalizeError(rec, new WtopError(msg.payload.code, msg.payload.message, msg.payload.details));
                    }
                    return;
                }
                case 'ui.requestShow': {
                    const info = { blocking: msg.payload.blocking, reason: msg.payload.reason };
                    if (msg.payload.blocking) {
                        pauseExecTimer(rec);
                        if (rec.silenceTimer) {
                            clearTimeout(rec.silenceTimer);
                            rec.silenceTimer = null;
                        }
                        setState(rec, 'waiting-human');
                        rec.humanTimer = setTimeout(() => {
                            rec.humanTimer = null;
                            rec.forcedCode = 'HUMAN_TIMEOUT';
                            send(rec, { wtop: rec.negotiated, type: 'cancel', sessionId: rec.sessionId, callId: rec.id, payload: { reason: 'human-timeout' } });
                            rec.graceTimer = setTimeout(() => {
                                finalizeError(rec, new WtopError('HUMAN_TIMEOUT', '等待人工超时'));
                            }, cancelGraceMs);
                        }, humanTimeoutMs);
                        rec.instance?.show();
                        send(rec, { wtop: rec.negotiated, type: 'ui.visibility', sessionId: rec.sessionId, callId: rec.id, payload: { visible: true } });
                    }
                    for (const cb of rec.waitingCbs)
                        cb(info);
                    emit('call:waiting-human', { callId: rec.id, info });
                    return;
                }
                case 'ui.requestHide': {
                    if (rec.state === 'waiting-human') {
                        if (rec.humanTimer) {
                            clearTimeout(rec.humanTimer);
                            rec.humanTimer = null;
                        }
                        setState(rec, 'running');
                        startExecTimer(rec);
                        resetSilenceTimer(rec);
                        if (!rec.userShown) {
                            rec.instance?.hide();
                            send(rec, { wtop: rec.negotiated, type: 'ui.visibility', sessionId: rec.sessionId, callId: rec.id, payload: { visible: false } });
                        }
                    }
                    return;
                }
                default:
                    return;
            }
        });
    };
    const startCall = (rec) => {
        const key = normalizeUrl(rec.toolUrl);
        const entry = registry.get(rec.toolUrl);
        rec.methodDef = entry?.manifest.methods.find((m) => m.name === rec.method) ?? null;
        rec.execRemaining = rec.timeoutMs ?? rec.methodDef?.timeoutMs ?? defaultTimeoutMs;
        const pooled = pool.get(key);
        const reusable = rec.methodDef?.mode === 'headless' && rec.methodDef?.stateless === true;
        if (pooled && reusable) {
            pool.delete(key);
            if (pooled.heartbeatTimer)
                clearInterval(pooled.heartbeatTimer);
            pooled.unsub();
            rec.instance = pooled.instance;
            rec.sessionId = pooled.sessionId;
            rec.negotiated = pooled.negotiated;
            setState(rec, 'ready');
            attachHandler(rec);
            sendInvoke(rec);
            return;
        }
        setState(rec, 'loading');
        try {
            rec.instance = factory({
                id: rec.id, toolUrl: rec.toolUrl,
                viewport: rec.viewport ?? entry?.manifest.viewport,
                allowSameOrigin: rec.allowSameOrigin,
            });
        }
        catch (e) {
            finalizeError(rec, new WtopError('HANDSHAKE_FAILED', `创建 iframe 失败: ${String(e)}`));
            return;
        }
        setState(rec, 'handshaking');
        attachHandler(rec);
        rec.handshakeTimer = setTimeout(() => {
            destroyInstance(rec);
            finalizeError(rec, new WtopError('HANDSHAKE_FAILED', `握手超时（${handshakeTimeoutMs}ms）`));
        }, handshakeTimeoutMs);
    };
    const makeCall = (rec) => ({
        id: rec.id,
        get state() { return rec.state; },
        get progress() { return rec.progress; },
        result: rec.result,
        onProgress(cb) { rec.progressCbs.add(cb); return () => rec.progressCbs.delete(cb); },
        onWaitingHuman(cb) { rec.waitingCbs.add(cb); return () => rec.waitingCbs.delete(cb); },
        onState(cb) { rec.stateCbs.add(cb); return () => rec.stateCbs.delete(cb); },
        cancel(reason = 'user') { cancelRec(rec, reason); },
    });
    const cancelRec = (rec, reason) => {
        if (rec.finalized)
            return;
        if (rec.sessionId && rec.instance) {
            send(rec, { wtop: rec.negotiated, type: 'cancel', sessionId: rec.sessionId, callId: rec.id, payload: { reason } });
        }
        const code = reason === 'timeout' ? 'TIMEOUT' :
            reason === 'human-timeout' ? 'HUMAN_TIMEOUT' :
                reason === 'crashed' ? 'TOOL_CRASHED' : 'CANCELLED';
        finalizeError(rec, new WtopError(code, `调用被取消（${reason}）`));
    };
    const host = {
        registry,
        execute(opts) {
            let resolve;
            let reject;
            const result = new Promise((res, rej) => { resolve = res; reject = rej; });
            const rec = {
                id: randomId(), toolUrl: normalizeUrl(opts.toolUrl), method: opts.method,
                params: opts.params, timeoutMs: opts.timeoutMs, attempt: opts.attempt ?? 0,
                allowSameOrigin: opts.allowSameOrigin, viewport: opts.viewport,
                preserveScene: opts.preserveScene ?? true,
                state: 'loading', instance: null, unsubTransport: null,
                sessionId: null, negotiated: PROTOCOL_VERSION, methodDef: null,
                resolve, reject, result,
                progress: {},
                progressCbs: new Set(opts.onProgress ? [opts.onProgress] : []),
                waitingCbs: new Set(opts.onWaitingHuman ? [opts.onWaitingHuman] : []),
                stateCbs: new Set(opts.onState ? [opts.onState] : []),
                handshakeTimer: null, execTimer: null, execRemaining: 0, execStartedAt: 0,
                humanTimer: null, silenceTimer: null, graceTimer: null, preserveTimer: null,
                forcedCode: null, finalized: false, userShown: false,
            };
            result.catch(() => { }); // 防止未订阅 result 时的 unhandled rejection
            recs.set(rec.id, rec);
            const fail = (err) => {
                rec.finalized = true;
                setState(rec, 'failed');
                rec.reject(err);
                recs.delete(rec.id);
            };
            let origin;
            try {
                origin = new URL(rec.toolUrl).origin;
            }
            catch {
                fail(new WtopError('HANDSHAKE_FAILED', `非法 toolUrl: ${opts.toolUrl}`));
                return makeCall(rec);
            }
            if (!allowedOrigins.includes(origin)) {
                fail(new WtopError('HANDSHAKE_FAILED', `origin 不在白名单: ${origin}`));
                return makeCall(rec);
            }
            try {
                assertParamsFiles(rec.params, largeFileThresholdBytes);
            }
            catch (e) {
                fail(e);
                return makeCall(rec);
            }
            if (activeCount() >= maxConcurrent) {
                queue.push(rec);
                emit('pool:queued', { callId: rec.id });
            }
            else {
                startCall(rec);
            }
            return makeCall(rec);
        },
        getCall(id) {
            const rec = recs.get(id);
            return rec ? makeCall(rec) : undefined;
        },
        show(id, rect) {
            const rec = recs.get(id);
            if (!rec?.instance)
                return;
            rec.userShown = true;
            rec.instance.show(rect);
            // 握手期 sessionId 尚空：先定位，visibility 待 ack 后补发
            if (rec.sessionId) {
                send(rec, { wtop: rec.negotiated, type: 'ui.visibility', sessionId: rec.sessionId, callId: rec.id, payload: { visible: true } });
            }
        },
        hide(id) {
            const rec = recs.get(id);
            if (!rec?.instance)
                return;
            rec.userShown = false;
            rec.instance.hide();
            if (rec.sessionId) {
                send(rec, { wtop: rec.negotiated, type: 'ui.visibility', sessionId: rec.sessionId, callId: rec.id, payload: { visible: false } });
            }
        },
        cancel(id, reason = 'user') {
            const rec = recs.get(id);
            if (rec)
                cancelRec(rec, reason);
        },
        on(event, cb) {
            if (!bus.has(event))
                bus.set(event, new Set());
            bus.get(event).add(cb);
            return () => bus.get(event).delete(cb);
        },
        dispose() {
            disposed = true;
            for (const rec of recs.values()) {
                clearTimers(rec);
                if (rec.preserveTimer)
                    clearTimeout(rec.preserveTimer);
                if (!rec.finalized) {
                    rec.finalized = true;
                    rec.reject(new WtopError('CANCELLED', 'host disposed'));
                }
                destroyInstance(rec);
            }
            recs.clear();
            queue.length = 0;
            for (const key of [...pool.keys()])
                dropPooled(key);
            layer?.dispose();
            bus.clear();
        },
    };
    registry.onChange(() => emit('registry:changed', undefined));
    void disposed;
    return host;
}
//# sourceMappingURL=host.js.map