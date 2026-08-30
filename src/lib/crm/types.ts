export const CRM_CONFIG_STORAGE_KEY = 'crmConfig';

// Connection config for the Andropay CRM "Mobile API" (/api/mobile/*).
// Auth is a per-agent Sanctum bearer token obtained via the OTP login flow, so
// it is safe to keep client-side and is scoped to the signed-in agent.
export type CrmUser = {
  id: number,
  full_name?: string,
  display_name?: string,
  mobile?: string,
  avatar_url?: string,
  // Role flag from GET /auth/me (verify-otp doesn't return it — see
  // AppCrmManager.refreshMe). Gates admin-only UI; absent/false = regular agent.
  is_super_admin?: boolean,
  // Onboarding trainee: may READ the department's conversations and nothing else.
  // Every write affordance is off and no read receipt is ever sent — see
  // @stores/crmRole and AppCrmManager.isReadOnlyCached.
  is_read_only?: boolean
};

export type CrmConfig = {
  enabled: boolean,
  baseUrl: string, // e.g. https://andropay.xyzlocalhost:8000
  token: string,
  user?: CrmUser,
  // Global setting from GET /config: whether revealing sensitive content needs
  // super-admin approval (true) or the agent may self-reveal with a logged reason
  // (false). Cached with the config; refreshed by AppCrmManager.refreshMe.
  // Defaults to true (fail-safe) until the first /config fetch lands.
  requireSensitiveApproval?: boolean
};

// Production CRM. Agents connect to this by default; the base-url field is
// prefilled with it so they only need their mobile + OTP.
export const DEFAULT_CRM_BASE_URL = 'https://andropay.xyz';

export const EMPTY_CRM_CONFIG: CrmConfig = {
  enabled: false,
  baseUrl: DEFAULT_CRM_BASE_URL,
  token: ''
};

// All endpoints live under {baseUrl}/api/mobile — see routes/api.php in the CRM.
export const CRM_API_PREFIX = '/api/mobile';
export const CRM_ENDPOINTS = {
  config: '/config',
  sendOtp: '/auth/send-otp',
  verifyOtp: '/auth/verify-otp',
  logout: '/auth/logout',
  me: '/auth/me',
  templates: '/templates',
  templateImages: (id: number) => '/templates/' + id + '/images',
  faqs: '/faqs',
  agents: '/agents',
  customersSearch: '/customers/search',
  tickets: '/tickets',
  // Inbound mirror of the attribution endpoints: which agent SAW each customer
  // message first. See CrmFirstSeen.
  markSeen: (chatId: string) => `/tickets/by-telegram/${encodeURIComponent(chatId)}/seen`,
  firstSeen: (chatId: string) => `/tickets/by-telegram/${encodeURIComponent(chatId)}/first-seen`,
  firstSeenSummary: '/tickets/first-seen/summary',
  // Internal agent-only notes for a chat (keyed by the customer's telegram chat
  // id, like attributions). See CrmNote.
  notes: (chatId: string) => `/tickets/by-telegram/${encodeURIComponent(chatId)}/notes`,
  addNote: (chatId: string) => `/tickets/by-telegram/${encodeURIComponent(chatId)}/note`,
  // Sensitive-message reveal workflow (all keyed by the customer's telegram
  // chat id, like attributions). See CrmSensitiveRevealState.
  sensitiveReveals: (chatId: string) => `/tickets/by-telegram/${encodeURIComponent(chatId)}/sensitive-reveals`,
  sensitiveRevealRequest: (chatId: string) => `/tickets/by-telegram/${encodeURIComponent(chatId)}/sensitive-reveals/request`,
  sensitiveRevealApprove: (chatId: string) => `/tickets/by-telegram/${encodeURIComponent(chatId)}/sensitive-reveals/approve`,
  // Project management — the agent's own tasks, so they can capture work and log
  // time without leaving the chat client.
  projects: '/projects',
  projectMembers: (id: number) => `/projects/${id}/members`,
  tasks: '/tasks',
  taskStatus: (id: number) => `/tasks/${id}/status`,
  taskTime: (id: number) => `/tasks/${id}/time`,
  taskEstimate: (id: number) => `/tasks/${id}/estimate`,
  // On-demand AI reply draft for a chat's ticket. See CrmAiDraft.
  aiDraft: (chatId: string) => `/tickets/by-telegram/${encodeURIComponent(chatId)}/ai-draft`,
  // Crash reports — tweb ships as static files, so without this a JS crash in an
  // agent's browser leaves no trace on our side. See @lib/debug/crashReporter.
  clientLogs: '/client-logs'
};

