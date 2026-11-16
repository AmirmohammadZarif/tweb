import {createSignal, For} from 'solid-js';
import PopupElement, {createPopup} from '@components/popups/indexTsx';
import Button from '@components/buttonTsx';
import rootScope from '@lib/rootScope';
import {toast, toastNew} from '@components/toast';
import {showCrmLoginPopup} from '@components/popups/crmLogin';
import type {CrmTelegramLoginAccount} from '@lib/crm/types';

/**
 * Code-free Telegram sign-in from the QR card.
 *
 * The agent signs in to the CRM (if not already), picks their department
 * account, and the CRM's userbot accepts the QR token tweb is showing, exactly
 * like scanning it with a phone. The QR card's own polling loop then sees the
 * accepted token and finishes the sign-in (or moves to the 2FA password card).
 *
 * `getToken` returns the token currently drawn, base64url, so a token that
 * rotated while the agent was choosing is never sent stale.
 */
export async function startCrmTelegramLogin(getToken: () => string | undefined): Promise<void> {
  const crm = rootScope.managers.appCrmManager;
  if(!(await crm.isConnected())) {
    showCrmLoginPopup(() => void startCrmTelegramLogin(getToken));
    return;
  }

  let accounts: CrmTelegramLoginAccount[];
  try {
    accounts = await crm.telegramLoginAccounts();
  } catch(err) {
    showError(err);
    return;
  }

  if(!accounts.length) {
    toastNew({langPackKey: 'Crm.QrLogin.None'});
    return;
  }
  if(accounts.length === 1) {
    await approve(accounts[0], getToken);
    return;
  }
  showAccountPicker(accounts, getToken);
}

async function approve(account: CrmTelegramLoginAccount, getToken: () => string | undefined) {
  const token = getToken();
  if(!token) {
    toastNew({langPackKey: 'Crm.QrLogin.Failed'});
    return;
  }
  toastNew({langPackKey: 'Crm.QrLogin.Approving'});
  try {
    await rootScope.managers.appCrmManager.approveTelegramLogin(account.session_telegram_user_id, token);
  } catch(err) {
    showError(err);
  }
}

function showError(err: any) {
  const msg = typeof err?.message === 'string' && !err.message.startsWith('CRM_') ? err.message : '';
  if(msg) toast(msg);
  else toastNew({langPackKey: 'Crm.QrLogin.Failed'});
}

function showAccountPicker(accounts: CrmTelegramLoginAccount[], getToken: () => string | undefined) {
  const [show, setShow] = createSignal(true);

  createPopup(() => (
    <PopupElement class="popup-crm-login" closable show={show()} onClose={() => setShow(false)}>
      <PopupElement.Header>
        <PopupElement.CloseButton />
        <PopupElement.Title title="Crm.QrLogin.Pick" />
      </PopupElement.Header>
      <PopupElement.Body>
        <For each={accounts}>
          {(account) => (
            <Button
              class="btn-primary btn-secondary btn-primary-transparent primary"
              onClick={() => {
                setShow(false);
                void approve(account, getToken);
              }}
            >
              {account.department || account.name}{account.username ? ' (@' + account.username + ')' : ''}
            </Button>
          )}
        </For>
      </PopupElement.Body>
    </PopupElement>
  ));
}
