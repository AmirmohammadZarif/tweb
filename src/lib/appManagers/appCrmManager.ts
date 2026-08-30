import {AppManager} from '@appManagers/manager';
import {getDatabaseState} from '@config/databases/state';
import ctx from '@environment/ctx';
import AppStorage from '@lib/storage';
import {
  CRM_API_PREFIX,
  CRM_CONFIG_STORAGE_KEY,
  CRM_ENDPOINTS,
  CrmAttributionMap,
  CrmConfig,
  CrmFirstSeenMap,
  CrmFirstSeenSummary,
  CrmFirstSeenSummaryEntry,
  CrmAiDraft,
  CrmCreateTaskInput,
  CrmProject,
  CrmProjectMember,
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

/**
 * The folder needs EVERY open ticket in the department to build its peer list, so
 * it walks the pagination — ask for big pages to keep that walk short. A busy
 * department runs into the hundreds (monetize was 436), which is 11 sequential
 * round-trips at the CRM's default 40 and only 3 at 200. 200 is the server's clamp.
 */
const OPEN_TICKETS_PAGE_SIZE = 200;
/**
 * Hard stop on that walk, so a CRM that ignores `per_page` (or scoping that fails
 * open) can't turn one folder refresh into an unbounded request storm. Generous
 * enough to cover any real department at the page size above.
 */
const MAX_OPEN_TICKET_PAGES = 15;

/**
 * Chat-list first-seen labels: how long a peer's cached entry is trusted before
 * the next request re-fetches it, and how long requests are pooled so a scrolling
 * chatlist produces one call instead of one per row. MAX_FIRST_SEEN_CHAT_IDS
 * mirrors the CRM's own cap on the summary endpoint.
 */
const FIRST_SEEN_TTL = 60000;
const FIRST_SEEN_BATCH_MS = 200;
const MAX_FIRST_SEEN_CHAT_IDS = 300;

export default class AppCrmManager extends AppManager {
  private storage: AppStorage<Record<string, CrmConfig>, ReturnType<typeof getDatabaseState>>;
  private config: CrmConfig;
  private loadPromise: Promise<void>;
  private openTicketPeerIds: PeerId[] = [];
  private ticketByPeerId = new Map<PeerId, CrmTicketRef>();
  private openTicketsFetchedAt = 0;
  // Chat-list first-seen: the newest labeled message per peer, plus when we last
  // asked for it and which peers are waiting for the next pooled request.
  private firstSeenByPeerId = new Map<PeerId, CrmFirstSeenSummaryEntry>();
  private firstSeenFetchedAt = new Map<PeerId, number>();
  private pendingFirstSeenPeerIds = new Set<PeerId>();
  private firstSeenBatchTimeout: number;

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

  /**
   * The Telegram account this session is signed in as — for an agent, their
   * DEPARTMENT's shared account.
   *
   * Every chat-keyed CRM call carries it, because a Telegram chat id does not name
   * a conversation on its own: one customer can hold an open ticket with Financial
   * and another with Monetization at the same time, over two different department
   * accounts, and those two conversations share the customer's chat id. Without
   * this the CRM would answer with whichever department's ticket, notes and agent
   * labels it happened to find first — including ones this agent has no access to.
   */
  private sessionTelegramUserId(): string {
    return '' + this.appPeersManager.peerId.toUserId();
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

  /**
   * Onboarding trainee (read-only CRM role): every outgoing action is refused.
   *
   * Checked inside the managers that actually talk to Telegram — sending,
   * editing, deleting, reacting — rather than only in the UI, so a path that
   * forgets to hide its button still cannot write. The CRM refuses its own writes
   * separately (EnsureMobileWriteAllowed); this covers the Telegram side, which
   * never passes through the CRM at all.
   */
  public isReadOnlyCached(): boolean {
    return this.isLoggedInCached() && !!this.config.user?.is_read_only;
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
    // One entry per TICKET, so a customer with two open tickets appears twice —
    // dedupe to peers or the folder badge overcounts and the list renders the
    // same chat more than once.
    const seen = new Set<PeerId>();
    const peerIds: PeerId[] = [];
    for(const item of tickets) {
      const chatId = item.customer?.telegram_chat_id;
      if(!chatId) continue;
      const peerId = (+chatId).toPeerId();
      if(!seen.has(peerId)) {
        seen.add(peerId);
        peerIds.push(peerId);
      }

      this.ticketByPeerId.set(peerId, {id: item.id, status: item.status, events: item.events});
    }

    for(const peerId of this.openTicketPeerIds) {
      const cached = this.ticketByPeerId.get(peerId);
      if(cached?.status === 'open' && !seen.has(peerId)) {
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

    // Scope to the department owning THIS Telegram session (see
    // sessionTelegramUserId) — unscoped, a superadmin token returns every open
    // ticket in the CRM, which is neither what the folder means nor something
    // worth paging through.
    const sessionTelegramUserId = this.sessionTelegramUserId();

    try {
      const tickets: CrmTicketListItem[] = [];
      let page = 1;
      let lastPage = 1;
      do {
        const result = await this.request<CrmTicketListResult>('GET', CRM_ENDPOINTS.tickets, {
          query: {
            status: 'open',
            page,
            per_page: OPEN_TICKETS_PAGE_SIZE,
            session_telegram_user_id: sessionTelegramUserId
          }
        });
        if(page === 1 && result) {
          if(!('department_id' in result)) {
            // Pre-scoping CRM: it ignores the query param, so we get the whole
            // backlog exactly as before. Harmless, but worth saying out loud.
            this.log.warn('CRM does not support department scoping yet; open tickets are unscoped');
          } else if(result.department_id === null) {
            // Scoping resolved to nothing and the CRM fails closed, so the folder
            // will be empty — indistinguishable from "no open tickets" without this.
            this.log.warn(
              'no CRM department is mapped to this Telegram session; the open-tickets folder will be empty',
              {sessionTelegramUserId}
            );
          }
        }

        tickets.push(...(result?.data || []));
        lastPage = result?.last_page || 1;
        page++;
      } while(page <= lastPage && page <= MAX_OPEN_TICKET_PAGES);

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
      const result = await this.request<{ticket: CrmTicketRef | null}>('GET', `${CRM_ENDPOINTS.tickets}/by-telegram/${encodeURIComponent(chatId)}`, {
        query: {session_telegram_user_id: this.sessionTelegramUserId()}
      });
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
      await this.request('POST', `${CRM_ENDPOINTS.tickets}/by-telegram/${encodeURIComponent(chatId)}/claim`, {
        body: {session_telegram_user_id: this.sessionTelegramUserId()}
      });
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
        body: {message_id: messageId, session_telegram_user_id: this.sessionTelegramUserId()}
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
      const result = await this.request<{data: CrmAttributionMap}>('GET', `${CRM_ENDPOINTS.tickets}/by-telegram/${encodeURIComponent(chatId)}/attributions`, {
        query: {session_telegram_user_id: this.sessionTelegramUserId()}
      });
      return result?.data || {};
    } catch(err) {
      this.log.error('getAttributionsByTelegram failed', err);
      return {};
    }
  }

  // ── Inbound first-seen ("who picked this conversation up") ────────────────
  // Reads are anonymous on a shared department account: the first agent to open
  // the chat marks everything read for all of them. So each session reports the
  // messages IT actually displayed as unread, and the CRM keeps the first report
  // per message. See @lib/crm/types → CrmFirstSeen.

  /**
   * Report messages this session was the first to display as unread. The CRM
   * ignores ids another agent already claimed, and answers with the resulting
   * map for every id — so the caller labels bubbles with the truth rather than
   * with its own guess. Empty on failure (bubbles stay unlabeled).
   */
  public async reportMessagesSeen(chatId: string, messageIds: number[]): Promise<CrmFirstSeenMap> {
    if(!(await this.isConnected()) || !chatId || !messageIds?.length) return {};
    try {
      const result = await this.request<{data: CrmFirstSeenMap}>('POST', CRM_ENDPOINTS.markSeen(chatId), {
        body: {message_ids: messageIds, session_telegram_user_id: this.sessionTelegramUserId()}
      });
      const map = result?.data || {};
      this.rememberFirstSeen(chatId, map);
      return map;
    } catch(err) {
      this.log.error('reportMessagesSeen failed', err);
      return {};
    }
  }

  /** Per-message first-viewer map for a chat — backfills history on chat open. */
  public async getFirstSeenByTelegram(chatId: string): Promise<CrmFirstSeenMap> {
    if(!(await this.isConnected()) || !chatId) return {};
    try {
      const result = await this.request<{data: CrmFirstSeenMap}>('GET', CRM_ENDPOINTS.firstSeen(chatId), {
        query: {session_telegram_user_id: this.sessionTelegramUserId()}
      });
      const map = result?.data || {};
      this.rememberFirstSeen(chatId, map);
      return map;
    } catch(err) {
      this.log.error('getFirstSeenByTelegram failed', err);
      return {};
    }
  }

  /**
   * The chat-list label for a peer, or undefined when nobody has been recorded
   * yet. Synchronous by design: dialog rows render from cache and refresh off
   * `crm_first_seen_summary_update` — see requestFirstSeenForPeers.
   */
  public getFirstSeenCached(peerId: PeerId): CrmFirstSeenSummaryEntry | undefined {
    return this.firstSeenByPeerId.get(peerId);
  }

  /**
   * Ask for the chat-list labels of these peers. Called per dialog row, so it
   * pools requests over FIRST_SEEN_BATCH_MS and skips peers refreshed within
   * FIRST_SEEN_TTL — a scrolling chatlist costs one request per batch, not one
   * per row. Fire-and-forget: the result lands as `crm_first_seen_summary_update`.
   */
  public async requestFirstSeenForPeers(peerIds: PeerId[], force = false): Promise<void> {
    if(!(await this.isConnected()) || !peerIds?.length) return;

    const now = Date.now();
    for(const peerId of peerIds) {
      if(!peerId?.isUser()) continue;
      const fetchedAt = this.firstSeenFetchedAt.get(peerId);
      if(!force && fetchedAt && now - fetchedAt < FIRST_SEEN_TTL) continue;
      this.pendingFirstSeenPeerIds.add(peerId);
    }

    if(!this.pendingFirstSeenPeerIds.size || this.firstSeenBatchTimeout) return;
    this.firstSeenBatchTimeout = ctx.setTimeout(() => {
      this.firstSeenBatchTimeout = undefined;
      this.flushFirstSeenBatch();
    }, FIRST_SEEN_BATCH_MS);
  }

  private async flushFirstSeenBatch() {
    const peerIds = Array.from(this.pendingFirstSeenPeerIds).slice(0, MAX_FIRST_SEEN_CHAT_IDS);
    if(!peerIds.length) return;
    peerIds.forEach((peerId) => this.pendingFirstSeenPeerIds.delete(peerId));

    // Mark them fetched up front: a failed request must not make every dialog row
    // retry on its next render, and the TTL will let them through again anyway.
    const now = Date.now();
    peerIds.forEach((peerId) => this.firstSeenFetchedAt.set(peerId, now));

    try {
      const result = await this.request<{data: CrmFirstSeenSummary}>('GET', CRM_ENDPOINTS.firstSeenSummary, {
        query: {
          chat_ids: peerIds.map((peerId) => peerId.toUserId()).join(','),
          session_telegram_user_id: this.sessionTelegramUserId()
        }
      });

      const summary = result?.data || {};
      for(const peerId of peerIds) {
        const entry = summary['' + peerId.toUserId()];
        if(entry) this.firstSeenByPeerId.set(peerId, entry);
        else this.firstSeenByPeerId.delete(peerId);
      }

      this.rootScope.dispatchEvent('crm_first_seen_summary_update', {peerIds});
    } catch(err) {
      this.log.error('first-seen summary failed', err);
    }

    // More peers queued up while this request was in flight (long chatlist).
    if(this.pendingFirstSeenPeerIds.size && !this.firstSeenBatchTimeout) {
      this.firstSeenBatchTimeout = ctx.setTimeout(() => {
        this.firstSeenBatchTimeout = undefined;
        this.flushFirstSeenBatch();
      }, FIRST_SEEN_BATCH_MS);
    }
  }

  /**
   * Fold a per-message map into the chat-list cache: the row shows the NEWEST
   * labeled message, so an open chat updating its bubbles keeps its list row in
   * step without a second request.
   */
  private rememberFirstSeen(chatId: string, map: CrmFirstSeenMap) {
    const messageIds = Object.keys(map);
    if(!chatId || !messageIds.length) return;

    let latest = 0;
    for(const messageId of messageIds) {
      const id = +messageId;
      if(id > latest) latest = id;
    }
    if(!latest) return;

    const peerId = (+chatId).toPeerId();
    const current = this.firstSeenByPeerId.get(peerId);
    if(current && current.message_id > latest) return;

    this.firstSeenByPeerId.set(peerId, {...map['' + latest], message_id: latest});
    this.firstSeenFetchedAt.set(peerId, Date.now());
    this.rootScope.dispatchEvent('crm_first_seen_summary_update', {peerIds: [peerId]});
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
      const result = await this.request<{data: {ticket_id: number | null, notes: CrmNote[]}}>('GET', CRM_ENDPOINTS.notes(chatId), {
        query: {session_telegram_user_id: this.sessionTelegramUserId()}
      });
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
    const result = await this.request<{data: CrmNote}>('POST', CRM_ENDPOINTS.addNote(chatId), {
      body: {text: text.trim(), session_telegram_user_id: this.sessionTelegramUserId()}
    });
    return result?.data;
  }

  // ── AI draft assistant ────────────────────────────────────────────────────
  // Ask the CRM to draft a reply for this chat's ticket. Costs a paid model call
  // per press (the endpoint is throttled per agent), so this is only ever called
  // from an explicit click — never on chat open, never on a timer.
  //
  // Errors propagate rather than resolving to undefined: the agent pressed a
  // button and is waiting, so a failure has to reach them as a toast instead of
  // looking like a draft that silently never arrived.
  /**
   * Ask the CRM to draft a reply for this chat's ticket.
   *
   * `force` bypasses the CRM's draft cache and pays for a fresh generation. Left
   * false, an unchanged conversation is re-served from cache for free — which is
   * what makes it safe for an agent to press this button as often as they like.
   * Pass it only when the agent is explicitly asking for a DIFFERENT suggestion,
   * because every forced call is a real model call on a real bill.
   */
  public async generateAiDraft(chatId: string, force?: boolean): Promise<CrmAiDraft | undefined> {
    if(!(await this.isConnected()) || !chatId) return undefined;
    const result = await this.request<{data: CrmAiDraft}>(
      'POST',
      CRM_ENDPOINTS.aiDraft(chatId),
      force ? {body: {force: true}} : undefined
    );
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

  /**
   * Who can be assigned a task in this project. Returns CRM USER ids, which is
   * what createTask wants — the agents endpoint returns Admin ids and those are
   * a different number for the same person.
   */
  public async getProjectMembers(projectId: number): Promise<CrmProjectMember[]> {
    if(!(await this.isConnected()) || !projectId) return [];
    try {
      return this.unwrap(await this.request<{data: CrmProjectMember[]}>(
        'GET', CRM_ENDPOINTS.projectMembers(projectId)
      ));
    } catch(err) {
      this.log.error('getProjectMembers failed', err);
      return [];
    }
  }

  public async getMyTasks(query: CrmTaskQuery = {}): Promise<CrmTask[]> {
    if(!(await this.isConnected())) return [];

    const params: Record<string, string> = {};
    if(query.projectId) params.project_id = '' + query.projectId;
    if(query.includeDone) params.include_done = '1';
    if(query.includeCreated) params.include_created = '1';
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