// ── AI draft assistant ───────────────────────────────────────────────────────
// The composer's AI-star button asks the CRM to draft a reply for the chat's
// current ticket. The CRM runs its configured assist pipeline (grounded in the
// FAQ base, this customer's earlier threads, and similar threads from other
// customers) and hands the text straight back — it sends nothing to the customer
// and writes nothing to the ticket. The agent edits it in the composer and sends
// it themselves.

// Why there is no draft, when there is no draft. The endpoint answers 200 for all
// of these: a filter stage deciding a human should take this one is the system
// working, not an error, and the agent needs to be told which case they hit.
export type CrmAiDraftReason =
  | 'no_pipeline'      // no assist/reply pipeline is enabled for this department
  | 'no_message'       // nothing from the customer to answer yet
  | 'filtered_out'     // a filter stage decided this one needs a human
  | 'empty'            // the pipeline ran but produced no text
  | 'failed'           // the model call itself failed
  | 'budget_exceeded'; // the CRM's daily AI spend cap is used up

// POST /tickets/by-telegram/{chatId}/ai-draft -> {data: CrmAiDraft}
export type CrmAiDraft = {
  ok: boolean,
  text: string | null,
  reason: CrmAiDraftReason | null,
  // Audit id of the recorded run (ai_pipeline_runs), for tracing a bad draft
  // back to the pipeline and prompt that produced it.
  run_id: number | null,
  // Tokens this REQUEST spent. Zero on a cache hit — the draft still has text,
  // it just did not cost anything to re-serve, so summing this client-side gives
  // real spend rather than double-counting every re-press.
  total_tokens: number,
  // True when the CRM re-served a draft it had already generated for this exact
  // conversation instead of paying for a new one. The agent sees the same text
  // they saw last press, which is why the button offers a re-roll rather than
  // silently handing back an identical suggestion.
  cached?: boolean,
  // What this request cost in USD. Zero for a cache hit.
  cost_usd?: number,
  // What the draft was grounded in. Not rendered anywhere today — kept because
  // "why did it say that" is the first question about any bad draft.
  grounded_on: {
    faqs?: boolean,
    customer_threads?: number,
    similar_threads?: number
  }
};

// ── Project tasks ────────────────────────────────────────────────────────────
// Mirrors MobileProjectController::present() in the CRM. Estimate/spent/progress
// are PER AGENT, not per task: two people on one task each have their own
// numbers, which is why every field here is prefixed `my_`.

export type CrmTaskStatus = 'todo' | 'in_progress' | 'review' | 'blocked' | 'done';
export type CrmTaskPriority = 'low' | 'normal' | 'high' | 'urgent';

// GET /projects -> {data: CrmProject[]}
export type CrmProject = {
  id: number,
  name: string,
  code?: string,
  status: string
};

// GET /projects/{id}/members -> {data: CrmProjectMember[]}
// `id` is the CRM USER id, which is what assignee_user_ids wants — deliberately
// not the Admin id that GET /agents returns, since the two are different numbers
// for the same person.
export type CrmProjectMember = {
  id: number,
  name: string,
  is_me: boolean
};

// Where a task was captured from. Present only on tasks created out of a
// customer conversation; see CrmCreateTaskInput.
export type CrmTaskCustomer = {
  id: number,
  name: string,
  // Numeric in JSON (it is an integer column), unlike source.peer_chat_id which
  // is the string the client sent. Both accept .toPeerId().
  telegram_chat_id?: string | number
};

