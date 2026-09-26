// ─────────────────────────────────────────────────────────────────────────────
// 浏览器侧的联机客户端。
// 注意：浏览器不实现任何 MCP 协议，它只是通过 HTTP / WebSocket 与联机服务通信，
// 并且只会收到服务端投影后的 FieldView。
// ─────────────────────────────────────────────────────────────────────────────

import type { FieldAction, OperatorAction } from '../game/actions';
import type { Difficulty, GameState } from '../game/types';
import type { OperatorPresence, OperatorView } from '../game/views';

export type LinkStatus = 'offline' | 'connecting' | 'connected' | 'error';

export interface SyncPayload {
  runId: string;
  revision: number;
  roundId: string;
  paused: boolean;
  operator: OperatorPresence;
  state: GameState;
  /** 本连接的第一帧，用于重连时跳过历史音画，不属于世界状态。 */
  presentationBaseline?: boolean;
}

export interface ClientEvents {
  onSync: (payload: SyncPayload) => void;
  onPresence: (operator: OperatorPresence, paused: boolean) => void;
  onStatus: (status: LinkStatus, message?: string) => void;
}

const DEFAULT_BASE =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_GAME_SERVER ??
  `${location.protocol}//${location.hostname}:8787`;

export function defaultServerUrl(): string {
  try {
    return localStorage.getItem('shilian.server') || DEFAULT_BASE;
  } catch {
    return DEFAULT_BASE;
  }
}

export function rememberServerUrl(url: string) {
  try {
    localStorage.setItem('shilian.server', url);
  } catch {
    /* 忽略隐私模式下的存储失败 */
  }
}

export interface SavedSession {
  base: string;
  runId: string;
  token: string;
  at: number;
}
const SESSION_KEY = 'shilian.session';
export function saveSession(sess: SavedSession) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess));
  } catch {
    /* 忽略 */
  }
}
export function loadSession(): SavedSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as SavedSession) : null;
  } catch {
    return null;
  }
}
export function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* 忽略 */
  }
}

export class OnlineClient {
  base: string;
  runId = '';
  fieldToken = '';
  private roundId = '';
  private lastRevision = -1;
  private pendingField: { roundId: string; requestId: string; action: FieldAction } | null = null;
  private ws: WebSocket | null = null;
  private events: ClientEvents;
  private closedByUser = false;
  private retry = 0;
  private retryTimer: number | null = null;

  constructor(base: string, events: ClientEvents) {
    this.base = base.replace(/\/+$/, '');
    this.events = events;
  }

  private url(path: string) {
    return `${this.base}${path}`;
  }

