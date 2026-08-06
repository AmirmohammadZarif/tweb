import {AppManager} from '@appManagers/manager';
import {getDatabaseState} from '@config/databases/state';
import AppStorage from '@lib/storage';
import {
  CRM_API_PREFIX,
  CRM_CONFIG_STORAGE_KEY,
  CRM_ENDPOINTS,
  CrmAttributionMap,
  CrmConfig,
  CrmCreateTaskInput,
  CrmProject,
  CrmRealtimeConfig,
  CrmTask,
  CrmTaskQuery,
  CrmTaskStatus,
  CrmTicketListItem,
  CrmTicketListResult,
  CrmReverbConfig,
  CrmCustomer,
  CrmFaq,
  CrmNote,
  CrmNotesResult,
  CrmTemplate,
  CrmTemplateImage,
  CrmTicketLookupResult,
  CrmTicketRef,
  CrmTicketStatus,
  CrmUser,
  CrmSensitiveRevealState,
  CrmClientLogPayload,
  CrmClientLogResult,
  EMPTY_CRM_CONFIG
} from '@lib/crm/types';

export default class AppCrmManager extends AppManager {
  private storage: AppStorage<Record<string, CrmConfig>, ReturnType<typeof getDatabaseState>>;
  private config: CrmConfig;
  private loadPromise: Promise<void>;
  private openTicketPeerIds: PeerId[] = [];
  private ticketByPeerId = new Map<PeerId, CrmTicketRef>();
  private openTicketsFetchedAt = 0;

  protected after() {
    this.name = 'CRM';
    this.storage = new AppStorage(getDatabaseState(this.getAccountNumber()), 'session');
    this.config = {...EMPTY_CRM_CONFIG};

    this.loadPromise = this.load();
    // Refresh the agent's profile (incl. is_super_admin) once per app start so
    // a role change in the CRM propagates without re-login. Fire-and-forget —
    // gated UI simply stays hidden until the flag lands.
    this.loadPromise.then(() => this.refreshMe());
    return this.loadPromise;
  }

  private async load() {
    const stored = await this.storage.get(CRM_CONFIG_STORAGE_KEY);
    if(stored) {
      this.config = {...EMPTY_CRM_CONFIG, ...stored};
      // An older stored config may carry an empty baseUrl; fall back to the
      // production default so agents never face a blank field.
      if(!this.config.baseUrl) this.config.baseUrl = EMPTY_CRM_CONFIG.baseUrl;
    }
  }

  private async persist() {
    await this.storage.set({[CRM_CONFIG_STORAGE_KEY]: this.config});
    this.rootScope.dispatchEvent('crm_config_update');
  }

  public async getConfig(): Promise<CrmConfig> {
    await this.loadPromise;
    return {...this.config};
  }

  public async setConfig(config: Partial<Pick<CrmConfig, 'enabled' | 'baseUrl'>>): Promise<void> {
    await this.loadPromise;
    this.config = {
      ...this.config,
      ...config,
      baseUrl: (config.baseUrl ?? this.config.baseUrl).trim().replace(/\/+$/, '')
    };
    await this.persist();
  }