export type CrmTaskSource = {
  ticket_id?: number,
  peer_chat_id?: string,
  message_id?: number
};

// GET /tasks -> {data: CrmTask[]}
export type CrmTask = {
  id: number,
  title: string,
  description?: string,
  status: CrmTaskStatus,
  status_label: string,
  priority: CrmTaskPriority,
  priority_label: string,
  project: {id: number, name?: string, code?: string},
  due_at?: string, // ISO8601
  is_overdue: boolean,
  // False for a task the agent created but put on someone else — see
  // CrmTaskQuery.includeCreated.
  is_assigned_to_me?: boolean,
  // Set when an agent turned a customer's message into this task.
  customer?: CrmTaskCustomer,
  source?: CrmTaskSource,
  assignees?: {id: number, name: string}[],
  my_estimate_minutes: number,
  my_spent_minutes: number,
  my_progress: number
};

// POST /tasks. project_id + title are the only required fields; the CRM assigns
// the task to the calling agent when assignee_user_ids is omitted.
export type CrmCreateTaskInput = {
  project_id: number,
  title: string,
  description?: string,
  status?: CrmTaskStatus,
  priority?: CrmTaskPriority,
  due_at?: string,
  estimated_minutes?: number,
  // CRM user ids (see CrmProjectMember). The server rejects anyone without
  // access to the project rather than filing the task where they cannot see it.
  assignee_user_ids?: number[],
  // Provenance for tasks captured from a chat. The CRM resolves the customer
  // from customer_id, else from source_peer_chat_id (the telegram chat id), and
  // attaches the customer's current ticket by itself.
  customer_id?: number,
  source_peer_chat_id?: string,
  source_message_id?: number
};

export type CrmTaskQuery = {
  projectId?: number,
  includeDone?: boolean,
  status?: CrmTaskStatus[],
  // Also return tasks this agent created for someone else. Off by default so
  // the list stays "my work"; on, it is the only way to see a task after
  // handing it to a colleague.
  includeCreated?: boolean
};

// ── Sensitive-message reveal workflow ────────────────────────────────────────
// Agents share one department Telegram account and must not casually read a
// customer's financial/identity details. The client blurs any message it
// detects as sensitive (see @lib/crm/sensitiveContent); a CRM-superadmin then
// approves the reveal per requesting agent. Approvals reach every open session
// live over Reverb and are backfilled on chat open via GET sensitiveReveals.

// GET /tickets/by-telegram/{chatId}/sensitive-reveals -> {data: CrmSensitiveRevealState}
export type CrmSensitiveRevealState = {
  // Telegram message ids this agent is allowed to see in the clear.
  approved: number[],
  // Outstanding requests, surfaced to superadmins so they can approve.
  pending: CrmSensitiveRequest[]
};

export type CrmSensitiveRequest = {
  message_id: number,
  requested_by: number, // CRM admin id of the agent who asked
  name: string
};

// Reverb (Pusher protocol) channel + events for the reveal workflow, mirroring
// the attribution channel. The backend broadcasts on the private per-peer
// channel; the client dispatches rootScope events off these.
export const CRM_SENSITIVE_CHANNEL = (chatId: string) => 'private-sensitive.peer.' + chatId;
export const CRM_SENSITIVE_REQUESTED_EVENT = 'sensitive.reveal.requested';
export const CRM_SENSITIVE_APPROVED_EVENT = 'sensitive.reveal.approved';

// Reserved pseudo message-id for a peer's CONTACT INFO (phone + username) in the
// reveal workflow — real Telegram message ids are >= 1, so 0 never collides with
// a message. A regular agent requests it like any message; approving it reveals
// the contact rows in the peer profile.
export const CONTACT_INFO_MID = 0;

