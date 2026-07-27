import rootScope from '@lib/rootScope';
import confirmationPopup from '@components/confirmationPopup';
import InputField from '@components/inputField';
import {toastNew} from '@components/toast';
import {useCrmUserId, useSensitiveRequireApproval} from '@stores/crmRole';

// Single entry point for revealing a redacted item (a message's sensitive spans,
// or a peer's contact info via CONTACT_INFO_MID). A "reason to view" is ALWAYS
// collected and sent — it's shown to the superadmin who approves, or logged on
// self-reveal when approval is off. `content` is a snapshot of the message text
// (tweb has it in memory) so the superadmin can see what they're approving.
//
// Behaviour then follows the global approval setting (enforced server-side):
// - approval ON  → the CRM records a pending request → returns 'pending' → toast.
// - approval OFF → the CRM approves immediately → returns 'approved' → we reveal
//   right away by dispatching the reveal event locally (Reverb echo is a no-op).
export async function triggerSensitiveReveal(peerId: PeerId, messageId: number, content?: string): Promise<void> {
  if(!peerId?.isUser()) return;
  const chatId = '' + peerId.toUserId();
  const requireApproval = useSensitiveRequireApproval()();

  const inputField = new InputField({
    label: 'Crm.Sensitive.ReasonLabel',
    maxLength: 300,
    required: true
  });

  try {
    await confirmationPopup({
      titleLangKey: 'Crm.Sensitive.ReasonTitle',
      descriptionLangKey: requireApproval ? 'Crm.Sensitive.ReasonDescriptionApproval' : 'Crm.Sensitive.ReasonDescription',
      inputField,
      button: {langKey: requireApproval ? 'Crm.Sensitive.RequestButton' : 'Crm.Sensitive.RevealButton'}
    });
  } catch{
    return; // cancelled
  }

  const reason = inputField.value.trim();
  const status = await rootScope.managers.appCrmManager.requestSensitiveReveal(chatId, messageId, reason, content);
  if(status === 'approved') {
    // Reveal now across every listener (bubbles + the contact-info store) without
    // waiting for the Reverb round-trip.
    rootScope.dispatchEvent('crm_sensitive_reveal_push', {peerId, messageId, userId: useCrmUserId()() ?? null});
  } else if(status === 'pending') {
    toastNew({langPackKey: 'Crm.Sensitive.Requested'});
  } else if(status === 'rate_limited') {
    toastNew({langPackKey: 'Crm.Sensitive.RateLimited'});
  } else {
    toastNew({langPackKey: 'Crm.Sensitive.RequestFailed'});
  }
}
