import PopupElement from '.';
import CrmNotesPanel from '@components/crmNotesPanel';

// Topbar route to the internal notes. The panel itself is shared with the
// profile's shared-media "Notes" tab — see @components/crmNotesPanel.
export default class PopupCrmNotes extends PopupElement {
  constructor(private peerId: PeerId) {
    super('popup-crm-notes', {
      title: 'Crm.Note.PanelTitle',
      body: true,
      closable: true
    });

    this.appendSolidBody(() => <CrmNotesPanel peerId={this.peerId} scroll />);
    this.show();
  }
}

export function showCrmNotesPopup(peerId: PeerId) {
  new PopupCrmNotes(peerId);
}
