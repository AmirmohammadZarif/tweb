import {PINNED_DIALOG_CLASS_NAME} from '@components/dialogsPinnedReorder';
import attachDialogFolderTags, {DialogFolderTags, DialogFolderTagsContext} from '@components/folderTags/dialogFolderTags';
import rootScope from '@lib/rootScope';
import type {ActiveAccountNumber} from '@lib/accounts/types';
import Button from '@components/button';
import SetTransition from '@components/singleTransition';
import liteMode from '@helpers/liteMode';
import sequentialDom from '@helpers/sequentialDom';
import Modes from '@config/modes';
import PeerTitle from '@components/peerTitle';
import I18n, {i18n} from '@lib/langPack';
import findUpTag from '@helpers/dom/findUpTag';
import crossfadeContent, {getCrossfadingTo, STATUS_CROSSFADE_DURATION} from '@helpers/dom/crossfadeContent';
import {TextHighlight} from '@helpers/dom/textHighlight';
import isInDOM from '@helpers/dom/isInDOM';
import {NULL_PEER_ID} from '@appManagers/constants';
import groupCallActiveIcon from '@components/groupCallActiveIcon';
import deferredPromise, {CancellablePromise} from '@helpers/cancellablePromise';
import middlewarePromise from '@helpers/middlewarePromise';
import cancelEvent from '@helpers/dom/cancelEvent';
import noop from '@helpers/noop';
import {getMiddleware, MiddlewareHelper} from '@helpers/middleware';
import {attachRowController, createRowSortableIcon, RowMediaSizeType, type RowTsxController} from '@components/rowTsxController'
import {avatarNew} from '@components/avatarNew';
import Icon from '@components/icon';
import {isForumTopic, isSavedDialog} from '@appManagers/utils/dialogs/isDialog';
import {ChatType} from '@components/chat/chatType';
import {BADGE_TRANSITION_TIME} from '@components/autonomousDialogList/constants';
import {setRollingText} from '@components/animatedCounter';
import {createUniqueId} from 'solid-js';

import {hotReloadGuard} from '@lib/solidjs/hotReloadGuardProvider';
import useIsCrmSuperAdmin from '@stores/crmRole';
import crmRealtime from '@lib/crm/crmRealtime';

export const DIALOG_LIST_ELEMENT_TAG = 'A';

export function findDialogListElement(target: EventTarget) {
  return findUpTag(target, DIALOG_LIST_ELEMENT_TAG);
}

export type DialogDom = {
  avatarEl: ReturnType<typeof avatarNew>,
  captionDiv: HTMLElement,
  titleSpan: HTMLSpanElement,
  titleSpanContainer: HTMLSpanElement,
  statusSpan: HTMLSpanElement,
  lastTimeSpan: HTMLSpanElement,
  /** the pill a pinned row's time stands in, with the pin in front of it */
  timePill?: HTMLElement,
  /** the grip a pinned row is dragged by while its list can be reordered */
  sortableIcon?: HTMLElement,
  unreadBadge?: HTMLElement,
  unreadAvatarBadge?: HTMLElement,
  callIcon?: ReturnType<typeof groupCallActiveIcon>,
  mentionsBadge?: HTMLElement,
  reactionsBadge?: HTMLElement,
  pollVotesBadge?: HTMLElement,
  crmTicketBadge?: HTMLElement,
  crmSeenTag?: HTMLElement,
  // Chat-list note preview: the element, the entry behind it, and the date of the
  // row's own last message — the note only takes the row over while it is newer.
  crmNoteLine?: HTMLElement,
  crmNote?: import('@lib/crm/types').CrmNoteSummaryEntry,
  crmLastMessageDate?: number,
  /** an unread incoming Gram transfer, in the mention's place */
  gramBadge?: HTMLElement,
  /** opens a bot's main mini app without opening the chat */
  botAppButton?: HTMLElement,
  lastMessageSpan: HTMLSpanElement,
  containerEl: HTMLElement,
  listEl: HTMLElement,
  subtitleEl: HTMLElement,
  mutedIcon?: HTMLElement,

  titleWrapOptions?: WrapSomethingOptions;

  /**
   * Signature of the last successfully rendered subtitle. Every dialog event
   * (read, mark unread, notify settings, filter update) runs the whole
   * `setLastMessage` pipeline, so without it the subtitle is torn down and
   * rebuilt — custom emoji, media thumbs and all — for updates that cannot
   * have changed a single character of it.
   */
  lastMessageRenderKey?: string,
  /**
   * The nodes that signature was rendered as. Plenty of other places
   * (community dialogs, search results, sidebar pickers) write their own
   * subtitle into `lastMessageSpan`, so a matching key alone does not mean the
   * rendered subtitle is still the one in the DOM.
   */
  lastMessageRenderParts?: HTMLElement[],
  /**
   * The lifetime of what the subtitle in the row wraps (the custom emoji of the text, a spoiler over
   * the media) - a child of the row's own, destroyed when another subtitle takes its place
   */
  subtitleMiddlewareHelper?: MiddlewareHelper,
  /** search-result rows: the query lit up inside the rendered message text */
  textHighlight?: TextHighlight,
  /**
   * The row shows an activity ("typing…", `setDialogTyping`) and the subtitle leaves it alone until
   * it is over. Not read off `user-typing`: the class only goes when the subtitle is rendered back
   * in, and that render can be cut short by the next dialog update - which would then see the class
   * and skip its own render too, leaving the row typing for good.
   */
  showsActivity?: boolean,

  setLastMessagePromise?: CancellablePromise<void>,
  setUnreadMessagePromise?: CancellablePromise<void>
};

