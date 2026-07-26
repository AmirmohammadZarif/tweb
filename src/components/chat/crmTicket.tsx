import {Accessor, createSignal, Show} from 'solid-js';
import type {MyMessage} from '@appManagers/appMessagesManager';
import getServerMessageId from '@appManagers/utils/messageId/getServerMessageId';
import {AppManagers} from '@lib/managers';
import debounce from '@helpers/schedulers/debounce';
import pause from '@helpers/schedulers/pause';
import {i18n} from '@lib/langPack';
import rootScope from '@lib/rootScope';
import Chat from '@components/chat/chat';
import type ChatTopbar from '@components/chat/topbar';
import TopbarPlate, {createTopbarPlate, TopbarPlateController} from '@components/chat/topbarPlate';
import {CrmNote, CrmTicketEvent, CrmTicketRef} from '@lib/crm/types';
import crmRealtime from '@lib/crm/crmRealtime';
import {showCrmLoginIfNeeded} from '@components/popups/crmLogin';
import {toastNew} from '@components/toast';

const className = 'crm-ticket';

/** Retries for a failed by-telegram lookup before showing the error bar. */
const LOAD_RETRIES = 2;
const LOAD_RETRY_MS = 600;
/** Second pass on peer open — cached chats may not fire history_multiappend. */
const FOLLOWUP_LOAD_MS = 1500;

type LoadState = 'idle' | 'loading' | 'failed';

export type ChatCrmTicketPlate = TopbarPlateController & {
  setPeerId: (peerId: PeerId) => void,
  hide: () => void,
  /** The currently loaded ticket for this peer (cached signal), or undefined. */
  getTicket: () => CrmTicketRef | undefined,
  /** Close the current open ticket. No-op unless there is an open ticket. */
  close: () => Promise<void>,
  /** Internal notes for the current chat's ticket (cached signal). */
  getNotes: () => CrmNote[],
  /** Whether the chat has a ticket notes can attach to (a note can be added). */
  hasTicketForNotes: () => boolean,
  /** Add an internal note to the current chat's ticket. Resolves to the created
   * note, or undefined on failure (a toast is shown). */
  addNote: (text: string) => Promise<CrmNote | undefined>
};

function CrmTicketPlateBody(props: {
  ticket: Accessor<CrmTicketRef | undefined>,
  loadState: Accessor<LoadState>,
  busy: Accessor<boolean>,
  reconnectNeeded: Accessor<boolean>,
  onClose: () => void,
  onReconnect: () => void,
  onRetry: () => void
}) {
  return (
    <Show
      when={!props.reconnectNeeded()}
      fallback={
        <div class={'pinned-' + className + '-content'}>
          <div class={'pinned-' + className + '-info'}>
            <div class={'pinned-' + className + '-title'}>
              {i18n('Crm.SessionExpired')}
            </div>
          </div>
          <TopbarPlate.PrimaryButton onClick={props.onReconnect}>
            {i18n('Crm.Login')}
          </TopbarPlate.PrimaryButton>
        </div>
      }
    >
      <Show
        when={props.loadState() === 'failed'}
        fallback={
          <Show
            when={props.loadState() === 'loading'}
            fallback={
              <Show when={props.ticket()}>
                {(ticket) => (
                  <div class={'pinned-' + className + '-content'}>
                    <div class={'pinned-' + className + '-info'}>
                      <div class={'pinned-' + className + '-title'}>
                        {i18n('Crm.Ticket.Title', [ticket().id])}
                      </div>
                      <div class={'pinned-' + className + '-subtitle'}>
                        {i18n('Crm.Ticket.StatusOpen')}
                      </div>
                    </div>
                    <TopbarPlate.PrimaryButton onClick={() => !props.busy() && props.onClose()}>
                      {i18n('Crm.Ticket.Close')}
                    </TopbarPlate.PrimaryButton>
                  </div>
                )}
              </Show>
            }
          >
            <div class={'pinned-' + className + '-content'}>
              <div class={'pinned-' + className + '-info'}>
                <div class={'pinned-' + className + '-title'}>
                  {i18n('Crm.Ticket.Loading')}
                </div>
              </div>
            </div>
          </Show>
        }
      >
        <div class={'pinned-' + className + '-content'}>
          <div class={'pinned-' + className + '-info'}>
            <div class={'pinned-' + className + '-title'}>
              {i18n('Crm.Ticket.LoadFailed')}
            </div>
          </div>
          <TopbarPlate.PrimaryButton onClick={props.onRetry}>
            {i18n('Crm.Ticket.Retry')}
          </TopbarPlate.PrimaryButton>
        </div>
      </Show>
    </Show>
  );
}

