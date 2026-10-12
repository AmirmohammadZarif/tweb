import PopupElement, {createPopup} from '@components/popups/indexTsx';
import appImManager from '@lib/appImManager';
import TelegramWebView from '@components/telegramWebView';
import getWebViewTgLink from '@helpers/getWebViewTgLink';
import {createSignal, onCleanup, onMount} from 'solid-js';
import I18n, {i18n} from '@lib/langPack';
import Button from '@components/buttonTsx';
import safeWindowOpen from '@helpers/dom/safeWindowOpen';

export function createVerificationIframe(options: ConstructorParameters<typeof TelegramWebView>[0]) {
  const result = new TelegramWebView({
    ...options,
    sandbox: 'allow-forms allow-scripts allow-same-origin allow-modals'
  });
  const {iframe} = result;
  iframe.allow = 'payment';
  iframe.title = I18n.format('Checkout.WebConfirmation.Title', true);
  iframe.classList.add('payment-verification');
  return result;
}

export default function showPaymentVerificationPopup(options: {
  url: string,
  openPathAfter?: boolean,
  onFinish?: () => void,
  // The user took a page that refused to be framed to a real tab: nothing will come back
  // through the frame, so the caller should leave the payment on its 'pending' result.
  onDeferred?: () => void,
  onClose?: () => void
}) {
  const [show, setShow] = createSignal(true);

  const telegramWebView = createVerificationIframe({url: options.url});

  telegramWebView.addEventListener('web_app_open_tg_link', (e) => {
    options.onFinish?.();
    setShow(false);
    if(options.openPathAfter) {
      appImManager.openUrl(getWebViewTgLink(e.path_full));
    }
  });

  /**
   * An acquirer page that refuses to be framed (X-Frame-Options, or a CSP
   * frame-ancestors list naming only Telegram's own domains) leaves a blank box
   * with no way forward. The page is fine in a top-level tab, so always offer
   * that door.
   *
   * It is offered unconditionally rather than on detection because a blocked
   * frame is indistinguishable from a healthy cross-origin one: contentWindow's
   * location, origin and history all throw SecurityError either way, and the
   * `load` event fires for both. Guessing would mean hiding working frames.
   *
   * Nothing can come back from that tab — safeWindowOpen severs `opener`, and
   * the page reports completion to `window.parent`, which a top-level tab does
   * not have. So this path never reports 'finish'; it reports 'deferred'.
   */
  const EscapeHatch = () => {
    const className = 'payment-verification-fallback';
    const [opened, setOpened] = createSignal(false);

    const onClick = () => {
      // window.open survives the popup blocker only inside a user gesture, so
      // opening is always a click and never automatic.
      if(!opened()) {
        setOpened(true);
        safeWindowOpen(options.url);
        return;
      }

      options.onDeferred?.();
      setShow(false);
    };

    return (
      <div class={className}>
        <div class={className + '-text'}>
          {opened() ? i18n('Checkout.WebConfirmation.OpenedInNewTab') : i18n('Checkout.WebConfirmation.NotLoading')}
        </div>
        <Button
          class={'btn-primary btn-color-primary ' + className + '-button'}
          text={opened() ? 'Checkout.WebConfirmation.Done' : 'Checkout.WebConfirmation.OpenInNewTab'}
          onClick={onClick}
        />
      </div>
    );
  };

  createPopup(() => {
    onMount(() => telegramWebView.onMount());
    onCleanup(() => telegramWebView.destroy());

    return (
      <PopupElement class="popup-payment popup-payment-verification" closable show={show()} onClose={options.onClose}>
        <PopupElement.Header>
          <PopupElement.CloseButton />
          <PopupElement.Title title="Checkout.WebConfirmation.Title" />
        </PopupElement.Header>
        <PopupElement.Body>
          {telegramWebView.iframe}
          <EscapeHatch />
        </PopupElement.Body>
      </PopupElement>
    );
  });

  return {hide: () => setShow(false)};
}