export function setPromiseMiddleware<T extends {[smth in K as K]?: CancellablePromise<void>}, K extends keyof T>(obj: T, key: K) {
  const oldPromise: CancellablePromise<void> = obj[key] as any;
  oldPromise?.reject();

  // @ts-ignore
  const deferred = obj[key] = deferredPromise<void>();
  deferred.catch(() => {}).finally(() => {
    if((obj[key] as any) === deferred) {
      delete obj[key];
    }
  });

  const middleware = middlewarePromise(() => (obj[key] as any) === deferred);
  return {deferred, middleware};
}

export function disposeTextHighlight(dom: DialogDom) {
  dom.textHighlight?.dispose();
  dom.textHighlight = undefined;
}

/**
 * Puts the subtitle of a row in - crossfading from the activity it takes the place of, which
 * came in the same way (`setDialogTyping`)
 */
export function setDialogSubtitle(dom: DialogDom, nodes: Node[], middlewareHelper?: MiddlewareHelper) {
  dom.subtitleMiddlewareHelper?.destroy();
  dom.subtitleMiddlewareHelper = middlewareHelper;
  const {lastMessageSpan} = dom;
  const wasTyping = lastMessageSpan.classList.contains('user-typing');
  lastMessageSpan.classList.remove('user-typing');
  dom.showsActivity = false;
  crossfadeContent(
    lastMessageSpan,
    nodes,
    wasTyping ? 'crossfade' : 'update',
    wasTyping ? {duration: STATUS_CROSSFADE_DURATION} : undefined
  );
}

/**
 * Whether the subtitle in the DOM is still exactly what `setLastMessage` put
 * there — anyone else writing into `lastMessageSpan` (a community dialog
 * falling back to its chat count, a search result, a sidebar picker) has to
 * invalidate the skip.
 */
export function isRenderedSubtitleIntact(dom: DialogDom) {
  const parts = dom.lastMessageRenderParts;
  // * crossfading in, the parts are what it fades to (`setDialogSubtitle`)
  const childNodes = getCrossfadingTo(dom.lastMessageSpan) ?? dom.lastMessageSpan.childNodes;
  return !!parts &&
    parts.length === childNodes.length &&
    parts.every((part, idx) => part === childNodes[idx]);
}

export function getFolderTitleTextColor(active: boolean) {
  return active ? 'primary-color' : 'secondary-text-color';
}

const BADGE_SIZE = 22;

/**
 * Render (or clear) a row's internal-note preview.
 *
 * A note only takes over the row's message line while it is NEWER than the row's
 * own last message. That is the whole rule, and it is what makes the note read as
 * an UPDATE — the newest thing that happened in this conversation — instead of a
 * permanent label that would hide real messages forever. Once the customer or an
 * agent writes after the note, the row goes back to the message preview and the
 * note stays where it belongs: inline in the chat and in the profile's Notes tab.
 *
 * Called from two places, which is why it lives here rather than on the element:
 * the note cache updating (DialogElement.setCrmNote) and the last message being
 * re-rendered (setLastMessage), because either side can flip the comparison.
 */
export function applyCrmNotePreview(dom: DialogDom) {
  const entry = dom?.crmNote;
  const at = entry?.created_at ? Math.floor(new Date(entry.created_at).getTime() / 1000) : 0;
  const show = !!entry && !!at && at >= (dom.crmLastMessageDate || 0);

  if(!show) {
    dom.crmNoteLine?.remove();
    dom.crmNoteLine = undefined;
    dom.subtitleEl.classList.remove('has-crm-note-preview');
    return;
  }

  if(!dom.crmNoteLine) {
    const line = dom.crmNoteLine = document.createElement('div');
    line.className = 'dialog-subtitle-note';
    line.append(Icon('clipboard', 'dialog-subtitle-note-icon'), document.createElement('span'));
    dom.subtitleEl.append(line);
  }

  const text = `${entry.author_name}: ${entry.text || ''}`;
  dom.crmNoteLine.lastElementChild.textContent = text;
  dom.crmNoteLine.title = text;
  dom.crmNoteLine.classList.toggle('is-foreign', !!entry.is_foreign);
  // The message line is hidden by CSS rather than emptied: whatever rebuilds it
  // (new message, typing, draft) must not have to know this preview exists.
  dom.subtitleEl.classList.add('has-crm-note-preview');
}


export const DIALOG_AVATAR_SIZES: {[k in DialogElementSize]?: number} = {
  bigger: 54,
  abitbigger: 42,
  small: 32
};

export type DialogElementSize = RowMediaSizeType;
export type AsAllChatsType = 'monoforum' | 'topics';

export type DialogElementOptions = {
  peerId: PeerId,
  rippleEnabled?: boolean,
  onlyFirstName?: boolean,
  meAsSaved?: boolean,
  avatarSize?: RowMediaSizeType,
  autonomous?: boolean,
  loadPromises?: Promise<any>[],
  fromName?: string,
  noIcons?: boolean,
  threadId?: number,
  monoforumParentPeerId?: PeerId,
  wrapOptions: WrapSomethingOptions,
  isMainList?: boolean,
  withStories?: boolean,
  controlled?: boolean,
  dontSetActive?: boolean,
  asAllChats?: AsAllChatsType,
  autoDeletePeriod?: number,
  avatarElement?: HTMLElement,
  /** the row is in a folder's chat list, and wears the tags of the other folders its chat is in */
  folderTags?: DialogFolderTagsContext,
  /** the peer's account, when the tab may show another one meanwhile (a call's participants) */
  accountNumber?: ActiveAccountNumber
};

