import {createRoot, createSignal, createMemo, Accessor} from 'solid-js';
import rootScope from '@lib/rootScope';
import {CONTACT_INFO_MID} from '@lib/crm/types';
import {useCrmUserId} from '@stores/crmRole';

// Reactive mirror of the OPEN chat's sensitive-reveal grants, so UI outside the
// bubbles list (the peer profile's contact rows) can react to approvals too.
// Fed by the same events the crmTicket plate + bubbles use — the plate is the
// single source of `crm_sensitive_reveals_update` (REST backfill on chat open),
// and the Reverb push arrives as `crm_sensitive_reveal_push`. `approved` holds
// the server message ids (plus CONTACT_INFO_MID) revealed for THIS agent.
type RevealState = {peerId: PeerId, approved: Set<number>};
const EMPTY: RevealState = {peerId: NaN as PeerId, approved: new Set()};

const [reveals, setReveals] = createRoot(() => createSignal<RevealState>(EMPTY));

rootScope.addEventListener('crm_sensitive_reveals_update', ({peerId, state}) => {
  setReveals({peerId, approved: new Set(state?.approved || [])});
});

rootScope.addEventListener('crm_sensitive_reveal_push', ({peerId, messageId, userId}) => {
  const cur = reveals();
  if(peerId !== cur.peerId) return;
  const myId = useCrmUserId()();
  if(userId !== null && userId !== myId) return; // approval targeted another agent
  const approved = new Set(cur.approved);
  approved.add(messageId);
  setReveals({peerId, approved});
});

rootScope.addEventListener('crm_auth_required', () => setReveals(EMPTY));

/** Whether the given peer's contact info (phone/username) is revealed for this agent. */
export function useContactInfoApproved(peerId: PeerId): Accessor<boolean> {
  return createMemo(() => {
    const cur = reveals();
    return cur.peerId === peerId && cur.approved.has(CONTACT_INFO_MID);
  });
}
