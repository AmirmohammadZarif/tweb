import PopupElement from '.';
import appImManager from '@lib/appImManager';
import TelegramWebView from '@components/telegramWebView';
import Button from '@components/button';
import I18n, {i18n} from '@lib/langPack';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import safeWindowOpen from '@helpers/dom/safeWindowOpen';

export function createVerificationIframe(options: ConstructorParameters<typeof TelegramWebView>[0]) {
  const result = new TelegramWebView({
    ...options,
    sandbox: 'allow-forms allow-scripts allow-same-origin allow-modals'
  });
  const {iframe} = result;
  iframe.allow = 'payment';
  iframe.classList.add('payment-verification');
  return result;
}

const className = 'payment-verification-fallback';

export default class PopupPaymentVerification extends PopupElement<{
  finish: () => void,
  deferred: () => void
}> {
  private telegramWebView: TelegramWebView;

  constructor(private url: string, private openPathAfter?: boolean) {
    super('popup-payment popup-payment-verification', {
      closable: true,
      overlayClosable: true,
      body: true,
      title: 'Checkout.WebConfirmation.Title'
    });

    this.d();
  }

  private d() {
    const telegramWebView = this.telegramWebView = createVerificationIframe({
      url: this.url
    });

    telegramWebView.addEventListener('web_app_open_tg_link', (e) => {
      this.dispatchEvent('finish');
      this.hide();
      if(this.openPathAfter) {
        appImManager.openUrl('https://t.me' + e.path_full);
      }
    });

    this.body.append(telegramWebView.iframe, this.createEscapeHatch());
    this.show();
    telegramWebView.onMount();
  }

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
   * not have. So this path never reports 'finish'; it reports 'deferred' and
   * the caller leaves the payment on its existing 'pending' result.
   */
  private createEscapeHatch() {
    const container = document.createElement('div');
    container.classList.add(className);

    const text = document.createElement('div');
    text.classList.add(className + '-text');
    text.append(i18n('Checkout.WebConfirmation.NotLoading'));

    const buttonText = new I18n.IntlElement({key: 'Checkout.WebConfirmation.OpenInNewTab'});
    const button = Button('btn-primary btn-color-primary ' + className + '-button');
    button.append(buttonText.element);

    let opened = false;
    attachClickEvent(button, () => {
      // window.open survives the popup blocker only inside a user gesture, so
      // opening is always a click and never automatic.
      if(!opened) {
        opened = true;
        safeWindowOpen(this.url);
        text.textContent = '';
        text.append(i18n('Checkout.WebConfirmation.OpenedInNewTab'));
        buttonText.compareAndUpdate({key: 'Checkout.WebConfirmation.Done'});
        return;
      }

      this.dispatchEvent('deferred');
      this.hide();
    }, {listenerSetter: this.listenerSetter});

    container.append(text, button);
    return container;
  }

  protected destroy() {
    this.telegramWebView.destroy();
    return super.destroy();
  }
}
