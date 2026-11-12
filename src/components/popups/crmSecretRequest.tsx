import {createResource, createSignal, For, Show} from 'solid-js';
import PopupElement, {createPopup} from '@components/popups/indexTsx';
import {I18nTsx} from '@helpers/solid/i18n';
import {i18n, LangPackKey} from '@lib/langPack';
import rootScope from '@lib/rootScope';
import {toast, toastNew} from '@components/toast';
import classNames from '@helpers/string/classNames';
import safeWindowOpen from '@helpers/dom/safeWindowOpen';
import {CrmSecretRequest} from '@lib/crm/types';

import profileStyles from './crmProfileForm.module.scss';
import styles from './crmSecretRequest.module.scss';

// "Request secure info": the agent names one sensitive value they need (a
// password, a recovery code) and the CRM issues a one-time link for it. The
// customer types the value into a CRM page instead of the chat, where the
// shared department account and every device on it would keep it forever.
// The value lands in the vault for this department; reading it takes the
// vault's two-factor check. Nothing in this popup ever shows a value.
//
// Like the profile form, the link goes into the composer and is never sent
// from here: the agent reviews the Persian message and presses send.

const TITLE_MAX = 120;
const NOTE_MAX = 500;

const formatDate = (iso: string | null) => {
  if(!iso) return '';
  const date = new Date(iso);
  return isNaN(+date) ? '' : date.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
};

const TONE: Record<CrmSecretRequest['status'], 'ok' | 'warn' | 'none'> = {
  submitted: 'ok',
  pending: 'warn',
  revoked: 'none',
  expired: 'none'
};

export default function showCrmSecretRequestPopup(props: {
  peerId: PeerId,
  /** Puts the message into the chat's composer at the caret. */
  insert: (text: string) => void
}) {
  const managers = rootScope.managers;
  const chatId = '' + props.peerId.toUserId();

  createPopup(() => {
    const [requests, {refetch}] = createResource(() => managers.appCrmManager.getSecretRequests(chatId));
    const [title, setTitle] = createSignal('');
    const [note, setNote] = createSignal('');
    const [busy, setBusy] = createSignal(false);

    const issue = async() => {
      const what = title().trim();
      if(!what) return false;
      setBusy(true);
      try {
        const link = await managers.appCrmManager.issueSecretRequest(chatId, what, note().trim() || undefined);
        props.insert(link.message);
        toastNew({langPackKey: 'Crm.SecretRequest.Inserted'});
        return true;
      } catch(err) {
        const message = typeof (err as any)?.serverMessage === 'string' ? (err as any).serverMessage : '';
        if(message) toast(message);
        else toastNew({langPackKey: 'Crm.SecretRequest.Failed'});
        setBusy(false);
        return false;
      }
    };

    const revoke = async(id: number) => {
      if(await managers.appCrmManager.revokeSecretRequest(chatId, id)) refetch();
    };

    return (
      <PopupElement class={profileStyles.popup} containerClass={profileStyles.container} show>
        <PopupElement.Header>
          <PopupElement.CloseButton />
          <PopupElement.Title><I18nTsx key="Crm.SecretRequest.Title" /></PopupElement.Title>
        </PopupElement.Header>

        <PopupElement.Body class={profileStyles.body}>
          <p class={profileStyles.intro}>{i18n('Crm.SecretRequest.Intro')}</p>

          <label class={styles.field}>
            <span class={styles.label}>{i18n('Crm.SecretRequest.WhatLabel')}</span>
            <input
              class={styles.input}
              type="text"
              maxLength={TITLE_MAX}
              placeholder={i18n('Crm.SecretRequest.WhatPlaceholder').textContent}
              value={title()}
              onInput={(e) => setTitle(e.currentTarget.value)}
            />
          </label>

          <label class={styles.field}>
            <span class={styles.label}>{i18n('Crm.SecretRequest.NoteLabel')}</span>
            <textarea
              class={styles.input}
              rows={2}
              maxLength={NOTE_MAX}
              value={note()}
              onInput={(e) => setNote(e.currentTarget.value)}
            />
          </label>

          <div class={styles.heading}>{i18n('Crm.SecretRequest.Recent')}</div>
          <Show when={!requests.loading}>
            <Show when={requests()?.length} fallback={<div class={profileStyles.empty}>{i18n('Crm.SecretRequest.None')}</div>}>
              <For each={requests()}>{(request) => (
                <div class={classNames(profileStyles.row, TONE[request.status] !== 'none' && profileStyles[TONE[request.status]])}>
                  <span class={profileStyles.dot} />
                  <div>
                    <div class={profileStyles.rowValue}>{request.title}</div>
                    <div class={profileStyles.rowTitle}>
                      {i18n(`Crm.SecretRequest.Status.${request.status}` as LangPackKey)}
                      {' · '}
                      {formatDate(request.submitted_at || request.expires_at)}
                    </div>
                    <div class={styles.actions}>
                      <Show when={request.vault_url}>
                        <button type="button" class={styles.link} onClick={() => safeWindowOpen(request.vault_url)}>
                          {i18n('Crm.SecretRequest.OpenVault')}
                        </button>
                      </Show>
                      <Show when={request.status === 'pending'}>
                        <button type="button" class={styles.link} onClick={() => revoke(request.id)}>
                          {i18n('Crm.SecretRequest.Revoke')}
                        </button>
                      </Show>
                    </div>
                  </div>
                </div>
              )}</For>
            </Show>
          </Show>
        </PopupElement.Body>

        <PopupElement.Buttons>
          <PopupElement.FooterButton langKey="Cancel" color="secondary" cancel />
          <PopupElement.FooterButton
            langKey="Crm.SecretRequest.Send"
            color="primary"
            disabled={busy() || !title().trim()}
            callback={issue}
          />
        </PopupElement.Buttons>
      </PopupElement>
    );
  });
}