export type DialogElementBadgeState = {
  muted: boolean,
  pinned: boolean,
  unread: boolean,
  unreadText?: string,
  /** the count `unreadText` stands for - tells which way a changed one rolls */
  unreadCount?: number,
  unreadMention?: boolean,
  unreadAvatar: boolean,
  unreadAvatarText?: string,
  mentions: boolean,
  reactions: boolean,
  pollVotes: boolean,
  gram?: boolean,
  botApp?: boolean,
  transitionDuration?: number
};

type DialogElementBadgeKey = Parameters<DialogElement['toggleBadgeByKey']>[0];
/** the badges that stand in the subtitle, one after another - the avatar's stands on the avatar */
type DialogElementSubtitleBadgeKey = Exclude<DialogElementBadgeKey, 'unreadAvatarBadge'>;

type DialogElementAppliedBadgeState = {
  [key in DialogElementBadgeKey]: boolean
} & {
  unreadText?: string,
  unreadCount?: number,
  unreadMention?: boolean,
  unreadAvatarText?: string
};

export interface DialogElement extends RowTsxController {}

export class DialogElement {
  public dom: DialogDom;
  public isMainList: boolean;
  /** what the row last saw of its bot's main mini app - `user_update` redraws it on a change */
  public hasBotMainApp: boolean;
  public middlewareHelper: MiddlewareHelper;
  private onCrmOpenTicketsUpdate?: () => void;
  private onCrmTicketUpdate?: (payload: {peerId: PeerId}) => void;
  private onCrmFirstSeenSummaryUpdate?: (payload: {peerIds: PeerId[]}) => void;
  private onCrmFirstSeenPush?: (payload: {peerId: PeerId}) => void;
  private onCrmNotesSummaryUpdate?: (payload: {peerIds: PeerId[]}) => void;
  private onCrmNotePush?: (payload: {peerId: PeerId}) => void;
  public folderTags?: DialogFolderTags;
  private peerTitle: PeerTitle;
  /** the badges that come in, or back, once the leaving ones are lifted (`holdBadgesInPlace`) */
  private waitingBadges: Set<HTMLElement>;
  /** the lifts that wait for their frame (`holdBadgesInPlace`) */
  private pendingHolds: number;
  private lastBadgeState: DialogElementAppliedBadgeState;

