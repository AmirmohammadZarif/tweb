import {createRoot, createSignal, createMemo, Accessor} from 'solid-js';
import rootScope from '@lib/rootScope';
import {CONTACT_INFO_MID} from '@lib/crm/types';
import useIsCrmSuperAdmin, {useCrmUserId, useIsCrmLoggedIn} from '@stores/crmRole';
import getServerMessageId from '@appManagers/utils/messageId/getServerMessageId';
import type {Message} from '@layer';

// Reactive mirror of the OPEN chat's sensitive-reveal grants, so UI outside the
// bubbles list (the peer profile's contact rows) can react to approvals too.
// Fed by the same events the crmTicket plate + bubbles use — the plate is the
// single source of `crm_sensitive_reveals_update` (REST backfill on chat open),
// and the Reverb push arrives as `crm_sensitive_reveal_push`. `approved` holds
// the server message ids (plus CONTACT_INFO_MID) revealed for THIS agent.
// `media` holds the server message ids whose image the CRM's analysis found an
// identity document, bank card or personal data in.
type RevealState = {peerId: PeerId, approved: Set<number>, media: Set<number>};
const EMPTY: RevealState = {peerId: NaN as PeerId, approved: new Set(), media: new Set()};

const [reveals, setReveals] = createRoot(() => createSignal<RevealState>(EMPTY));

rootScope.addEventListener('crm_sensitive_reveals_update', ({peerId, state}) => {
  setReveals({peerId, approved: new Set(state?.approved || []), media: new Set(state?.media || [])});
});

rootScope.addEventListener('crm_sensitive_reveal_push', ({peerId, messageId, userId}) => {
  const cur = reveals();
  if(peerId !== cur.peerId) return;
  const myId = useCrmUserId()();
  if(userId !== null && userId !== myId) return; // approval targeted another agent
  const approved = new Set(cur.approved);
  approved.add(messageId);
  setReveals({...cur, approved});
});

rootScope.addEventListener('crm_sensitive_media_push', ({peerId, messageId}) => {
  const cur = reveals();
  if(peerId !== cur.peerId) return;
  const media = new Set(cur.media);
  media.add(messageId);
  setReveals({...cur, media});
});

rootScope.addEventListener('crm_auth_required', () => setReveals(EMPTY));

/** Whether the given peer's contact info (phone/username) is revealed for this agent. */
export function useContactInfoApproved(peerId: PeerId): Accessor<boolean> {
  return createMemo(() => {
    const cur = reveals();
    return cur.peerId === peerId && cur.approved.has(CONTACT_INFO_MID);
  });
}

/**
 * Should this message's image be withheld from the current agent? True for a
 * customer's (inbound) image in the open 1:1 chat that the CRM flagged, until
 * this agent's reveal is approved. Superadmins are the approvers and never get
 * a lock. Unlike text, the image comes straight from Telegram rather than the
 * CRM, so this check is the only gate: every place that draws chat media asks it.
 */
export function isCrmMediaLocked(message: Message | undefined): boolean {
  if(!message || message._ !== 'message' || message.pFlags?.out) return false;
  if(!useIsCrmLoggedIn()() || useIsCrmSuperAdmin()()) return false;
  if(!message.peerId?.isUser()) return false;
  const cur = reveals();
  if(cur.peerId !== message.peerId) return false;
  const serverMid = getServerMessageId(message.mid);
  return !!serverMid && cur.media.has(serverMid) && !cur.approved.has(serverMid);
}