  private async req(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
    const res = await fetch(this.url(path), {
      ...init,
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(this.fieldToken ? { 'X-Field-Token': this.fieldToken } : {}),
        ...(init?.headers ?? {}),
      },
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = new Error(String(data.error ?? `服务返回 ${res.status}`));
      (err as Error & { code?: number }).code = res.status;
      throw err;
    }
    return data;
    } finally { clearTimeout(timer); }
  }

  private rememberSnapshot(data: SyncPayload) {
    if (data.runId !== this.runId || data.revision < this.lastRevision) return;
    if (this.roundId && this.roundId !== data.roundId) this.pendingField = null;
    this.roundId = data.roundId;
    this.lastRevision = data.revision;
  }

  static async probe(base: string): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch(`${base.replace(/\/+$/, '')}/health`, { signal: ctrl.signal });
      return res.ok;
    } catch {
      return false;
    } finally { clearTimeout(timer); }
  }

  async createRun(seed: string, difficulty: Difficulty): Promise<SyncPayload> {
    this.events.onStatus('connecting');
    const saved = loadSession();
    const data = (await this.req('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ seed, difficulty, ...(saved?.base === this.base ? { replaceRunId: saved.runId, replaceToken: saved.token } : {}) }),
    })) as unknown as SyncPayload & { fieldToken: string };
    this.runId = data.runId;
    this.fieldToken = data.fieldToken;
    this.lastRevision = -1;
    this.rememberSnapshot(data);
    this.closedByUser = false;
    this.openSocket();
    return data;
  }

  async leaveRun() { await this.req(`/api/runs/${this.runId}/leave`, { method: 'POST', body: '{}' }); }

  async restartRun(seed: string, difficulty: Difficulty): Promise<SyncPayload> {
    const data = await this.req(`/api/runs/${this.runId}/restart`, {
      method: 'POST', body: JSON.stringify({ seed, difficulty }),
    }) as unknown as SyncPayload;
    this.rememberSnapshot(data);
    return data;
  }

  async joinRun(runId: string, fieldToken: string): Promise<SyncPayload> {
    this.events.onStatus('connecting');
    this.runId = runId.toUpperCase();
    this.fieldToken = fieldToken;
    const data = (await this.req(`/api/runs/${this.runId}/field`)) as unknown as SyncPayload;
    this.lastRevision = -1;
    this.rememberSnapshot(data);
    this.closedByUser = false;
    this.openSocket();
    return data;
  }

  private openSocket() {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
    const wsUrl =
      this.base.replace(/^http/, 'ws') + `/ws?run=${encodeURIComponent(this.runId)}&token=${encodeURIComponent(this.fieldToken)}`;
    const ws = new WebSocket(wsUrl);
    let awaitingFirstSnapshot = true;
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws || this.closedByUser) return;
      this.retry = 0;
      this.events.onStatus('connected');
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws || this.closedByUser) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (msg.type === 'sync') {
        this.rememberSnapshot(msg as unknown as SyncPayload);
        this.events.onSync({ ...(msg as unknown as SyncPayload), presentationBaseline: awaitingFirstSnapshot });
        awaitingFirstSnapshot = false;
      }
      else if (msg.type === 'presence')
        this.events.onPresence(msg.operator as OperatorPresence, !!msg.paused);
      else if (msg.type === 'error') this.events.onStatus('error', String(msg.message));
    };
    ws.onerror = () => { if (this.ws === ws && !this.closedByUser) this.events.onStatus('error', '与联机服务的连接出现异常。'); };
    ws.onclose = () => {
      if (this.closedByUser || this.ws !== ws) return;
      this.events.onStatus('error', '与联机服务的连接已断开，正在尝试重连…');
      this.scheduleRetry();
    };
  }

  /** 手动重连：只重开同步通道，不创建新对局、不丢失进度 */
  retryNow() {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        /* 忽略 */
      }
      this.ws = null;
    }
    this.events.onStatus('connecting');
    this.openSocket();
  }

  private scheduleRetry() {
    if (this.retryTimer !== null) return;
    const delay = Math.min(8000, 800 * 2 ** this.retry++);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (!this.closedByUser) this.openSocket();
    }, delay);
  }

  async fieldAction(
    action: FieldAction,
  ): Promise<{ ok: boolean; message: string; sync: SyncPayload | null }> {
    const recovering = this.pendingField !== null;
    const request = this.pendingField ?? { roundId: this.roundId, requestId: crypto.randomUUID(), action };
    this.pendingField = request;
    const submit = () => this.req(`/api/runs/${this.runId}/field/action`, { method: 'POST', body: JSON.stringify(request) });
    let response: Record<string, unknown>;
    try { response = await submit(); }
    catch (error) {
      if ((error as Error & { code?: number }).code) { this.pendingField = null; throw error; }
      response = await submit(); // 同编号重发，服务端只执行一次。
    }
    const data = response as unknown as { ok: boolean; message?: string } & SyncPayload;
    this.pendingField = null;
    if (data.state) this.rememberSnapshot(data);
    return {
      ok: !recovering && !!data.ok,
      message: recovering ? `上一次操作已核实${data.ok ? '执行完成' : '未执行'}。当前点击没有额外执行，请按最新画面重新选择。${data.message ?? ''}` : String(data.message ?? ''),
      sync: data.state ? (data as unknown as SyncPayload) : null,
    };
  }

  async setPaused(paused: boolean): Promise<SyncPayload | null> {
    const data = (await this.req(`/api/runs/${this.runId}/pause`, {
      method: 'POST',
      body: JSON.stringify({ paused }),
    })) as unknown as SyncPayload;
    return data.state ? data : null;
  }

  async claimSeat(take: boolean): Promise<{ sync: SyncPayload | null; operatorView?: OperatorView }> {
    const data = (await this.req(`/api/runs/${this.runId}/seat`, {
      method: 'POST',
      body: JSON.stringify({ take }),
    })) as unknown as SyncPayload & { operatorView?: OperatorView };
    return { sync: data.state ? data : null, operatorView: data.operatorView };
  }

  /** 兼任模式：直接下达一条结构化远程操作（MCP 在位时会被拒绝） */
  async operatorAction(action: OperatorAction): Promise<{
    ok: boolean;
    message: string;
    locked?: boolean;
    operatorView?: OperatorView;
    sync: SyncPayload | null;
  }> {
    try {
      const data = (await this.req(`/api/runs/${this.runId}/operator/action`, {
        method: 'POST',
        body: JSON.stringify({ action, roundId: this.roundId }),
      })) as unknown as { ok: boolean; message?: string; operatorView?: OperatorView } & SyncPayload;
      return {
        ok: !!data.ok,
        message: String(data.message ?? ''),
        operatorView: data.operatorView,
        sync: data.state ? (data as unknown as SyncPayload) : null,
      };
    } catch (e) {
      const err = e as Error & { code?: number };
      return { ok: false, message: err.message, locked: err.code === 423, sync: null };
    }
  }

  /** 任务结束后取回完整结算（此时服务端解除信息壁垒） */
  async debrief(): Promise<Record<string, unknown> | null> {
    try {
      const data = await this.req(`/api/runs/${this.runId}/debrief`);
      return (data.report as Record<string, unknown>) ?? null;
    } catch {
      return null;
    }
  }

  close() {
    this.closedByUser = true;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.ws?.close();
    this.ws = null;
    this.events.onStatus('offline');
  }
}