  constructor({
    peerId,
    rippleEnabled = true,
    onlyFirstName = false,
    meAsSaved = true,
    avatarSize = 'bigger',
    autonomous,
    loadPromises,
    fromName,
    noIcons,
    threadId,
    monoforumParentPeerId,
    wrapOptions = {},
    isMainList,
    withStories,
    controlled,
    dontSetActive,
    asAllChats,
    autoDeletePeriod,
    avatarElement,
    folderTags,
    accountNumber
  }: DialogElementOptions) {
    const wrapMiddleware = wrapOptions?.middleware;
    this.middlewareHelper = wrapMiddleware ? wrapOptions.middleware.create() : (controlled ? getMiddleware() : undefined);

    attachRowController(this, {
      clickable: true,
      noRipple: !rippleEnabled,
      havePadding: !threadId && asAllChats !== 'topics',
      title: true,
      titleRightSecondary: true,
      subtitle: true,
      subtitleRight: true,
      noWrap: true,
      asLink: true,
      middleware: this.middlewareHelper?.get()
    });

    this.isMainList = isMainList;
    this.subtitleRight.remove();

    const newWrapOptions: WrapSomethingOptions = {
      ...wrapOptions
    };

    if(this.middlewareHelper) {
      newWrapOptions.middleware = this.middlewareHelper.get();
    }

    const isSavedDialog = !!threadId && peerId === rootScope.myId;
    const isForumTopic = !!threadId && !isSavedDialog;

    const usePeerId = isSavedDialog ? threadId : peerId;

    const avatar = avatarElement || isForumTopic || asAllChats === 'topics' ?
      undefined :
      avatarNew({
        middleware: this.middlewareHelper.get(),
        size: DIALOG_AVATAR_SIZES[avatarSize],

        lazyLoadQueue: newWrapOptions.lazyLoadQueue,
        isDialog: !!meAsSaved,
        peerId: fromName ? NULL_PEER_ID : usePeerId,
        peerTitle: fromName,
        withStories,
        // Animate video avatars only in the primary chat list (withStories), not
        // in compact pickers / search rows.
        withVideoAvatar: withStories,
        wrapOptions: newWrapOptions,
        meAsNotes: isSavedDialog,
        asAllChats: asAllChats === 'monoforum',
        autoDeletePeriod,
        accountNumber
      });
    loadPromises?.push(avatar?.readyThumbPromise);
    const avatarEl = avatarElement || avatar?.node;
    if(avatarEl) {
      avatarEl.classList.add('dialog-avatar');
      this.applyMediaElement(avatarEl, avatarSize);
    }

    const captionDiv = this.container;

    const titleSpanContainer = this.title;
    titleSpanContainer.classList.add('user-title');

    this.titleRow.classList.add('dialog-title');

    const isActive = !dontSetActive && !autonomous &&
      hotReloadGuard.appImManager.chat &&
      hotReloadGuard.appImManager.isSamePeer(hotReloadGuard.appImManager.chat, {
        peerId: monoforumParentPeerId || peerId,
        monoforumThreadId: monoforumParentPeerId ? peerId : undefined,
        threadId: threadId,
        type: isSavedDialog ? ChatType.Saved : ChatType.Chat
      });

    const titleWrapOptions: WrapSomethingOptions = {
      textColor: hotReloadGuard.appDialogsManager.getTextColor(isActive),
      ...newWrapOptions
    };

    const peerTitle = this.peerTitle = new PeerTitle();
    const peerTitlePromise = peerTitle.update({
      peerId: usePeerId,
      fromName,
      dialog: meAsSaved,
      onlyFirstName,
      withIcons: !noIcons,
      threadId: isSavedDialog ? undefined : threadId,
      wrapOptions: titleWrapOptions,
      iconsColor: hotReloadGuard.appDialogsManager.getPrimaryColor(isActive),
      meAsNotes: isSavedDialog,
      asAllChats,
      accountNumber
    });

    loadPromises?.push(peerTitlePromise);
    titleSpanContainer.append(peerTitle.element);

    // const titleIconsPromise = generateTitleIcons(peerId).then((elements) => {
    //   titleSpanContainer.append(...elements);
    // });

    // if(loadPromises) {
    //   loadPromises.push(titleIconsPromise);
    // }
    // }

    const span = this.subtitle;
    // span.classList.add('user-last-message');

    const li = this.container;
    li.classList.add('chatlist-chat', 'chatlist-chat-' + avatarSize);
    if(!autonomous) {
      // Don't leak customer user ids through the anchor href (visible in the
      // status bar on hover / "copy link address") — CRM superadmins keep the
      // deep link. Navigation itself uses dataset.peerId, not the href.
      (li as HTMLAnchorElement).href = !peerId.isUser() || useIsCrmSuperAdmin()() ? '#' + peerId : '#';
    }
    // if(rippleEnabled) {
    //   ripple(li);
    // }

    if(avatarSize === 'bigger') {
      this.container.classList.add('row-big');
    } else if(avatarSize === 'small') {
      this.container.classList.add('row-small');
    }

    li.dataset.peerId = '' + peerId;

    if(threadId) li.dataset.threadId = '' + threadId;
    if(monoforumParentPeerId) li.dataset.monoforumParentPeerId = '' + monoforumParentPeerId;
    if(asAllChats) li.dataset.isAllChats = 'true';

    const statusSpan = document.createElement('span');
    statusSpan.classList.add('message-status', 'sending-status'/* , 'transition', 'reveal' */);

    const lastTimeSpan = document.createElement('span');
    lastTimeSpan.classList.add('message-time');

    const rightSpan = this.titleRight;
    rightSpan.classList.add('dialog-title-details');
    rightSpan.append(statusSpan, lastTimeSpan);

    this.subtitleRow.classList.add('dialog-subtitle');

    // if(I18n.isRTL) {
    //   // this.subtitle.dir = '';
    //   // this.subtitle.dir = 'rtl';
    // }

    const dom: DialogDom = this.dom = {
      avatarEl: avatar,
      captionDiv,
      titleSpan: peerTitle.element,
      titleSpanContainer,
      statusSpan,
      lastTimeSpan,
      lastMessageSpan: span,
      containerEl: li,
      listEl: li,
      subtitleEl: this.subtitleRow,
      titleWrapOptions
    };

    if(folderTags && this.middlewareHelper) {
      this.folderTags = attachDialogFolderTags({
        listEl: li,
        after: this.subtitleRow,
        context: folderTags,
        middleware: this.middlewareHelper.get()
      });
    }

    // this will never happen for migrated legacy chat
    if(!autonomous) {
      (li as any).dialogDom = dom;

      if(isMainList && !asAllChats && hotReloadGuard.appDialogsManager.forumTab?.peerId === peerId && !threadId) {
        li.classList.add('is-forum-open');
      }
    }

    if(isActive) {
      hotReloadGuard.appDialogsManager.setDialogActive(li, true);
    }

    if(peerId.isUser()) {
      const refreshCrmTicketStatus = () => {
        Promise.resolve(rootScope.managers.appCrmManager.getTicketStatusCached(peerId))
        .then((status) => this.setCrmTicketStatus(status));
      };
      refreshCrmTicketStatus();
      this.onCrmOpenTicketsUpdate = refreshCrmTicketStatus;
      this.onCrmTicketUpdate = ({peerId: updatedPeerId}) => {
        if(updatedPeerId === peerId) {
          refreshCrmTicketStatus();
        }
      };
      rootScope.addEventListener('crm_open_tickets_update', this.onCrmOpenTicketsUpdate);
      rootScope.addEventListener('crm_ticket_update', this.onCrmTicketUpdate as any);

      // Who picked this conversation up: the agent who saw its newest customer
      // message first. The request is pooled manager-side (one call per batch of
      // rows, TTL'd), so a scrolling chatlist doesn't fan out into a request per row.
      const refreshCrmFirstSeen = () => {
        Promise.resolve(rootScope.managers.appCrmManager.getFirstSeenCached(peerId))
        .then((entry) => this.setCrmFirstSeen(entry));
      };
      rootScope.managers.appCrmManager.requestFirstSeenForPeers([peerId]);
      refreshCrmFirstSeen();

      this.onCrmFirstSeenSummaryUpdate = ({peerIds}) => {
        if(peerIds?.includes(peerId)) refreshCrmFirstSeen();
      };
      // A colleague read a message in this chat right now — their session reported
      // it, so re-pull this row's entry instead of waiting out the cache TTL.
      this.onCrmFirstSeenPush = ({peerId: pushedPeerId}) => {
        if(pushedPeerId === peerId) {
          rootScope.managers.appCrmManager.requestFirstSeenForPeers([peerId], true);
        }
      };
      rootScope.addEventListener('crm_first_seen_summary_update', this.onCrmFirstSeenSummaryUpdate);
      rootScope.addEventListener('crm_first_seen_push', this.onCrmFirstSeenPush as any);

      // A colleague's internal note, shown in the row like any other update. Pooled
      // manager-side exactly like first-seen, so a scrolling chatlist is one request
      // per batch. Unlike the open chat there is no per-peer channel for a chat
      // nobody has open, so these rows go live on the summary's TTL.
      const refreshCrmNote = () => {
        Promise.resolve(rootScope.managers.appCrmManager.getLatestNoteCached(peerId))
        .then((entry) => this.setCrmNote(entry));
      };
      rootScope.managers.appCrmManager.requestLatestNotesForPeers([peerId]);
      refreshCrmNote();
      // The chat list is the department feed's main consumer, and it is the only
      // part of the app that exists before any chat is opened — so it is what
      // brings the feed up. Idempotent and synchronous once subscribed.
      crmRealtime.ensureNotesFeed();

      this.onCrmNotesSummaryUpdate = ({peerIds}) => {
        if(peerIds?.includes(peerId)) refreshCrmNote();
      };
      // Somebody added / edited / removed a note in this chat right now (it is the
      // open one) — re-pull instead of waiting out the cache TTL.
      this.onCrmNotePush = ({peerId: pushedPeerId}) => {
        if(pushedPeerId === peerId) {
          rootScope.managers.appCrmManager.requestLatestNotesForPeers([peerId], true);
        }
      };
      rootScope.addEventListener('crm_notes_summary_update', this.onCrmNotesSummaryUpdate);
      rootScope.addEventListener('crm_note_push', this.onCrmNotePush as any);
      rootScope.addEventListener('crm_note_delete_push', this.onCrmNotePush as any);
    }
  }