  public async isConnected(): Promise<boolean> {
    await this.loadPromise;
    return this.config.enabled && !!this.config.baseUrl && !!this.config.token;
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────
  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    options: {body?: object, query?: Record<string, string | number>, auth?: boolean} = {}
  ): Promise<T> {
    await this.loadPromise;

    if(!this.config.baseUrl) throw new Error('CRM_NO_BASE_URL');
    if(options.auth !== false && !this.config.token) throw new Error('CRM_NO_TOKEN');

    let url = this.config.baseUrl + CRM_API_PREFIX + path;
    if(options.query) {
      const params = new URLSearchParams();
      for(const key in options.query) {
        if(options.query[key] != null) params.set(key, '' + options.query[key]);
      }
      const qs = params.toString();
      if(qs) url += '?' + qs;
    }

    const headers: Record<string, string> = {
      'Accept': 'application/json'
    };
    if(options.body) headers['Content-Type'] = 'application/json';
    if(options.auth !== false) headers['Authorization'] = 'Bearer ' + this.config.token;

    const response = await fetch(url, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if(!response.ok) {
      let serverMessage: string;
      try {
        const body = await response.json();
        serverMessage = body?.message;
      } catch{}
      const error = new Error(serverMessage || ('CRM_HTTP_' + response.status)) as Error & {status: number, serverMessage?: string};
      error.status = response.status;
      error.serverMessage = serverMessage;
      if(response.status === 401) {
        this.config.token = '';
        this.config.user = undefined;
        this.config.enabled = false;
        this.persist();
        this.rootScope.dispatchEvent('crm_auth_required');
      }
      throw error;
    }

    if(response.status === 204) return undefined;
    return response.json();
  }

  private unwrap<T>(payload: {data?: T}): T {
    return (payload?.data ?? []) as T;
  }

  // ── Auth (per-agent OTP → Sanctum token) ──────────────────────────────────
  public async sendOtp(mobile: string): Promise<void> {
    await this.request('POST', CRM_ENDPOINTS.sendOtp, {body: {mobile: mobile.trim()}, auth: false});
  }

  public async verifyOtp(mobile: string, code: string): Promise<CrmUser> {
    const result = await this.request<{token: string, user: CrmUser}>('POST', CRM_ENDPOINTS.verifyOtp, {
      auth: false,
      body: {mobile: mobile.trim(), code: code.trim(), device_name: 'Telegram Web (tweb)'}
    });

    this.config.token = result.token;
    this.config.user = result.user;
    this.config.enabled = true;
    await this.persist();
    // verify-otp's payload has no is_super_admin — pull the full profile so
    // role-gated UI unlocks right after login, not on the next app start.
    return (await this.refreshMe()) || result.user;
  }

  public async me(): Promise<CrmUser> {
    return this.request<CrmUser>('GET', CRM_ENDPOINTS.me);
  }

  // Synchronous session/role checks for worker-side hot paths (dialog
  // filtering) that can't await. They read the in-memory config: false until
  // load() settles, which fails safe — gated content stays hidden. In practice
  // they're accurate from the first manager call, because createManagers awaits
  // every after() (and thus load()) before serving anything.
  public isLoggedInCached(): boolean {
    return !!(this.config?.enabled && this.config.baseUrl && this.config.token);
  }

  public isSuperAdminCached(): boolean {
    return this.isLoggedInCached() && !!this.config.user?.is_super_admin;
  }

  // Re-fetch /auth/me and merge into the stored user. persist() dispatches
  // crm_config_update, which is what the main-thread role store listens for.
  public async refreshMe(): Promise<CrmUser | undefined> {
    if(!(await this.isConnected())) return undefined;
    try {
      const user = await this.me();
      this.config.user = {...this.config.user, ...user};
      // Refresh the global reveal-approval setting from the public /config in the
      // same app-start pass. Default true (fail-safe) if the fetch/field is absent.
      try {
        const mobileConfig = await this.request<{data?: {sensitive_reveal_require_approval?: boolean}}>('GET', CRM_ENDPOINTS.config, {auth: false});
        this.config.requireSensitiveApproval = mobileConfig?.data?.sensitive_reveal_require_approval ?? true;
      } catch(configErr) {
        this.log.error('refreshMe config fetch failed', configErr);
      }
      await this.persist();
      return this.config.user;
    } catch(err) {
      this.log.error('refreshMe failed', err);
      return this.config.user;
    }
  }

  // Params for the main-thread Reverb client (realtime attribution). Bundles the
  // public Reverb endpoint (from the public /config) with this agent's base url +
  // bearer token so the client can run the /broadcasting/auth handshake. The token
  // is already a client-side credential, so handing it to the UI thread is fine.
  public async getRealtimeConfig(): Promise<CrmRealtimeConfig | undefined> {
    if(!(await this.isConnected())) return undefined;
    try {
      const result = await this.request<{data: {reverb?: CrmReverbConfig}}>('GET', CRM_ENDPOINTS.config, {auth: false});
      const reverb = result?.data?.reverb;
      if(!reverb?.key || !reverb?.host) return undefined;
      return {baseUrl: this.config.baseUrl, token: this.config.token, reverb};
    } catch(err) {
      this.log.error('getRealtimeConfig failed', err);
      return undefined;
    }
  }

  public async disconnect(): Promise<void> {
    await this.loadPromise;
    if(this.config.token) {
      try {
        await this.request('DELETE', CRM_ENDPOINTS.logout);
      } catch{}
    }
    this.config.token = '';
    this.config.user = undefined;
    this.config.enabled = false;
    await this.persist();
  }

  // ── 1) FAQ / canned answers ───────────────────────────────────────────────
  public async getTemplates(): Promise<CrmTemplate[]> {
    if(!(await this.isConnected())) return [];
    try {
      return this.unwrap(await this.request<{data: CrmTemplate[]}>('GET', CRM_ENDPOINTS.templates));
    } catch(err) {
      this.log.error('getTemplates failed', err);
      return [];
    }
  }

  public async getFaqs(departmentId?: number): Promise<CrmFaq[]> {
    if(!(await this.isConnected())) return [];
    try {
      return this.unwrap(await this.request<{data: CrmFaq[]}>('GET', CRM_ENDPOINTS.faqs, {
        query: departmentId ? {department_id: '' + departmentId} : undefined
      }));
    } catch(err) {
      this.log.error('getFaqs failed', err);
      return [];
    }
  }

  // The bytes of a template's attached images (base64 data URIs), fetched lazily
  // when an image-bearing template is picked so they can be staged in the
  // send-preview. Served under api/mobile to avoid the cross-origin /storage CORS wall.
  public async getTemplateImages(templateId: number): Promise<CrmTemplateImage[]> {
    if(!(await this.isConnected())) return [];
    try {
      return this.unwrap(await this.request<{data: CrmTemplateImage[]}>('GET', CRM_ENDPOINTS.templateImages(templateId)));
    } catch(err) {
      this.log.error('getTemplateImages failed', err);
      return [];
    }
  }

  // ── 3) Customer context ───────────────────────────────────────────────────
  public async searchCustomers(q: string): Promise<CrmCustomer[]> {
    if(!(await this.isConnected()) || (q || '').trim().length < 2) return [];
    try {
      return this.unwrap(await this.request<{data: CrmCustomer[]}>('GET', CRM_ENDPOINTS.customersSearch, {
        query: {q: q.trim()}
      }));
    } catch(err) {
      this.log.error('searchCustomers failed', err);
      return [];
    }
  }

  // ── Ticket lifecycle (open/close) for the chat's customer ─────────────────
  private rememberTicket(chatId: string, ticket?: CrmTicketRef) {
    if(!chatId) return;
    const peerId = (+chatId).toPeerId();
    if(ticket) {
      this.ticketByPeerId.set(peerId, ticket);
    } else {
      this.ticketByPeerId.delete(peerId);
      this.openTicketPeerIds = this.openTicketPeerIds.filter((id) => id !== peerId);
    }
  }

  private setOpenTicketList(tickets: CrmTicketListItem[]) {
    const peerIds: PeerId[] = [];
    for(const item of tickets) {
      const chatId = item.customer?.telegram_chat_id;
      if(!chatId) continue;
      const peerId = (+chatId).toPeerId();
      peerIds.push(peerId);
      this.ticketByPeerId.set(peerId, {id: item.id, status: item.status, events: item.events});
    }

    for(const peerId of this.openTicketPeerIds) {
      const cached = this.ticketByPeerId.get(peerId);
      if(cached?.status === 'open' && !peerIds.includes(peerId)) {
        this.ticketByPeerId.delete(peerId);
      }
    }

    this.openTicketPeerIds = peerIds;
    this.openTicketsFetchedAt = Date.now();
    this.rootScope.dispatchEvent('crm_open_tickets_update', {peerIds});
  }

  public getTicketStatusCached(peerId: PeerId): CrmTicketStatus | undefined {
    return this.ticketByPeerId.get(peerId)?.status;
  }

  public hasOpenTicketForPeer(peerId: PeerId): boolean {
    return this.ticketByPeerId.get(peerId)?.status === 'open';
  }

  public async getOpenTicketPeerIds(force = false): Promise<PeerId[]> {
    if(!(await this.isConnected())) return [];
    if(!force && Date.now() - this.openTicketsFetchedAt < 30000) {
      return this.openTicketPeerIds;
    }

    try {
      const tickets: CrmTicketListItem[] = [];
      let page = 1;
      let lastPage = 1;
      do {
        const result = await this.request<CrmTicketListResult>('GET', CRM_ENDPOINTS.tickets, {
          query: {status: 'open', page}
        });
        tickets.push(...(result?.data || []));
        lastPage = result?.last_page || 1;
        page++;
      } while(page <= lastPage);

      this.setOpenTicketList(tickets);
      return this.openTicketPeerIds;
    } catch(err) {
      this.log.error('getOpenTicketPeerIds failed', err);
      return this.openTicketPeerIds;
    }
  }

  public async getTicketByTelegram(chatId: string): Promise<CrmTicketLookupResult> {
    if(!(await this.isConnected()) || !chatId) return {failed: true};
    try {
      const result = await this.request<{ticket: CrmTicketRef | null}>('GET', `${CRM_ENDPOINTS.tickets}/by-telegram/${encodeURIComponent(chatId)}`);
      this.rememberTicket(chatId, result?.ticket || undefined);
      if(!result?.ticket) return {noTicket: true};
      return {ticket: result.ticket};
    } catch(err) {
      this.log.error('getTicketByTelegram failed', err);
      return {failed: true, httpStatus: (err as Error & {status?: number})?.status};
    }
  }

  // Claim the customer's latest open ticket for THIS agent. Agents share one
  // department Telegram account, so the userbot can't tell them apart — but each
  // agent has their own CRM token, and that token is what authenticates this call.
  // The CRM binds the ticket to this agent (assigned_admin_id), which is what
  // outbound-message attribution and per-agent reports key off. Fire-and-forget.
  public async claimTicketByTelegram(chatId: string): Promise<void> {
    if(!(await this.isConnected()) || !chatId) return;
    try {
      await this.request('POST', `${CRM_ENDPOINTS.tickets}/by-telegram/${encodeURIComponent(chatId)}/claim`);
    } catch(err) {
      this.log.error('claimTicketByTelegram failed', err);
    }
  }

  // Stamp a single outbound message with THIS agent. The agent's CRM token (this
  // request's auth) identifies them; the Telegram message id ties it to the message
  // the CRM's userbot independently ingests — so attribution is exact per message,
  // even when several agents share the department Telegram session. Fire-and-forget.
  public async attributeOutboundMessage(chatId: string, messageId: number): Promise<void> {
    if(!(await this.isConnected()) || !chatId || !messageId) return;
    try {
      await this.request('POST', `${CRM_ENDPOINTS.tickets}/by-telegram/${encodeURIComponent(chatId)}/attribute`, {
        body: {message_id: messageId}
      });
    } catch(err) {
      this.log.error('attributeOutboundMessage failed', err);
    }
  }

  // Per-message author map for a chat: {<telegram message id>: {admin_id, name}}.
  // Backfills which agent sent each outbound message so EVERY session — not just
  // the sender's — can label the bubbles. Pairs with the realtime broadcast for
  // live messages; this REST call covers history on chat open. Empty on failure
  // so the caller can render unlabeled rather than break.
  public async getAttributionsByTelegram(chatId: string): Promise<CrmAttributionMap> {
    if(!(await this.isConnected()) || !chatId) return {};
    try {
      const result = await this.request<{data: CrmAttributionMap}>('GET', `${CRM_ENDPOINTS.tickets}/by-telegram/${encodeURIComponent(chatId)}/attributions`);
      return result?.data || {};
    } catch(err) {
      this.log.error('getAttributionsByTelegram failed', err);
      return {};
    }
  }

  // ── Sensitive-message reveal workflow ─────────────────────────────────────
  // Which sensitive messages THIS agent may see in the clear, plus (for
  // superadmins) the outstanding requests. Backfills on chat open, paired with
  // the Reverb push for liveness. Empty on failure → everything stays blurred,
  // which fails safe. Fire-and-forget from the chat-open path (non-blocking).
  public async getSensitiveReveals(chatId: string): Promise<CrmSensitiveRevealState> {
    const empty: CrmSensitiveRevealState = {approved: [], pending: []};
    if(!(await this.isConnected()) || !chatId) return empty;
    try {
      const result = await this.request<{data: CrmSensitiveRevealState}>('GET', CRM_ENDPOINTS.sensitiveReveals(chatId));
      return {approved: result?.data?.approved || [], pending: result?.data?.pending || []};
    } catch(err) {
      this.log.error('getSensitiveReveals failed', err);
      return empty;
    }
  }

  // A regular agent asks to reveal one message's hidden spans (messageId 0 =
  // contact info). With approval ON the CRM records a pending request + notifies
  // superadmins → returns 'pending'. With approval OFF the agent self-reveals
  // with a logged `reason` → returns 'approved' (reveal right away). Returns
  // false on failure. `messageId` may be 0, so no truthiness check on it.
  public async requestSensitiveReveal(chatId: string, messageId: number, reason?: string, content?: string): Promise<'pending' | 'approved' | 'rate_limited' | false> {
    if(!(await this.isConnected()) || !chatId || messageId == null) return false;
    try {
      const result = await this.request<{status?: 'pending' | 'approved'}>('POST', CRM_ENDPOINTS.sensitiveRevealRequest(chatId), {
        body: {message_id: messageId, ...(reason ? {reason} : {}), ...(content ? {content} : {})}
      });
      return result?.status || 'pending';
    } catch(err) {
      // 429 = per-agent daily self-reveal cap reached (see the reveal settings).
      if((err as Error & {status?: number})?.status === 429) return 'rate_limited';
      this.log.error('requestSensitiveReveal failed', err);
      return false;
    }
  }

  // A superadmin approves a reveal for a specific agent (CRM user id). The CRM
  // broadcasts `sensitive.reveal.approved` so that agent's session reveals it.
  public async approveSensitiveReveal(chatId: string, messageId: number, userId: number): Promise<boolean> {
    if(!(await this.isConnected()) || !chatId || !messageId) return false;
    try {
      await this.request('POST', CRM_ENDPOINTS.sensitiveRevealApprove(chatId), {body: {message_id: messageId, user_id: userId}});
      return true;
    } catch(err) {
      this.log.error('approveSensitiveReveal failed', err);
      return false;
    }
  }

  // ── 4) Records: act on an existing ticket ─────────────────────────────────
  public async sendTicketMessage(ticketId: number, text: string) {
    return this.request('POST', `${CRM_ENDPOINTS.tickets}/${ticketId}/message`, {body: {text}});
  }

  public async addTicketNote(ticketId: number, text: string) {
    return this.request('POST', `${CRM_ENDPOINTS.tickets}/${ticketId}/note`, {body: {text}});
  }

  public async updateTicketStatus(ticketId: number, status: CrmTicketStatus) {
    const result = await this.request('PATCH', `${CRM_ENDPOINTS.tickets}/${ticketId}/status`, {body: {status}});
    this.getOpenTicketPeerIds(true);
    return result;
  }

  // ── Internal agent notes (keyed by telegram chat id) ──────────────────────
  // Notes let agents hand context to each other from inside the chat; they are
  // agent-only and never reach the customer. Both endpoints resolve the chat's
  // ticket server-side, so the UI works with chat ids only.
  public async getNotesByTelegram(chatId: string): Promise<CrmNotesResult> {
    if(!(await this.isConnected()) || !chatId) return {ticketId: null, notes: []};
    try {
      const result = await this.request<{data: {ticket_id: number | null, notes: CrmNote[]}}>('GET', CRM_ENDPOINTS.notes(chatId));
      return {ticketId: result?.data?.ticket_id ?? null, notes: result?.data?.notes || []};
    } catch(err) {
      this.log.error('getNotesByTelegram failed', err);
      return {ticketId: null, notes: []};
    }
  }

  // Add an internal note to the chat's ticket. Returns the created note (so the UI
  // can append it optimistically) or undefined on failure — the caller surfaces a
  // toast. Rethrows nothing; a 404 (no ticket) resolves to undefined.
  public async addNoteByTelegram(chatId: string, text: string): Promise<CrmNote | undefined> {
    if(!(await this.isConnected()) || !chatId || !text.trim()) return undefined;
    const result = await this.request<{data: CrmNote}>('POST', CRM_ENDPOINTS.addNote(chatId), {body: {text: text.trim()}});
    return result?.data;
  }

  // ── Project tasks ─────────────────────────────────────────────────────────
  // Reads degrade to empty so the panel renders rather than blanking on a CRM
  // hiccup. Writes deliberately propagate: they are user-initiated, and silently
  // dropping "I just logged 30 minutes" would be worse than an error toast.

  public async getProjects(): Promise<CrmProject[]> {
    if(!(await this.isConnected())) return [];
    try {
      return this.unwrap(await this.request<{data: CrmProject[]}>('GET', CRM_ENDPOINTS.projects));
    } catch(err) {
      this.log.error('getProjects failed', err);
      return [];
    }
  }

  public async getMyTasks(query: CrmTaskQuery = {}): Promise<CrmTask[]> {
    if(!(await this.isConnected())) return [];

    const params: Record<string, string> = {};
    if(query.projectId) params.project_id = '' + query.projectId;
    if(query.includeDone) params.include_done = '1';
    if(query.status?.length) params.status = query.status.join(',');

    try {
      return this.unwrap(await this.request<{data: CrmTask[]}>('GET', CRM_ENDPOINTS.tasks, {
        query: Object.keys(params).length ? params : undefined
      }));
    } catch(err) {
      this.log.error('getMyTasks failed', err);
      return [];
    }
  }

  public async createTask(input: CrmCreateTaskInput): Promise<CrmTask | undefined> {
    if(!(await this.isConnected()) || !input.title.trim()) return undefined;
    const result = await this.request<{data: CrmTask}>('POST', CRM_ENDPOINTS.tasks, {
      body: {...input, title: input.title.trim()}
    });
    return result?.data;
  }

  public async setTaskStatus(taskId: number, status: CrmTaskStatus): Promise<CrmTask | undefined> {
    if(!(await this.isConnected())) return undefined;
    const result = await this.request<{data: CrmTask}>('PATCH', CRM_ENDPOINTS.taskStatus(taskId), {body: {status}});
    return result?.data;
  }

  public async logTaskTime(taskId: number, minutes: number, note?: string): Promise<CrmTask | undefined> {
    if(!(await this.isConnected()) || !(minutes > 0)) return undefined;
    const result = await this.request<{data: CrmTask}>('POST', CRM_ENDPOINTS.taskTime(taskId), {
      body: {minutes, note: note?.trim() || undefined}
    });
    return result?.data;
  }

  public async setTaskEstimate(taskId: number, minutes: number, note?: string): Promise<CrmTask | undefined> {
    if(!(await this.isConnected()) || !(minutes > 0)) return undefined;
    const result = await this.request<{data: CrmTask}>('POST', CRM_ENDPOINTS.taskEstimate(taskId), {
      body: {estimated_minutes: minutes, note: note?.trim() || undefined}
    });
    return result?.data;
  }

  // ── Crash reports ─────────────────────────────────────────────────────────

  /**
   * Upload a crash report (error + merged log tail) — see @lib/debug/crashReporter,
   * which is the only caller and does the collecting/scrubbing on the main thread.
   *
   * Never throws and never surfaces anything to the agent: a failed crash upload
   * must not itself produce an error toast, and above all must not re-enter the
   * global error handler that triggered it.
   */
  public async postClientLogs(payload: CrmClientLogPayload): Promise<CrmClientLogResult | undefined> {
    if(!(await this.isConnected())) return undefined;
    try {
      const result = await this.request<{data: CrmClientLogResult}>('POST', CRM_ENDPOINTS.clientLogs, {body: payload});
      return result?.data;
    } catch{
      return undefined;
    }
  }
}
