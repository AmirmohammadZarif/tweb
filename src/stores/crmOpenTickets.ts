import {createRoot, createSignal} from 'solid-js';
import rootScope from '@lib/rootScope';

// UI-side mirror of the worker's open-ticket peer set (AppCrmManager keeps the
// authoritative copy). It exists because `AutonomousDialogList.testDialogForFilter`
// must answer SYNCHRONOUSLY — every manager call is an async worker proxy, so
// asking `appCrmManager.hasOpenTicketForPeer()` there returns a Promise, which is
// always truthy and silently lets every private chat into the Open Tickets folder.
//
// Kept fresh by the same two events the folder badge listens to, plus a direct
// seed from the folder's dialogsFetcher (the fetcher's manager call resolves
// before its `crm_open_tickets_update` reaches the UI thread, so seeding from
// the result closes that gap instead of racing it).
const [openTicketPeerIds, setOpenTicketPeerIds] = createRoot(() => createSignal<ReadonlySet<PeerId>>(new Set()));

export function setCrmOpenTicketPeerIds(peerIds: PeerId[]) {
  setOpenTicketPeerIds(new Set(peerIds));
}

export function hasCrmOpenTicket(peerId: PeerId) {
  return openTicketPeerIds().has(peerId);
}

rootScope.addEventListener('crm_open_tickets_update', ({peerIds}) => {
  setCrmOpenTicketPeerIds(peerIds);
});

rootScope.addEventListener('crm_ticket_update', ({peerId, ticket}) => {
  const isOpen = ticket?.status === 'open';
  if(isOpen === openTicketPeerIds().has(peerId)) {
    return;
  }

  const set = new Set(openTicketPeerIds());
  isOpen ? set.add(peerId) : set.delete(peerId);
  setOpenTicketPeerIds(set);
});

// A dropped CRM session must not leave a stale set behind — the folder is empty
// for a signed-out agent anyway.
rootScope.addEventListener('crm_auth_required', () => {
  setOpenTicketPeerIds(new Set<PeerId>());
});

export default function useCrmOpenTicketPeerIds() {
  return openTicketPeerIds;
}
