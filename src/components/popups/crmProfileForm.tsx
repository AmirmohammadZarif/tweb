import {createResource, createSignal, For, JSX, Show} from 'solid-js';
import PopupElement, {createPopup} from '@components/popups/indexTsx';
import {I18nTsx} from '@helpers/solid/i18n';
import {i18n, LangPackKey} from '@lib/langPack';
import rootScope from '@lib/rootScope';
import {toast, toastNew} from '@components/toast';
import classNames from '@helpers/string/classNames';
import {CrmProfileFormStatus} from '@lib/crm/types';

import styles from './crmProfileForm.module.scss';

// The customer's andropay.org profile, and a timed form link to collect what is
// missing (identity, contact, bank account, ID card and utility bill photos).
//
// The link is put into the composer, never sent from here: the agent sees the
// message and presses send like any other reply. The customer fills the form
// in on the CRM (a mobile wizard) and the CRM keeps the answers encrypted until
// someone enters them at andropay.org.

const formatDate = (iso: string | null) => {
  if(!iso) return '';
  const date = new Date(iso);
  return isNaN(+date) ? '' : date.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
};

function StatusRow(props: {tone: 'ok' | 'warn' | 'bad' | 'none', title: JSX.Element, value: JSX.Element, detail?: JSX.Element}) {
  return (
    <div class={classNames(styles.row, props.tone !== 'none' && styles[props.tone])}>
      <span class={styles.dot} />
      <div>
        <div class={styles.rowTitle}>{props.title}</div>
        <div class={styles.rowValue}>{props.value}</div>
        <Show when={props.detail}><div class={styles.rowDetail}>{props.detail}</div></Show>
      </div>
    </div>
  );
}

function AndropayRow(props: {status: CrmProfileFormStatus}) {
  const org = () => props.status.andropay;
  const title = i18n('Crm.ProfileForm.AndropayOrg');

  return (
    <Show when={org().checked} fallback={
      <StatusRow tone="none" title={title} value={i18n('Crm.ProfileForm.NotChecked')} />
    }>
      <Show when={org().isMember} fallback={
        <StatusRow tone="bad" title={title} value={i18n('Crm.ProfileForm.NotMember')} />
      }>
        <Show when={!org().complete} fallback={
          <StatusRow tone="ok" title={title} value={i18n('Crm.ProfileForm.Complete')} />
        }>
          <StatusRow
            tone="warn"
            title={title}
            value={i18n('Crm.ProfileForm.Incomplete')}
            detail={<>{i18n('Crm.ProfileForm.Missing')} <For each={org().missing}>{(field, i) => <>{i() ? ', ' : ''}{field.label}</>}</For></>}
          />
        </Show>
      </Show>
    </Show>
  );
}

function CrmRow(props: {status: CrmProfileFormStatus}) {
  const crm = () => props.status.crm;
  const title = i18n('Crm.ProfileForm.CrmForm');

  const tone = (): 'ok' | 'warn' | 'none' => {
    switch(crm()?.status) {
      case 'completed': return 'ok';
      case 'submitted': return 'ok';
      case 'pending': return 'warn';
      default: return 'none';
    }
  };

  const detail = () => {
    const current = crm();
    if(!current) return undefined;
    if(current.status === 'pending') return i18n('Crm.ProfileForm.ExpiresAt', [formatDate(current.expiresAt)]);
    if(current.submittedAt) return i18n('Crm.ProfileForm.SubmittedAt', [formatDate(current.submittedAt)]);
    return undefined;
  };

  return (
    <StatusRow
      tone={tone()}
      title={title}
      value={crm() ? crm().statusLabel : i18n('Crm.ProfileForm.NeverSent')}
      detail={detail()}
    />
  );
}

export default function showCrmProfileFormPopup(props: {
  peerId: PeerId,
  /** Puts the message into the chat's composer at the caret. */
  insert: (text: string) => void
}) {
  const managers = rootScope.managers;
  const chatId = '' + props.peerId.toUserId();

  createPopup(() => {
    const [status] = createResource(() => managers.appCrmManager.getProfileFormStatus(chatId));
    const [busy, setBusy] = createSignal(false);

    const buttonKey = (): LangPackKey => {
      const current = status();
      if(current?.complete) return 'Crm.ProfileForm.SendAnyway';
      if(current?.isPending) return 'Crm.ProfileForm.SendNew';
      return 'Crm.ProfileForm.Send';
    };

    const issue = async() => {
      setBusy(true);
      try {
        const link = await managers.appCrmManager.issueProfileFormLink(chatId, !!status()?.complete);
        props.insert(link.message);
        toastNew({langPackKey: 'Crm.ProfileForm.Inserted'});
        return true;
      } catch(err) {
        const message = typeof (err as any)?.serverMessage === 'string' ? (err as any).serverMessage : '';
        if(message) toast(message);
        else toastNew({langPackKey: 'Crm.ProfileForm.Failed'});
        setBusy(false);
        return false;
      }
    };

    return (
      <PopupElement class={styles.popup} containerClass={styles.container} show>
        <PopupElement.Header>
          <PopupElement.CloseButton />
          <PopupElement.Title><I18nTsx key="Crm.ProfileForm.Title" /></PopupElement.Title>
        </PopupElement.Header>

        <PopupElement.Body class={styles.body}>
          <Show when={!status.loading} fallback={<div class={styles.empty}>{i18n('Crm.ProfileForm.Loading')}</div>}>
            <Show when={status()} fallback={<div class={styles.empty}>{i18n('Crm.ProfileForm.LoadFailed')}</div>}>
              <Show when={status().hasCustomer} fallback={<div class={styles.empty}>{i18n('Crm.ProfileForm.NoCustomer')}</div>}>
                <p class={styles.intro}>{i18n(status().complete ? 'Crm.ProfileForm.IntroComplete' : 'Crm.ProfileForm.Intro')}</p>
                <AndropayRow status={status()} />
                <CrmRow status={status()} />
              </Show>
            </Show>
          </Show>
        </PopupElement.Body>

        <PopupElement.Buttons>
          <PopupElement.FooterButton langKey="Cancel" color="secondary" cancel />
          <PopupElement.FooterButton
            langKey={buttonKey()}
            color={status()?.complete ? 'danger' : 'primary'}
            disabled={busy() || status.loading || !status()?.hasCustomer}
            callback={issue}
          />
        </PopupElement.Buttons>
      </PopupElement>
    );
  });
}
