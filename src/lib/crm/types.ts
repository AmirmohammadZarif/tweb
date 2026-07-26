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
  is_super_admin?: boolean
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
  // Internal agent-only notes for a chat (keyed by the customer's telegram chat
  // id, like attributions). See CrmNote.
  notes: (chatId: string) => `/tickets/by-telegram/${encodeURIComponent(chatId)}/notes`,
  addNote: (chatId: string) => `/tickets/by-telegram/${encodeURIComponent(chatId)}/note`,
  // Sensitive-message reveal workflow (all keyed by the customer's telegram
  // chat id, like attributions). See CrmSensitiveRevealState.
  sensitiveReveals: (chatId: string) => `/tickets/by-telegram/${encodeURIComponent(chatId)}/sensitive-reveals`,
  sensitiveRevealRequest: (chatId: string) => `/tickets/by-telegram/${encodeURIComponent(chatId)}/sensitive-reveals/request`,
  sensitiveRevealApprove: (chatId: string) => `/tickets/by-telegram/${encodeURIComponent(chatId)}/sensitive-reveals/approve`
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
export const CRM_NOTES_CHANNEL = (chatId: string) => 'private-notes.peer.' + chatId;
export const CRM_NOTE_ADDED_EVENT = 'note.added';
