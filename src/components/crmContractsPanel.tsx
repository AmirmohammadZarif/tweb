import {createEffect, createSignal, For, on, onCleanup, Show} from 'solid-js';
import Scrollable from '@components/scrollable2';
import classNames from '@helpers/string/classNames';
import {i18n} from '@lib/langPack';
import rootScope from '@lib/rootScope';
import {CrmContract, CrmContractsResult} from '@lib/crm/types';

// The customer's contracts at andro.law, read through the CRM.
//
// Self-contained so the SAME markup serves both mounts, exactly like
// @components/crmNotesPanel: the topbar popup and the profile's shared-media
// "Contracts" tab. Read-only by design. Issuing a contract needs a template
// form and a preflight round-trip against the customer's andro.law profile,
// which belongs in the CRM panel, not in a chat client.
//
// There is no realtime channel for contracts and deliberately so: they change
// when a customer signs something at andro.law, which the CRM only learns about
// by asking. Reopening the panel is the refresh.

const EMPTY: CrmContractsResult = {
  enabled: false,
  hasAccount: false,
  contracts: [],
  counts: {total: 0, active: 0, awaiting_signature: 0, expiring_soon: 0}
};

export default function CrmContractsPanel(props: {
  peerId: PeerId,
  class?: string,
  /** Give the list its own scroller (the popup). The sidebar tab scrolls as a whole. */
  scroll?: boolean,
  onCountChange?: (count: number) => void
}) {
  const [result, setResult] = createSignal<CrmContractsResult>(EMPTY);
  const [loading, setLoading] = createSignal(false);
  // File id currently being fetched, so the row can show it is working. A cold
  // contract is converted from .docx on andro.law's side and is not instant.
  const [openingFileId, setOpeningFileId] = createSignal<number | undefined>();

  // Bumps on every peer change so a slow response for the previous chat cannot
  // overwrite a newer one.
  let generation = 0;

  createEffect(on(() => props.peerId, (peerId) => {
    const current = ++generation;
    setResult(EMPTY);
    setOpeningFileId(undefined);

    if(!peerId?.isUser()) {
      props.onCountChange?.(0);
      return;
    }

    setLoading(true);
    rootScope.managers.appCrmManager.getContractsByTelegram('' + peerId.toUserId())
    .then((contracts) => {
      if(generation !== current) return;
      setResult(contracts);
      props.onCountChange?.(contracts.contracts.length);
    })
    .finally(() => {
      if(generation === current) setLoading(false);
    });
  }));

  // Any object URL still alive when the panel goes away.
  const openedUrls: string[] = [];
  onCleanup(() => {
    openedUrls.forEach((url) => URL.revokeObjectURL(url));
  });

  const openPdf = async(contract: CrmContract) => {
    if(contract.file_id === null || openingFileId() !== undefined) return;

    setOpeningFileId(contract.file_id);
    try {
      const bytes = await rootScope.managers.appCrmManager
      .getContractPdf('' + props.peerId.toUserId(), contract.file_id);

      if(!bytes) return;

      const url = URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'}));
      openedUrls.push(url);
      // A new tab rather than a download: an agent almost always wants to read
      // one clause and go back to the conversation.
      window.open(url, '_blank', 'noopener');
    } finally {
      setOpeningFileId(undefined);
    }
  };

  // Y-m-d already, so it is shown as it arrives rather than being pushed through
  // a locale that would turn an unambiguous date into an ambiguous one.
  const formatDate = (value: string | null) => value || '';

  const list = () => (
    <div class="crm-contracts-list">
      <For each={result().contracts}>{(contract) => (
        <div class={classNames('crm-contracts-item', 'crm-contracts-item--' + contract.status_color)}>
          <div class="crm-contracts-item-head">
            <span class="crm-contracts-item-title">{contract.title || '#' + contract.id}</span>
            <span class={classNames('crm-contracts-badge', 'crm-contracts-badge--' + contract.status_color)}>
              {contract.status_label}
            </span>
          </div>

          <div class="crm-contracts-item-meta">
            <span dir="ltr">
              {formatDate(contract.start_date)}
              <Show when={contract.expiration_date} fallback={<> · {i18n('Crm.Contract.NoExpiry')}</>}>
                {' → '}
                <span class={classNames(contract.is_expired && 'crm-contracts-expired')}>
                  {formatDate(contract.expiration_date)}
                </span>
              </Show>
            </span>

            <Show when={contract.awaits_signature}>
              <span class="crm-contracts-awaiting">{i18n('Crm.Contract.AwaitingSignature')}</span>
            </Show>
          </div>

          <Show when={contract.file_id !== null}>
            <button
              class="crm-contracts-open"
              disabled={openingFileId() !== undefined}
              onClick={() => openPdf(contract)}
            >
              {openingFileId() === contract.file_id ?
                i18n('Crm.Contract.Opening') :
                i18n('Crm.Contract.OpenPdf')}
            </button>
          </Show>
        </div>
      )}</For>
    </div>
  );

  // One empty state per reason. They look the same to a reader but mean quite
  // different things to an agent: "we cannot ask" is not "they have none".
  const empty = () => {
    if(loading()) return i18n('Crm.Contract.Loading');
    if(!result().enabled) return i18n('Crm.Contract.Disabled');
    if(!result().hasAccount) return i18n('Crm.Contract.NoAccount');
    return i18n('Crm.Contract.None');
  };

  return (
    <div class={classNames('crm-contracts', props.scroll && 'crm-contracts--scroll', props.class)}>
      <Show when={result().hasAccount && result().counts.total > 0}>
        <div class="crm-contracts-summary">
          <span>{i18n('Crm.Contract.CountActive', [result().counts.active])}</span>
          <Show when={result().counts.awaiting_signature > 0}>
            <span class="crm-contracts-summary-warning">
              {i18n('Crm.Contract.CountAwaiting', [result().counts.awaiting_signature])}
            </span>
          </Show>
          <Show when={result().counts.expiring_soon > 0}>
            <span class="crm-contracts-summary-danger">
              {i18n('Crm.Contract.CountExpiring', [result().counts.expiring_soon])}
            </span>
          </Show>
        </div>
      </Show>

      <Show
        when={result().contracts.length}
        fallback={<div class="crm-contracts-empty">{empty()}</div>}
      >
        <Show when={props.scroll} fallback={list()}>
          <Scrollable class="crm-contracts-scrollable">{list()}</Scrollable>
        </Show>
      </Show>
    </div>
  );
}