  /**
   * Chat-list note preview. The note takes over the row's message line only while
   * it is NEWER than the last message — that is what makes it read as an update
   * rather than a permanent label, and it stops a note from hiding real
   * conversation forever. See applyCrmNotePreview.
   */
  public setCrmNote(entry?: import('@lib/crm/types').CrmNoteSummaryEntry) {
    this.dom.crmNote = entry;
    applyCrmNotePreview(this.dom);
  }

  /** Chatlist label: "👁 <agent>" for the newest customer message with a viewer. */
  public setCrmFirstSeen(entry?: {name?: string}) {
    if(!entry?.name) {
      this.dom.crmSeenTag?.remove();
      this.dom.crmSeenTag = undefined;
      return;
    }

    if(!this.dom.crmSeenTag) {
      // Deliberately NOT a `dialog-subtitle-badge`: that class starts at scale(0)
      // and is revealed by the badge-toggle machinery (toggleBadgeByKey), which
      // this label doesn't go through.
      const tag = this.dom.crmSeenTag = document.createElement('div');
      tag.className = 'dialog-subtitle-seen-tag';
      tag.append(Icon('eye1_filled', 'dialog-subtitle-seen-tag-icon'), document.createElement('span'));
      this.dom.subtitleEl.append(tag);
    }

    this.dom.crmSeenTag.lastElementChild.textContent = entry.name;
    this.dom.crmSeenTag.title = i18n('Crm.SeenFirstBy', [entry.name]).textContent;
  }

  public setCrmTicketStatus(status?: string) {
    if(!status) {
      this.dom.crmTicketBadge?.remove();
      this.dom.crmTicketBadge = undefined;
      return;
    }

    if(!this.dom.crmTicketBadge) {
      const badge = this.dom.crmTicketBadge = document.createElement('div');
      badge.className = 'dialog-subtitle-badge badge badge-20 dialog-subtitle-badge-crm-ticket';
      this.dom.subtitleEl.append(badge);
    }

    this.dom.crmTicketBadge.textContent = status;
    this.dom.crmTicketBadge.dataset.status = status;
  }

  public destroy() {
    if(this.onCrmOpenTicketsUpdate) {
      rootScope.removeEventListener('crm_open_tickets_update', this.onCrmOpenTicketsUpdate);
      this.onCrmOpenTicketsUpdate = undefined;
    }
    if(this.onCrmTicketUpdate) {
      rootScope.removeEventListener('crm_ticket_update', this.onCrmTicketUpdate as any);
      this.onCrmTicketUpdate = undefined;
    }
    if(this.onCrmFirstSeenSummaryUpdate) {
      rootScope.removeEventListener('crm_first_seen_summary_update', this.onCrmFirstSeenSummaryUpdate);
      this.onCrmFirstSeenSummaryUpdate = undefined;
    }
    if(this.onCrmFirstSeenPush) {
      rootScope.removeEventListener('crm_first_seen_push', this.onCrmFirstSeenPush as any);
      this.onCrmFirstSeenPush = undefined;
    }
    if(this.onCrmNotesSummaryUpdate) {
      rootScope.removeEventListener('crm_notes_summary_update', this.onCrmNotesSummaryUpdate);
      this.onCrmNotesSummaryUpdate = undefined;
    }
    if(this.onCrmNotePush) {
      rootScope.removeEventListener('crm_note_push', this.onCrmNotePush as any);
      rootScope.removeEventListener('crm_note_delete_push', this.onCrmNotePush as any);
      this.onCrmNotePush = undefined;
    }
    this.dispose();
    this.middlewareHelper?.destroy();
    disposeTextHighlight(this.dom);
  }

