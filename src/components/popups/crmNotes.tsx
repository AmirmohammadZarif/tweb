import {createSignal, For, Show} from 'solid-js';
import PopupElement from '.';
import Button from '@components/buttonTsx';
import Scrollable from '@components/scrollable2';
import I18n, {i18n} from '@lib/langPack';
import rootScope from '@lib/rootScope';
import {CrmNote} from '@lib/crm/types';
import type {ChatCrmTicketPlate} from '@components/chat/crmTicket';

// Internal-notes panel: agents leave context for each other on the customer's
// ticket without messaging the customer. Reads/writes go through the crmTicket
// plate (the single owner of the chat's note state), and the panel stays live via
// the `crm_notes_update` event the plate dispatches for both backfill and the
// Reverb push.
export default class PopupCrmNotes extends PopupElement {
  constructor(
    private peerId: PeerId,
    private crmTicket: ChatCrmTicketPlate
  ) {
    super('popup-crm-notes', {
      title: 'Crm.Note.PanelTitle',
      body: true,
      closable: true
    });

    this.appendSolidBody(() => this._construct());
    this.show();
  }

  protected _construct() {
    const [notes, setNotes] = createSignal<CrmNote[]>(this.crmTicket.getNotes() || []);
    const [busy, setBusy] = createSignal(false);
    const [text, setText] = createSignal('');

    this.listenerSetter.add(rootScope)('crm_notes_update', ({peerId, notes: list}) => {
      if(peerId !== this.peerId) return;
      setNotes(list || []);
    });

    const submit = async() => {
      const value = text().trim();
      if(!value || busy()) return;
      setBusy(true);
      try {
        const note = await this.crmTicket.addNote(value);
        if(note) setText(''); // the list refreshes via crm_notes_update
      } finally {
        setBusy(false);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // Enter submits, Shift+Enter inserts a newline — mirrors composing a message.
      if(e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    };

    const formatTime = (iso: string) => {
      const date = new Date(iso);
      return isNaN(date.getTime()) ? '' : date.toLocaleString();
    };

    return (
      <div class="popup-crm-notes-content">
        <Show
          when={notes().length}
          fallback={<div class="popup-crm-notes-empty">{i18n('Crm.Note.None')}</div>}
        >
          <Scrollable class="popup-crm-notes-list">
            <For each={notes()}>
              {(note) => (
                <div class="popup-crm-notes-item">
                  <div class="popup-crm-notes-item-head">
                    <span class="popup-crm-notes-item-author">{note.author_name}</span>
                    <span class="popup-crm-notes-item-time">{formatTime(note.created_at)}</span>
                  </div>
                  <div class="popup-crm-notes-item-text">{note.text}</div>
                </div>
              )}
            </For>
          </Scrollable>
        </Show>
        <div class="popup-crm-notes-compose">
          <textarea
            class="popup-crm-notes-textarea"
            rows={3}
            placeholder={I18n.format('Crm.Note.Placeholder', true)}
            value={text()}
            disabled={busy()}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
          <Button
            class="btn-primary btn-color-primary"
            disabled={busy() || !text().trim()}
            onClick={submit}
          >
            {i18n('Crm.Note.Add')}
          </Button>
        </div>
      </div>
    );
  }
}

export function showCrmNotesPopup(peerId: PeerId, crmTicket: ChatCrmTicketPlate) {
  new PopupCrmNotes(peerId, crmTicket);
}
