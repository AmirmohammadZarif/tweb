import {createSignal} from 'solid-js';
import PopupElement, {createPopup} from '@components/popups/indexTsx';
import CrmContractsPanel from '@components/crmContractsPanel';

// Topbar route to the customer's andro.law contracts. The panel itself is shared
// with the profile's shared-media "Contracts" tab: see
// @components/crmContractsPanel.
export function showCrmContractsPopup(peerId: PeerId) {
  const [show, setShow] = createSignal(true);

  createPopup(() => (
    <PopupElement class="popup-crm-contracts" closable show={show()} onClose={() => setShow(false)}>
      <PopupElement.Header>
        <PopupElement.CloseButton />
        <PopupElement.Title title="Crm.Contract.PanelTitle" />
      </PopupElement.Header>
      <PopupElement.Body>
        <CrmContractsPanel peerId={peerId} scroll />
      </PopupElement.Body>
    </PopupElement>
  ));
}
