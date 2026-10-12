import {createSignal} from 'solid-js';
import PopupElement, {createPopup} from '@components/popups/indexTsx';
import CrmNotesPanel from '@components/crmNotesPanel';

// Topbar route to the internal notes. The panel itself is shared with the
// profile's shared-media "Notes" tab — see @components/crmNotesPanel.
export function showCrmNotesPopup(peerId: PeerId) {
  const [show, setShow] = createSignal(true);

  createPopup(() => (
    <PopupElement class="popup-crm-notes" closable show={show()} onClose={() => setShow(false)}>
      <PopupElement.Header>
        <PopupElement.CloseButton />
        <PopupElement.Title title="Crm.Note.PanelTitle" />
      </PopupElement.Header>
      <PopupElement.Body>
        <CrmNotesPanel peerId={peerId} scroll />
      </PopupElement.Body>
    </PopupElement>
  ));
}