  public updateTitle(fromName: string) {
    return this.peerTitle.update({fromName});
  }

  public remove() {
    this.destroy();
    this.dom.listEl.remove();
  }

  public setMuted(isMuted: boolean, transitionDuration = 0) {
    const {dom} = this;
    const wasMuted = dom.listEl.classList.contains('is-muted') &&
      !dom.listEl.classList.contains('backwards');
    if(isMuted === wasMuted) {
      return;
    }

    if(isMuted && !dom.mutedIcon) {
      dom.mutedIcon = Icon('nosound_filled', 'dialog-muted-icon');
      dom.titleSpanContainer.append(dom.mutedIcon);
    }

    SetTransition({
      element: dom.listEl,
      className: 'is-muted',
      forwards: isMuted,
      duration: transitionDuration,
      onTransitionEnd: !isMuted ? (() => {
        dom.mutedIcon?.remove();
        delete dom.mutedIcon;
      }) : undefined
    });
  }

  /**
   * The pill a pinned row's time stands in, with the pin in front of it: drawn only while the row
   * is pinned, and kept once made, as the grip is. The time itself is rewritten by several hands
   * (the last message, search, a community row), so the pin stays out of it
   */
  public createTimePill() {
    if(this.dom.timePill) return;
    const {lastTimeSpan} = this.dom;
    const pill = this.dom.timePill = document.createElement('span');
    pill.className = 'dialog-time-pill';
    lastTimeSpan.replaceWith(pill);
    pill.append(Icon('pin_status_filled', 'dialog-time-pill-pin'), lastTimeSpan);
  }

  /** The grip a pinned row is dragged by, shown only while its list can be reordered */
  public createSortableIcon() {
    if(this.dom.sortableIcon) return;
    const icon = this.dom.sortableIcon = createRowSortableIcon();
    this.dom.listEl.append(icon);
  }

  public createUnreadBadge() {
    if(this.dom.unreadBadge) return;
    const badge = this.dom.unreadBadge = document.createElement('div');
    badge.className = `dialog-subtitle-badge badge badge-${BADGE_SIZE} dialog-subtitle-badge-unread`;
    this.dom.subtitleEl.append(badge);
  }

  public createUnreadAvatarBadge() {
    if(this.dom.unreadAvatarBadge) return;
    const badge = this.dom.unreadAvatarBadge = document.createElement('div');
    badge.className = `dialog-subtitle-badge badge badge-${BADGE_SIZE} avatar-badge`;
    this.dom.listEl.append(badge);
  }

  public createMentionsBadge() {
    if(this.dom.mentionsBadge) return;
    const badge = this.dom.mentionsBadge = document.createElement('div');
    badge.className = `dialog-subtitle-badge badge badge-${BADGE_SIZE} mention mention-badge dialog-subtitle-badge-mention`;
    badge.innerText = '@';
    this.dom.subtitleEl.append(badge);
  }

  public createReactionsBadge() {
    if(this.dom.reactionsBadge) return;
    const badge = this.dom.reactionsBadge = document.createElement('div');
    badge.className = `dialog-subtitle-badge badge badge-${BADGE_SIZE} reaction-badge dialog-subtitle-badge-reaction`;
    badge.append(Icon('reactions_filled'));
    this.dom.subtitleEl.append(badge);
  }

  // * the gem on the unread colour, as iOS marks a chat whose last message is a transfer not read yet
  public createGramBadge() {
    if(this.dom.gramBadge) return;
    const badge = this.dom.gramBadge = document.createElement('div');
    badge.className = `dialog-subtitle-badge badge badge-${BADGE_SIZE} dialog-subtitle-badge-gram`;
    // * it stands for the unread count too: a screen reader hears what the gem says
    const label = i18n('Wallet.ChatList.UnreadTransfer');
    label.classList.add('sr-only');
    badge.append(Icon('gram_filled'), label);
    this.dom.subtitleEl.append(badge);
  }

  public createPollVotesBadge() {
    if(this.dom.pollVotesBadge) return;
    const badge = this.dom.pollVotesBadge = document.createElement('div');
    badge.className = `dialog-subtitle-badge badge badge-${BADGE_SIZE} poll-vote-badge dialog-subtitle-badge-pollvote`;
    badge.append(Icon('poll'));
    this.dom.subtitleEl.append(badge);
  }

