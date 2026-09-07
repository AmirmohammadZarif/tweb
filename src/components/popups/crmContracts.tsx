import PopupElement from '.';
import CrmContractsPanel from '@components/crmContractsPanel';

// Topbar route to the customer's andro.law contracts. The panel itself is shared
// with the profile's shared-media "Contracts" tab: see
// @components/crmContractsPanel.
export default class PopupCrmContracts extends PopupElement {
  constructor(private peerId: PeerId) {
    super('popup-crm-contracts', {
      title: 'Crm.Contract.PanelTitle',
      body: true,
      closable: true
    });

    this.appendSolidBody(() => <CrmContractsPanel peerId={this.peerId} scroll />);
    this.show();
  }
}

export function showCrmContractsPopup(peerId: PeerId) {
  new PopupCrmContracts(peerId);
}