export default function createChatCrmTicketPlate(
  topbar: ChatTopbar,
  chat: Chat,
  managers: AppManagers
): ChatCrmTicketPlate {
  const [ticket, setTicket] = createSignal<CrmTicketRef | undefined>();
  const [loadState, setLoadState] = createSignal<LoadState>('idle');
  const [busy, setBusy] = createSignal(false);
  const [reconnectNeeded, setReconnectNeeded] = createSignal(false);
  const [notes, setNotes] = createSignal<CrmNote[]>([]);
  // ticket id the notes attach to (from getNotesByTelegram); null = no ticket.
  let notesTicketId: number | null = null;

  // Token to discard responses for a peer the user already navigated away from.
  let currentPeerId: PeerId;
  // Bumps on every load() so a stale in-flight response can't overwrite a newer one.
  let loadGeneration = 0;

  const openCrmLogin = () => showCrmLoginIfNeeded();

  const plate = createTopbarPlate({
    modifier: className,
    height: 52,
    onVisibilityChange: () => topbar.setFloating(),
    render: () => (
      <CrmTicketPlateBody
        ticket={ticket}
        loadState={loadState}
        busy={busy}
        reconnectNeeded={reconnectNeeded}
        onClose={() => closeTicket()}
        onReconnect={openCrmLogin}
        onRetry={() => load(currentPeerId, 0, true)}
      />
    )
  });

  const syncPlateVisibility = (found?: CrmTicketRef) => {
    if(reconnectNeeded()) {
      plate.setHidden(false);
      return;
    }
    if(loadState() === 'loading' || loadState() === 'failed') {
      plate.setHidden(false);
      return;
    }
    plate.setHidden(!found || found.status !== 'open');
  };

  const hide = () => {
    plate.setHidden(true);
    setTicket(undefined);
    setLoadState('idle');
    setReconnectNeeded(false);
  };

  // Reflect a ticket: the bar shows ONLY for an open ticket (a closed ticket is
  // terminal in this CRM — the next message opens a NEW ticket). Always emit the
  // event so the timeline dividers stay in sync, even when the bar is hidden.
  const apply = (peerId: PeerId, found?: CrmTicketRef) => {
    if(peerId !== currentPeerId) return;
    setTicket(found);
    syncPlateVisibility(found);
    rootScope.dispatchEvent('crm_ticket_update', {peerId, ticket: found});
  };

  const load = async(peerId: PeerId, attempt = 0, toastOnFailure = false) => {
    if(!peerId?.isUser()) {
      setLoadState('idle');
      apply(peerId, undefined);
      return;
    }

    const generation = ++loadGeneration;
    const chatId = '' + peerId.toUserId();

    const connected = await managers.appCrmManager.isConnected();
    if(peerId !== currentPeerId || generation !== loadGeneration) return;

    if(!connected) {
      setReconnectNeeded(true);
      setLoadState('idle');
      plate.setHidden(false);
      return;
    }

    setReconnectNeeded(false);
    setLoadState('loading');
    plate.setHidden(false);

    const result = await managers.appCrmManager.getTicketByTelegram(chatId);
    if(peerId !== currentPeerId || generation !== loadGeneration) return;

    if(result.failed) {
      if(attempt < LOAD_RETRIES) {
        await pause(LOAD_RETRY_MS * (attempt + 1));
        if(peerId === currentPeerId && generation === loadGeneration) {
          return load(peerId, attempt + 1, toastOnFailure);
        }
        return;
      }

      setLoadState('failed');
      setTicket(undefined);
      plate.setHidden(false);
      rootScope.dispatchEvent('crm_ticket_update', {peerId, ticket: undefined});
      if(toastOnFailure) {
        toastNew({langPackKey: 'Crm.Ticket.LoadFailed'});
      }
      return;
    }

    setLoadState('idle');
    const found = result.noTicket ? undefined : result.ticket;
    apply(peerId, found);
  };

  /** Cached backfill chats may never fire history_multiappend — retry once after open. */
  const scheduleFollowUpLoad = (peerId: PeerId) => {
    pause(FOLLOWUP_LOAD_MS).then(() => {
      if(peerId !== currentPeerId) return;
      const current = ticket();
      if(current?.status === 'open') return;
      if(loadState() === 'failed') return;
      load(peerId);
    });
  };

  // Per-message author map for the chat: every agent session labels outbound
  // bubbles with who replied, even though all agents share one Telegram account.
  const loadAttributions = (peerId: PeerId) => {
    if(!peerId?.isUser()) {
      crmRealtime.leave();
      rootScope.dispatchEvent('crm_attributions_update', {peerId, attributions: {}});
      return;
    }

    managers.appCrmManager.isConnected().then((connected) => {
      if(peerId !== currentPeerId) return;
      if(!connected) {
        setReconnectNeeded(true);
        plate.setHidden(false);
        return;
      }
      crmRealtime.subscribePeer(peerId, '' + peerId.toUserId());
      managers.appCrmManager.getAttributionsByTelegram('' + peerId.toUserId()).then((attributions) => {
        if(peerId !== currentPeerId) return;
        rootScope.dispatchEvent('crm_attributions_update', {peerId, attributions});
      });
    });
  };

  // Sensitive-message reveal state: which blurred messages THIS agent may see,
  // plus pending requests for superadmins. Backfill on chat open; the Reverb
  // push (subscribed alongside attributions) keeps it live.
  const loadSensitiveReveals = (peerId: PeerId) => {
    if(!peerId?.isUser()) {
      rootScope.dispatchEvent('crm_sensitive_reveals_update', {peerId, state: {approved: [], pending: []}});
      return;
    }

    managers.appCrmManager.isConnected().then((connected) => {
      if(peerId !== currentPeerId || !connected) return;
      managers.appCrmManager.getSensitiveReveals('' + peerId.toUserId()).then((state) => {
        if(peerId !== currentPeerId) return;
        rootScope.dispatchEvent('crm_sensitive_reveals_update', {peerId, state});
      });
    });
  };

  // Internal agent notes for the chat: backfill on chat open; the Reverb push
  // (subscribed alongside attributions) delivers a colleague's note live.
  const applyNotes = (peerId: PeerId, list: CrmNote[]) => {
    if(peerId !== currentPeerId) return;
    setNotes(list);
    rootScope.dispatchEvent('crm_notes_update', {peerId, notes: list});
  };

  const loadNotes = (peerId: PeerId) => {
    if(!peerId?.isUser()) {
      notesTicketId = null;
      applyNotes(peerId, []);
      return;
    }

    managers.appCrmManager.isConnected().then((connected) => {
      if(peerId !== currentPeerId || !connected) return;
      managers.appCrmManager.getNotesByTelegram('' + peerId.toUserId()).then((result) => {
        if(peerId !== currentPeerId) return;
        notesTicketId = result.ticketId;
        applyNotes(peerId, result.notes);
      });
    });
  };

  // Merge a single live/optimistic note, dropping any existing row with the same
  // id (the local optimistic append races the Reverb echo of our own note) and
  // keeping the list ordered by creation time.
  const mergeNote = (peerId: PeerId, note: CrmNote) => {
    if(peerId !== currentPeerId || !note?.id) return;
    const next = notes().filter((n) => n.id !== note.id);
    next.push(note);
    next.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    applyNotes(peerId, next);
  };

  const addNote = async(text: string): Promise<CrmNote | undefined> => {
    const value = (text || '').trim();
    const peerId = currentPeerId;
    if(!value || !peerId?.isUser()) return undefined;
    try {
      const note = await managers.appCrmManager.addNoteByTelegram('' + peerId.toUserId(), value);
      if(!note) {
        toastNew({langPackKey: 'Crm.Note.NoTicket'});
        return undefined;
      }
      mergeNote(peerId, note);
      return note;
    } catch(err) {
      const status = (err as Error & {status?: number})?.status;
      toastNew({langPackKey: status === 404 ? 'Crm.Note.NoTicket' : 'Crm.Note.AddFailed'});
      return undefined;
    }
  };

  let claimedTicketId: number;

  const setPeerId = (peerId: PeerId) => {
    currentPeerId = peerId;
    claimedTicketId = undefined;
    notesTicketId = null;
    setNotes([]);
    loadGeneration++;
    hide();
    load(peerId);
    scheduleFollowUpLoad(peerId);
    loadAttributions(peerId);
    loadSensitiveReveals(peerId);
    loadNotes(peerId);
  };

  const maybeClaim = (peerId: PeerId) => {
    if(!peerId?.isUser()) return;
    const current = ticket();
    if(current && current.status === 'open' && current.id === claimedTicketId) return;
    if(current?.id) claimedTicketId = current.id;
    managers.appCrmManager.claimTicketByTelegram('' + peerId.toUserId());
  };

  const attributeOutbound = (message: MyMessage) => {
    const peerId = message.peerId;
    if(!peerId?.isUser()) return;
    const messageId = getServerMessageId(message.mid);
    if(!messageId) return;
    managers.appCrmManager.attributeOutboundMessage('' + peerId.toUserId(), messageId);
  };

  const refresh = debounce(() => {
    load(currentPeerId);
    loadAttributions(currentPeerId);
    loadSensitiveReveals(currentPeerId);
    loadNotes(currentPeerId);
  }, 800, false, true);

  const onNotePush = ({peerId, note}: {peerId: PeerId, note: CrmNote}) => {
    mergeNote(peerId, note);
  };

  const onChatMessage = (payload: MyMessage | {message: MyMessage}) => {
    const message = (payload as {message: MyMessage})?.message ?? (payload as MyMessage);
    if(message?.peerId && message.peerId === currentPeerId) refresh();
  };

  const onMessageSent = ({message}: {message: MyMessage}) => {
    if(message?._ !== 'message' || !message.pFlags?.out || message.peerId !== currentPeerId) return;
    maybeClaim(message.peerId);
    attributeOutbound(message);
  };

  const onAuthRequired = () => {
    if(!currentPeerId?.isUser()) return;
    setReconnectNeeded(true);
    setLoadState('idle');
    plate.setHidden(false);
  };

  const onConfigUpdate = () => {
    if(!currentPeerId?.isUser()) return;
    setReconnectNeeded(false);
    hide();
    load(currentPeerId);
    scheduleFollowUpLoad(currentPeerId);
    loadAttributions(currentPeerId);
    loadSensitiveReveals(currentPeerId);
    loadNotes(currentPeerId);
  };

  rootScope.addEventListener('history_multiappend', onChatMessage);
  rootScope.addEventListener('message_sent', onChatMessage);
  rootScope.addEventListener('message_sent', onMessageSent);
  rootScope.addEventListener('crm_auth_required', onAuthRequired);
  rootScope.addEventListener('crm_config_update', onConfigUpdate);
  rootScope.addEventListener('crm_note_push', onNotePush);

  const closeTicket = async() => {
    const current = ticket();
    if(!current || current.status !== 'open' || busy()) return;

    const peerId = currentPeerId;
    setBusy(true);
    try {
      await managers.appCrmManager.updateTicketStatus(current.id, 'closed');
      if(peerId !== currentPeerId) return;
      const event: CrmTicketEvent = {type: 'closed', at: new Date().toISOString()};
      apply(peerId, {...current, status: 'closed', events: [...(current.events || []), event]});
    } catch(err) {
      const status = (err as Error & {status?: number})?.status;
      toastNew({langPackKey: status === 403 ? 'Crm.Ticket.CloseForbidden' : 'Crm.Ticket.CloseFailed'});
      if(peerId === currentPeerId) load(peerId, 0, true);
    } finally {
      setBusy(false);
    }
  };

  return {
    ...plate,
    setPeerId,
    hide,
    getTicket: () => ticket(),
    close: () => closeTicket(),
    getNotes: () => notes(),
    hasTicketForNotes: () => notesTicketId != null || ticket()?.status === 'open',
    addNote,
    destroy: () => {
      rootScope.removeEventListener('history_multiappend', onChatMessage);
      rootScope.removeEventListener('message_sent', onChatMessage);
      rootScope.removeEventListener('message_sent', onMessageSent);
      rootScope.removeEventListener('crm_auth_required', onAuthRequired);
      rootScope.removeEventListener('crm_config_update', onConfigUpdate);
      rootScope.removeEventListener('crm_note_push', onNotePush);
      crmRealtime.leave();
      plate.destroy();
    }
  };
}