// GET /config -> {data: {... , reverb: CrmReverbConfig}}. The public Reverb
// endpoint tweb opens a WebSocket to for realtime per-message attribution. The
// app key is a public client credential.
export type CrmReverbConfig = {
  key: string,
  host: string,
  port: number,
  scheme: string
};

// Everything the main-thread Reverb client needs: the public Reverb params plus
// the agent's base url + bearer token (for the /broadcasting/auth handshake).
export type CrmRealtimeConfig = {
  baseUrl: string,
  token: string,
  reverb: CrmReverbConfig
};

// GET /templates -> {data: CrmTemplate[]}
export type CrmTemplate = {
  id: number,
  name: string,
  text: string,
  // origin-relative /storage paths of attached images (prefix with the CRM
  // baseUrl to display). Empty/absent when the template has no images.
  image_urls?: string[]
};

// GET /templates/{id}/images -> {data: CrmTemplateImage[]}. The image bytes as
// base64 data URIs, fetched lazily when an image-bearing template is picked so
// they can be staged as Files in the send-preview.
export type CrmTemplateImage = {
  name: string,
  mime: string,
  data: string // data URI: data:<mime>;base64,<...>
};

// GET /faqs -> {data: CrmFaq[]}
export type CrmFaq = {
  id: number,
  department_id: number,
  question: string,
  answer: string
};

// GET /customers/search?q= -> {data: CrmCustomer[]}
export type CrmCustomer = {
  id: number,
  full_name?: string,
  display_name?: string,
  mobile?: string,
  avatar_url?: string
};

// GET /agents -> {data: CrmAgent[]}
export type CrmAgent = {
  id: number,
  name: string,
  open_ticket_count: number
};

export type CrmTicketStatus = 'open' | 'closed' | 'archived';

export type CrmTicketEventType = 'opened' | 'closed' | 'reopened';

export type CrmTicketEvent = {
  type: CrmTicketEventType,
  at: string // ISO8601
};

// GET /tickets/by-telegram/{chatId} -> {ticket: CrmTicketRef | null}
export type CrmTicketRef = {
  id: number,
  status: CrmTicketStatus,
  events?: CrmTicketEvent[]
};

export type CrmTicketListItem = CrmTicketRef & {
  customer?: CrmCustomer & {telegram_chat_id?: string | null},
  updated_at?: string,
  created_at?: string
};

export type CrmTicketListResult = {
  data: CrmTicketListItem[],
  current_page: number,
  last_page: number,
  total: number,
  /**
   * Echo of the department resolved from `session_telegram_user_id`. `null` while
   * the session isn't mapped to a department (the CRM then returns nothing rather
   * than every open ticket) — the signal that distinguishes "no tickets" from
   * "this Telegram session has no department".
   */
  department_id?: number | null
};

/** Outcome of resolving a chat to its CRM ticket — separates "no ticket" from errors. */
export type CrmTicketLookupResult = {
  ticket?: CrmTicketRef,
  /** CRM answered OK but returned ticket: null (no customer / no access / none open). */
  noTicket?: boolean,
  /** Network/HTTP failure or CRM not connected — distinct from an empty ticket. */
  failed?: boolean,
  httpStatus?: number
};

// GET /tickets/by-telegram/{chatId}/attributions -> {data: CrmAttributionMap}
// Per-message author map: <telegram message id> -> {admin_id, name}. Lets every
// agent session label outbound bubbles with who replied, even though all agents
// share one department Telegram account.
export type CrmMessageAttribution = {
  admin_id: number,
  name: string
};

export type CrmAttributionMap = Record<string, CrmMessageAttribution>;

// ── Inbound first-seen ("who picked this conversation up") ───────────────────
// The mirror image of attributions. Agents read the customer over ONE shared
// department Telegram account, so the moment anybody opens the chat every
// message is read for everybody — Telegram's read state can't name the human who
// got there first. Each session reports the messages it actually displayed as
// unread; the CRM keeps the FIRST report per message and hands the resulting map
// back to every session (REST backfill on chat open + `inbound.seen` push).

