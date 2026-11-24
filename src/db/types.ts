import type { JSONSchema, Manifest } from '@wtop/types';

export type ToolType = 'wtop' | 'http';
export type ToolHealth = 'ok' | 'degraded' | 'unreachable' | 'unknown';

export interface HttpEndpoint {
  name: string;
  displayName: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string; // 相对 base，可含 {{占位}}
  input: JSONSchema;
  output: JSONSchema;
  headers?: Record<string, string>; // 值可含 {{secret:name}}
  timeoutMs?: number;
}

export interface HttpToolDef { endpoints: HttpEndpoint[] }

export interface ToolRecord {
  id: string;
  type: ToolType;
  url: string;
  displayName: string;
  manifest?: Manifest;
  manifestHash?: string;
  version?: string;
  http?: HttpToolDef;
  health: ToolHealth;
  origins: string[];
  allowSameOrigin?: boolean;
  addedAt: number;
  updatedAt: number;
}

export interface FlowRecord {
  id: string;
  name: string;
  version: number;
  dsl: import('../features/engine/dsl').DSL;
  createdAt: number;
  updatedAt: number;
}

export type RunStatus = 'running' | 'paused-human' | 'succeeded' | 'failed' | 'cancelled';

export interface NodeState {
  status: 'pending' | 'ready' | 'running' | 'waiting-human' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
  percent?: number;
  text?: string;
  startedAt?: number;
  endedAt?: number;
  attempt: number;
  error?: { code: string; message: string };
  callId?: string;
  blobIds?: string[];
}

export interface LogEntry { at: number; nodeId?: string; level: 'debug' | 'info' | 'warn' | 'error'; message: string }

export interface RunRecord {
  id: string;
  flowId: string;
  flowVersion: number;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  nodeStates: Record<string, NodeState>;
  contextMeta: unknown;
  output?: unknown;
  error?: { nodeId: string; code: string; message: string };
  logs: LogEntry[];
}

export interface BlobRecord {
  id: string;
  runId: string;
  nodeId: string;
  name: string;
  mime: string;
  size: number;
  data: Blob;
}

export interface SettingRecord { key: string; value: unknown }
export interface SecretRecord { id: string; toolId: string; name: string; value: string }

export interface AppSettings {
  maxConcurrent: number;
  httpConcurrency: number;
  defaultTimeoutMs: number;
  humanTimeoutMs: number;
  preserveFailedMs: number;
  retentionRuns: number;
  retentionDays: number;
  env: Record<string, string>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  maxConcurrent: 8,
  httpConcurrency: 6,
  defaultTimeoutMs: 60000,
  humanTimeoutMs: 30 * 60000,
  preserveFailedMs: 120000,
  retentionRuns: 100,
  retentionDays: 30,
  env: {},
};