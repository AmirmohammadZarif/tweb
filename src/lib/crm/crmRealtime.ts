import Pusher, {Channel} from 'pusher-js';
import rootScope from '@lib/rootScope';
import type {CrmRealtimeConfig} from '@lib/crm/types';
import {
  CRM_ATTRIBUTION_CHANNEL,
  CRM_SENSITIVE_CHANNEL,
  CRM_SENSITIVE_REQUESTED_EVENT,
  CRM_SENSITIVE_APPROVED_EVENT,
  CRM_NOTES_DEPARTMENT_CHANNEL,
  CRM_NOTE_ADDED_EVENT,
  CRM_NOTE_UPDATED_EVENT,
  CRM_NOTE_DELETED_EVENT,
  CRM_INBOUND_SEEN_EVENT,
  CrmFirstSeenMap,
  CrmNote
} from '@lib/crm/types';

// Realtime per-message agent attribution over Laravel Reverb (Pusher protocol).
//
// Agents share ONE department Telegram account, so a session can't tell which
// human typed a reply it didn't send itself. The CRM knows (per-agent token), and
// broadcasts an `outbound.attributed` event on a private per-peer channel whenever
// a message is attributed. This client — running on the MAIN thread, alongside the
// bubbles that render the labels — subscribes to the open chat's channel and turns
// each push into a `crm_attribution_push` event that bubbles.ts tags instantly.
//
// The REST backfill (appCrmManager.getAttributionsByTelegram) covers history and
// is the fallback if the socket is down; this only adds liveness.

type AttributionPush = {message_id: number, admin_id: number, name: string};
type InboundSeenPush = {seen: CrmFirstSeenMap};
type SensitiveRequestPush = {message_id: number, requested_by: number, name: string, reason?: string};
type SensitiveApprovedPush = {message_id: number, user_id: number | null};
type NotePush = {ticket_id: number, peer_chat_id?: string, note: CrmNote};

const ATTRIBUTION_EVENT = 'outbound.attributed';

// The Telegram account THIS session is signed in as — for a support agent that is
// their department's shared account. Every realtime channel is scoped by it,
// because a chat id alone doesn't name a conversation: the same customer may be
// talking to two departments at once, and neither may see the other's labels or
// notes. See CRM_SESSION_PARAM.
const sessionId = () => '' + rootScope.myId.toUserId();

class CrmRealtime {
  private pusher: Pusher;
  // Identity of the connection params, so we rebuild the socket only when they
  // actually change (token refresh, reconnect to a different CRM).
  private configKey: string;
  private channel: Channel;
  private channelName: string;
  private sensitiveChannel: Channel;
  private sensitiveChannelName: string;
  private notesChannel: Channel;
  private notesChannelName: string;
  // The peer we should currently be listening to — guards against a stale async
  // ensure() resolving after the user already switched chats.
  private currentPeerId: PeerId;

  constructor() {
    // The chat LIST needs the note feed before any chat is opened, so it comes up
    // on session availability rather than on a peer change. Both events are the
    // same ones crmRole listens to: a fresh login, a reconnect, a token refresh.
    rootScope.addEventListener('crm_config_update', this.ensureNotesFeed);
    rootScope.addEventListener('crm_auth_required', this.ensureNotesFeed);
    if(rootScope.myId) this.ensureNotesFeed();
    else rootScope.addEventListener('user_auth', this.ensureNotesFeed);
  }

  /**
   * Bring up (or keep) the department-wide note feed. Independent of which chat is
   * open — the chat list is its main consumer, and it has no peer.
   */
  public ensureNotesFeed = async() => {
    if(!rootScope.myId) return;
    // Cheap synchronous exit BEFORE the async config read: this is called from
    // every chatlist row that renders, and a manager round-trip per row would
    // undo the point of pooling the note previews in the first place.
    if(this.notesChannel && this.notesChannelName === CRM_NOTES_DEPARTMENT_CHANNEL(sessionId())) return;

    const pusher = await this.ensurePusher();
    if(!pusher || !rootScope.myId) return;

    this.subscribeNotes(pusher, sessionId());
  };

  private async ensurePusher(): Promise<Pusher | undefined> {
    const config: CrmRealtimeConfig = await rootScope.managers.appCrmManager.getRealtimeConfig();
    if(!config) {
      this.teardown();
      return undefined;
    }

    const {baseUrl, token, reverb} = config;
    const key = [baseUrl, token, reverb.key, reverb.host, reverb.port, reverb.scheme].join('|');
    if(this.pusher && key === this.configKey) return this.pusher;

    this.teardown();
    this.configKey = key;
    this.pusher = new Pusher(reverb.key, {
      wsHost: reverb.host,
      wsPort: reverb.port,
      wssPort: reverb.port,
      forceTLS: reverb.scheme === 'https',
      enabledTransports: ['ws', 'wss'],
      // Reverb is self-hosted: no Pusher cluster, auth via our bearer token.
      cluster: '',
      authEndpoint: baseUrl + '/api/mobile/broadcasting/auth',
      auth: {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/json'
        }
      }
    });