  public createBotAppButton() {
    if(this.dom.botAppButton) return;
    const button = this.dom.botAppButton = Button(
      `dialog-subtitle-badge badge badge-${BADGE_SIZE} btn-color-primary dialog-subtitle-badge-bot-app`,
      {text: 'Open', noRipple: true, asDiv: !Modes.a11y}
    );
    // * every such button says "Open" - it is the bot's name that tells them apart
    const {titleSpan} = this.dom;
    titleSpan.id ||= createUniqueId();
    button.setAttribute('aria-describedby', titleSpan.id);
    // * the list opens the chat on a press anywhere in the row (setListClickListener), but not on this
    button.dataset.dialogListAction = 'true';
    button.addEventListener('click', (e) => {
      cancelEvent(e); // * the row is a link
      const peerId = this.dom.listEl.dataset.peerId.toPeerId();
      // * turning the confirmation down rejects, and leaves nothing to do
      hotReloadGuard.appImManager.openWebApp({botId: peerId.toUserId(), main: true, peerId}).catch(noop);
    });
    this.dom.subtitleEl.append(button);
  }

  public setBadgeState(options: DialogElementBadgeState) {
    const transitionDuration = options.transitionDuration || 0;
    this.setMuted(options.muted, transitionDuration);

    const previous = this.lastBadgeState;
    const botApp = !!options.botApp;

    // * `toggleBadgeByKey` writes what it toggles into the very state `previous` is
    const wasVisible = {
      unreadBadge: !!previous?.unreadBadge,
      unreadAvatarBadge: !!previous?.unreadAvatarBadge
    };

    const mounted = {
      unreadBadge: !!this.dom.unreadBadge,
      unreadAvatarBadge: !!this.dom.unreadAvatarBadge,
      mentionsBadge: !!this.dom.mentionsBadge,
      reactionsBadge: !!this.dom.reactionsBadge,
      pollVotesBadge: !!this.dom.pollVotesBadge,
      gramBadge: !!this.dom.gramBadge,
      botAppButton: !!this.dom.botAppButton
    };

    const states: Array<[DialogElementBadgeKey, boolean]> = [
      ['unreadBadge', options.unread],
      ['unreadAvatarBadge', options.unreadAvatar],
      ['mentionsBadge', options.mentions],
      ['reactionsBadge', options.reactions],
      ['pollVotesBadge', options.pollVotes],
      ['gramBadge', !!options.gram],
      ['botAppButton', botApp]
    ];

    // * a badge leaves the subtitle from where it stands, out of its flow (`holdBadgesInPlace`)
    const leaving = transitionDuration && previous && liteMode.isAvailable('animations') ? states
    .filter(([key, visible]) => key !== 'unreadAvatarBadge' && !visible && previous[key] && this.dom[key])
    .map(([key]) => key as DialogElementSubtitleBadgeKey) : [];

    // * the pinned rows of a list form the block that can be reordered within itself, and
    // * `Sortable` reads that block off the DOM - see attachPinnedDialogsReorder. The class is what
    // * shows a row pinned too: its time is a pill with a pin (`createTimePill`)
    this.dom.listEl.classList.toggle(PINNED_DIALOG_CLASS_NAME, !!options.pinned);

    if(options.pinned) {
      this.createSortableIcon();
      this.createTimePill();
    }
    if(options.unread) this.createUnreadBadge();
    if(options.unreadAvatar) this.createUnreadAvatarBadge();
    if(options.mentions) this.createMentionsBadge();
    if(options.reactions) this.createReactionsBadge();
    if(options.pollVotes) this.createPollVotesBadge();
    if(options.gram) this.createGramBadge();
    if(botApp) this.createBotAppButton();

    // * one made just now goes in, and so do one that waited out of the row and was sent away before
    // * it came in, and one called back on its way out (`holdBadgesInPlace`) - where badges leave, or
    // * wait to be lifted since an earlier call, only once they are lifted, as one laid out now would
    // * push them aside (the bot's button and the badges take turns in one place): till then the new
    // * one waits out of the row, the one called back where it is held
    const coming = states
    .filter(([key, visible]) => {
      const badge = this.dom[key];
      return key !== 'unreadAvatarBadge' && visible && badge &&
        (!mounted[key] || !badge.parentElement || badge.classList.contains('is-held-in-place'));
    })
    .map(([key]) => ({key: key as DialogElementSubtitleBadgeKey, badge: this.dom[key]}));
    if(leaving.length || (this.pendingHolds && coming.length)) {
      coming.forEach(({badge}) => badge.classList.contains('is-held-in-place') || badge.remove());
      this.holdBadgesInPlace(leaving, coming);
    } else {
      for(const {badge} of coming) {
        if(!badge.parentElement && !this.waitingBadges?.has(badge)) {
          this.subtitleRow.append(badge);
        }
      }
    }

    for(const [key, visible] of states) {
      if(!this.dom[key]) {
        continue;
      }

      // an already mounted badge that keeps its visibility needs no transition
      if(mounted[key] && previous?.[key] === visible) {
        continue;
      }

      this.toggleBadgeByKey(key, visible, mounted[key], !transitionDuration);
    }

    // * a count that changes on a badge already in sight rolls to the new one, character by
    // * character, as it does in the official apps; one that comes in with its badge does not,
    // * nor does the `@` of a mention, whose badge is cut differently (`.mention`) and would
    // * swell on its way to a number
    const unreadDirection = (options.unreadCount ?? 0) - (previous?.unreadCount ?? 0);
    const rollUnread = !!transitionDuration && !!previous && !previous.unreadMention === !options.unreadMention;
    const setUnreadText = (key: 'unreadBadge' | 'unreadAvatarBadge', text: string) => {
      setRollingText({
        element: this.dom[key],
        text,
        direction: unreadDirection,
        animate: rollUnread && mounted[key] && wasVisible[key]
      });
    };

    if(options.unread && this.dom.unreadBadge) {
      if(options.unreadText !== undefined && options.unreadText !== previous?.unreadText) {
        setUnreadText('unreadBadge', options.unreadText);
        if(this.dom.unreadAvatarBadge) {
          setUnreadText('unreadAvatarBadge', options.unreadText);
        }
      }
      this.dom.unreadBadge.classList.add('unread');
      this.dom.unreadBadge.classList.toggle('mention', !!options.unreadMention);
    }

    if(options.unreadAvatar && this.dom.unreadAvatarBadge) {
      if(options.unreadAvatarText !== undefined && options.unreadAvatarText !== previous?.unreadAvatarText) {
        setUnreadText('unreadAvatarBadge', options.unreadAvatarText);
      }
      this.dom.unreadAvatarBadge.classList.add('unread');
      this.dom.unreadAvatarBadge.classList.toggle('mention', !!options.unreadMention);
    }

    this.lastBadgeState = {
      unreadBadge: options.unread,
      unreadAvatarBadge: options.unreadAvatar,
      mentionsBadge: options.mentions,
      reactionsBadge: options.reactions,
      pollVotesBadge: options.pollVotes,
      gramBadge: !!options.gram,
      botAppButton: botApp,
      unreadText: options.unreadText,
      unreadCount: options.unreadCount,
      unreadMention: options.unreadMention,
      unreadAvatarText: options.unreadAvatarText
    };
  }