// GET /tickets/by-telegram/{chatId}/first-seen -> {data: CrmFirstSeenMap}
// POST /tickets/by-telegram/{chatId}/seen {message_ids} -> {data: CrmFirstSeenMap}
export type CrmFirstSeen = {
  admin_id: number,
  name: string,
  at?: string // ISO8601
};

export type CrmFirstSeenMap = Record<string, CrmFirstSeen>;

// GET /tickets/first-seen/summary?chat_ids= -> {data: Record<chatId, CrmFirstSeenSummaryEntry>}
// One entry per chat — the newest customer message that has a first viewer — which
// is what the chat LIST labels each row with (the full per-message map would be
// orders of magnitude too much data for a list of hundreds of rows).
export type CrmFirstSeenSummaryEntry = CrmFirstSeen & {
  message_id: number
};

export type CrmFirstSeenSummary = Record<string, CrmFirstSeenSummaryEntry>;

// Realtime first-viewer push. Rides the per-peer ATTRIBUTION channel (same
// audience, same lifetime) rather than a channel of its own, and carries a whole
// map: a session reports every message of a read burst in one call.
export const CRM_INBOUND_SEEN_EVENT = 'inbound.seen';

// ── Department scoping ───────────────────────────────────────────────────────
// A Telegram chat id does NOT name a conversation on its own: one customer can be
// talking to several departments at the same time, each over its own department
// Telegram account, and those are separate tickets with separate agents, notes and
// viewers. So every chat-keyed CRM call carries the id of the Telegram account
// THIS session is signed in as, and the CRM scopes tickets/notes/labels to that
// department. Without it, a Financial agent's name shows up on a Monetization chat
// they cannot even open.
export const CRM_SESSION_PARAM = 'session_telegram_user_id';

// Realtime channels are scoped the same way — the session id is part of the
// channel name, so a push only ever reaches the department it belongs to.
export const CRM_ATTRIBUTION_CHANNEL = (sessionId: string, chatId: string) =>
  'private-attribution.peer.' + sessionId + '.' + chatId;

// ── Internal agent notes ─────────────────────────────────────────────────────
// Agents share one department Telegram account, so an internal note is how they
// hand context to a colleague from inside the conversation. Notes are agent-only
// (never sent to the customer): backfilled on chat open via GET notes, pushed
// live over Reverb (note.added), rendered both inline in the timeline and in a
// dedicated notes panel.

// GET /tickets/by-telegram/{chatId}/notes -> {data: {ticket_id, notes: CrmNote[]}}
export type CrmNote = {
  id: number,
  text: string,
  author_id: number | null,
  author_name: string,
  created_at: string // ISO8601
};

export type CrmNotesResult = {
  ticketId: number | null,
  notes: CrmNote[]
};

// Reverb (Pusher protocol) channel + event for live note hand-off, mirroring the
// attribution channel. The backend broadcasts on the private per-peer channel;
// the client turns each push into a `crm_note_push` rootScope event.
export const CRM_NOTES_CHANNEL = (sessionId: string, chatId: string) =>
  'private-notes.peer.' + sessionId + '.' + chatId;
export const CRM_NOTE_ADDED_EVENT = 'note.added';

// ── Client crash reports ─────────────────────────────────────────────────────
// POST /client-logs. `entries` is tweb's merged log ring buffer (main thread +
// MTProto worker + service worker), which is the whole point: the stack alone
// rarely explains an MTProto or storage failure. The server caps and trims the
// payload again on its side, and fingerprints it for grouping.

export type CrmClientLogReason = 'error' | 'unhandledrejection' | 'manual';

export type CrmClientLogPayload = {
  reason: CrmClientLogReason,
  message: string,
  stack?: string,
  url?: string,
  app_version?: string,
  app_build?: number,
  entries?: any[]
};

export type CrmClientLogResult = {
  id: number,
  fingerprint: string,
  entry_count: number,
  occurrences: number
};