    return this.pusher;
  }

  // Listen for attributions on the given peer's chat. Safe to call on every peer
  // change; it no-ops when already on the right channel and swaps otherwise.
  public async subscribePeer(peerId: PeerId, chatId: string) {
    this.currentPeerId = peerId;

    const pusher = await this.ensurePusher();
    if(this.currentPeerId !== peerId || !pusher) return; // superseded or not connected

    const session = sessionId();
    const name = CRM_ATTRIBUTION_CHANNEL(session, chatId);
    if(name === this.channelName) return;
    this.unsubscribeChannel();
    this.channelName = name;

    this.channel = pusher.subscribe(name);
    this.channel.bind(ATTRIBUTION_EVENT, (data: AttributionPush) => {
      if(this.currentPeerId !== peerId || !data?.message_id) return;
      rootScope.dispatchEvent('crm_attribution_push', {
        peerId,
        messageId: data.message_id,
        attribution: {admin_id: data.admin_id, name: data.name}
      });
    });

    // Inbound first-seen shares the attribution channel: same audience, same
    // lifetime, and one fewer subscription per peer. Carries a whole map — a
    // session reports every message of one read burst in a single call.
    this.channel.bind(CRM_INBOUND_SEEN_EVENT, (data: InboundSeenPush) => {
      if(this.currentPeerId !== peerId || !data?.seen) return;
      rootScope.dispatchEvent('crm_first_seen_push', {peerId, seen: data.seen});
    });

    // Sensitive-message reveal workflow rides a sibling per-peer channel.
    this.sensitiveChannelName = CRM_SENSITIVE_CHANNEL(session, chatId);
    this.sensitiveChannel = pusher.subscribe(this.sensitiveChannelName);
    this.sensitiveChannel.bind(CRM_SENSITIVE_REQUESTED_EVENT, (data: SensitiveRequestPush) => {
      if(this.currentPeerId !== peerId || !data?.message_id) return;
      rootScope.dispatchEvent('crm_sensitive_request_push', {
        peerId,
        messageId: data.message_id,
        requestedBy: data.requested_by,
        name: data.name,
        reason: data.reason
      });
    });
    this.sensitiveChannel.bind(CRM_SENSITIVE_APPROVED_EVENT, (data: SensitiveApprovedPush) => {
      if(this.currentPeerId !== peerId || !data?.message_id) return;
      rootScope.dispatchEvent('crm_sensitive_reveal_push', {
        peerId,
        messageId: data.message_id,
        userId: data.user_id ?? null
      });
    });

    // Internal notes do NOT ride a per-peer channel: an agent has one chat open,
    // but a colleague's note may land on any chat-list row, and there is no
    // subscription per row. They come over one department-wide channel instead,
    // subscribed independently of the open peer — see subscribeNotes.
    this.subscribeNotes(pusher, session);
  }

  /**
   * Department-wide internal-note feed, subscribed once per session rather than
   * per peer. Every note change in the department arrives here with its chat id,
   * so the chat list goes live for rows nobody has open — which is the whole point
   * of it not being per-peer.
   */
  private subscribeNotes(pusher: Pusher, session: string) {
    const name = CRM_NOTES_DEPARTMENT_CHANNEL(session);
    if(this.notesChannelName === name && this.notesChannel) return;

    if(this.notesChannelName) {
      pusher.unsubscribe(this.notesChannelName);
    }

    this.notesChannelName = name;
    this.notesChannel = pusher.subscribe(name);

    // The chat a push belongs to, or undefined when the payload predates the
    // department channel (an old CRM broadcasting only the per-peer shape).
    const pushedPeerId = (data: NotePush) => {
      const chatId = data?.peer_chat_id;
      return chatId ? (+chatId).toPeerId() : undefined;
    };

    // An edit arrives as the whole note, so add and update are the same merge —
    // every consumer keys notes by id.
    [CRM_NOTE_ADDED_EVENT, CRM_NOTE_UPDATED_EVENT].forEach((event) => {
      this.notesChannel.bind(event, (data: NotePush) => {
        const peerId = pushedPeerId(data);
        if(!peerId || !data?.note?.id) return;
        rootScope.dispatchEvent('crm_note_push', {peerId, note: data.note});
      });
    });
    this.notesChannel.bind(CRM_NOTE_DELETED_EVENT, (data: NotePush) => {
      const peerId = pushedPeerId(data);
      if(!peerId || !data?.note?.id) return;
      rootScope.dispatchEvent('crm_note_delete_push', {peerId, noteId: data.note.id});
    });
  }

  // Stop listening (peer is not a CRM customer chat, or the chat closed). Keeps the
  // socket open for the next chat — only the channel subscription is dropped.
  public leave() {
    this.currentPeerId = undefined;
    this.unsubscribeChannel();
  }

  /**
   * Drop the PER-PEER subscriptions. The notes channel is deliberately not one of
   * them: it is department-wide, and dropping it on every chat switch would blind
   * the chat list exactly while the agent is scanning it.
   */
  private unsubscribeChannel() {
    if(this.channelName && this.pusher) {
      this.pusher.unsubscribe(this.channelName);
    }
    if(this.sensitiveChannelName && this.pusher) {
      this.pusher.unsubscribe(this.sensitiveChannelName);
    }
    this.channel = undefined;
    this.channelName = undefined;
    this.sensitiveChannel = undefined;
    this.sensitiveChannelName = undefined;
  }

  private unsubscribeNotes() {
    if(this.notesChannelName && this.pusher) {
      this.pusher.unsubscribe(this.notesChannelName);
    }
    this.notesChannel = undefined;
    this.notesChannelName = undefined;
  }

  private teardown() {
    this.unsubscribeChannel();
    this.unsubscribeNotes();
    if(this.pusher) {
      this.pusher.disconnect();
      this.pusher = undefined;
    }
    this.configKey = undefined;
  }
}

const crmRealtime = new CrmRealtime();
export default crmRealtime;