  /** what the unread badge says - its DOM holds the plain text only while the count stands still */
  public get unreadText() {
    return this.lastBadgeState?.unreadText;
  }

  /**
   * Lifts the leaving badges out of the subtitle's flow, each where it stands: the message takes the
   * room they leave as they start going and comes out from under them, as in the mobile apps, rather
   * than widening in one step once they are gone. Their places are read with the other rows' reads,
   * before anything is written (`sequentialDom`) - a whole folder read at once lets go of many badges
   * in one task - and the badges `coming` in their place, or back, go in (or out of their hold) only then
   */
  private holdBadgesInPlace(
    keys: DialogElementSubtitleBadgeKey[],
    coming: {key: DialogElementSubtitleBadgeKey, badge: HTMLElement}[]
  ) {
    const row = this.subtitleRow;
    // * one called back meanwhile stays where it is, and one sent away meanwhile does not come
    const isStill = ({key, badge}: typeof coming[0], shown: boolean) => {
      return this.dom[key] === badge && !!this.lastBadgeState?.[key] === shown;
    };

    const waiting = this.waitingBadges ??= new Set();
    coming.forEach(({badge}) => waiting.add(badge));
    this.pendingHolds = (this.pendingHolds || 0) + 1;

    const leaving = keys.map((key) => ({key, badge: this.dom[key]}));
    let places: {badge: HTMLElement, top: number, inlineEnd: number}[] = [];
    sequentialDom.measure(() => {
      if(!row.isConnected) {
        return;
      }

      // * all measured before any is lifted, as lifting one moves the rest; one with no box to measure
      // * (a row out of sight - the subtitle of a collapsed list) just goes
      const isRTL = I18n.getIsRTL();
      const width = row.clientWidth;
      places = leaving.filter((badge) => {
        return isStill(badge, false) && badge.badge.parentElement === row && !!badge.badge.offsetParent;
      }).map(({badge}) => ({
        badge,
        top: badge.offsetTop,
        inlineEnd: isRTL ? badge.offsetLeft : width - badge.offsetLeft - badge.offsetWidth
      }));
    });

    sequentialDom.mutate(() => {
      --this.pendingHolds;
      for(const {badge, top, inlineEnd} of places) {
        badge.style.setProperty('--held-top', top + 'px');
        badge.style.setProperty('--held-inline-end', inlineEnd + 'px');
        badge.classList.add('is-held-in-place');
      }

      for(const badge of coming) {
        waiting.delete(badge.badge);
        if(isStill(badge, true)) {
          badge.badge.classList.remove('is-held-in-place');
          if(badge.badge.parentElement !== row) {
            row.append(badge.badge);
          }
        }
      }
    });
  }

  public toggleBadgeByKey(
    key: Extract<keyof DialogDom, 'unreadBadge' | 'unreadAvatarBadge' | 'mentionsBadge' | 'reactionsBadge' | 'pollVotesBadge' | 'gramBadge' | 'botAppButton'>,
    hasBadge: boolean,
    justCreated: boolean,
    batch?: boolean
  ) {
    // * `setBadgeState` skips a badge whose visibility `lastBadgeState` says is unchanged, so
    // * out-of-band toggles (`toggleAvatarUnreadBadges` on sidebar collapse / forum tab) must
    // * keep it in sync — otherwise reading the last unread topic can't hide the avatar badge
    if(this.lastBadgeState) {
      this.lastBadgeState[key] = hasBadge;
    }

    // * called back before it was gone - unless it waits for the leaving ones to be lifted first
    if(hasBadge && !this.waitingBadges?.has(this.dom[key])) {
      this.dom[key].classList.remove('is-held-in-place');
    }

    SetTransition({
      element: this.dom[key],
      className: 'is-visible',
      forwards: hasBadge,
      duration: batch ? 0 : BADGE_TRANSITION_TIME,
      onTransitionEnd: hasBadge ? undefined : () => {
        this.dom[key].remove();
        delete this.dom[key];
      },
      useRafs: !justCreated || !isInDOM(this.dom[key]) ? 2 : 0
    });
  }
}


