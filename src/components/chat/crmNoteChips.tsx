import {createRoot, createSignal, For, onCleanup, Show} from 'solid-js';
import Button from '@components/buttonTsx';
import {IconTsx} from '@components/iconTsx';
import confirmationPopup from '@components/confirmationPopup';
import classNames from '@helpers/string/classNames';
import I18n, {i18n} from '@lib/langPack';
import {CrmNote} from '@lib/crm/types';
import {canEditCrmNote, deleteCrmNote, isCrmNoteShared, saveCrmNote} from '@lib/crm/notes';
import createCrmTaskFromText from '@lib/crm/createTask';
import {useIsCrmReadOnly} from '@stores/crmRole';

// Internal agent notes drawn inline in the timeline.
//
// These used to be a `::before` on the anchor bubble whose text came from a CSS
// custom property — positioner-safe, but a pseudo-element can't be clicked, so a
// note could only be fixed from the panel. They are real nodes now: still mounted
// INSIDE the anchor bubble (which is what keeps the index-positioned group tree
// from being disturbed — nothing is inserted between bubbles), but with the edit
// and delete affordances right where the note is read.
//
// Agent-only content: never rendered for a peer that isn't a CRM customer chat,
// and never sent anywhere near the customer.

function CrmNoteChip(props: {peerId: PeerId, note: CrmNote}) {
  const [editing, setEditing] = createSignal(false);
  const [text, setText] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const startEdit = () => {
    setText(props.note.text || '');
    setEditing(true);
  };

  const save = async() => {
    const value = text().trim();
    if(!value || busy()) return;
    if(value === props.note.text) {
      setEditing(false);
      return;
    }

    setBusy(true);
    try {
      // The saved note comes back through crm_note_push, which re-renders the
      // chips — so there is nothing to write back locally.
      const saved = await saveCrmNote(props.peerId, props.note.id, {text: value});
      if(saved) setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const remove = async() => {
    try {
      await confirmationPopup({
        titleLangKey: 'Crm.Note.DeleteTitle',
        descriptionLangKey: 'Crm.Note.DeleteConfirm',
        button: {langKey: 'Delete', isDanger: true}
      });
    } catch(err) {
      return; // dismissed — confirmationPopup rejects on cancel
    }

    setBusy(true);
    try {
      await deleteCrmNote(props.peerId, props.note.id);
    } finally {
      setBusy(false);
    }
  };

  // Hand the note off as a task instead of leaving it for whoever reads the chat
  // next. The composer takes it from here — project, assignee, and the customer,
  // which the CRM resolves from the chat id. Available on an inherited note too:
  // acting on another department's hand-off is the point of sharing it.
  const convertToTask = () => {
    createCrmTaskFromText(props.note.text || '', {peerId: props.peerId});
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if(e.key === 'Escape') {
      e.preventDefault();
      setEditing(false);
    } else if(e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      save();
    }
  };

  return (
    <div class={classNames('crm-note-chip', props.note.is_foreign && 'crm-note-chip--foreign')}>
      <div class="crm-note-chip-head">
        <IconTsx class="crm-note-chip-icon" icon="clipboard" />
        <span class="crm-note-chip-author">{props.note.author_name}</span>
        <Show when={props.note.is_foreign && props.note.department_name}>
          <span class="crm-note-chip-badge">
            {i18n('Crm.Note.FromDepartment', [props.note.department_name])}
          </span>
        </Show>
        <Show when={!props.note.is_foreign && isCrmNoteShared(props.note)}>
          <span class="crm-note-chip-badge">{i18n('Crm.Note.SharedBadge')}</span>
        </Show>
        <Show when={props.note.edited_at}>
          <span class="crm-note-chip-edited">{i18n('Crm.Note.Edited')}</span>
        </Show>
        <Show when={!editing() && !useIsCrmReadOnly()()}>
          <span class="crm-note-chip-actions">
            <button
              class="crm-note-chip-action"
              title={I18n.format('Crm.Note.ConvertToTask', true)}
              onClick={convertToTask}
            >
              <IconTsx icon="check" />
            </button>
            <Show when={canEditCrmNote(props.note)}>
              <button class="crm-note-chip-action" title={I18n.format('Edit', true)} onClick={startEdit}>
                <IconTsx icon="edit" />
              </button>
              <button
                class="crm-note-chip-action crm-note-chip-action--danger"
                title={I18n.format('Delete', true)}
                onClick={remove}
              >
                <IconTsx icon="delete" />
              </button>
            </Show>
          </span>
        </Show>
      </div>

      <Show
        when={editing()}
        fallback={<div class="crm-note-chip-text">{props.note.text}</div>}
      >
        <textarea
          class="crm-note-chip-textarea"
          rows={2}
          value={text()}
          disabled={busy()}
          ref={(el) => queueMicrotask(() => el.focus())}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <div class="crm-note-chip-edit-buttons">
          <Button class="btn-primary btn-transparent primary" onClick={() => setEditing(false)}>
            {i18n('Cancel')}
          </Button>
          <Button
            class="btn-primary btn-color-primary"
            disabled={busy() || !text().trim()}
            onClick={save}
          >
            {i18n('Save')}
          </Button>
        </div>
      </Show>
    </div>
  );
}

/**
 * One block of chips for the notes anchored to a single spot in the timeline.
 *
 * Returns the element to mount plus the dispose that tears its reactive roots
 * down — the caller rebuilds these wholesale whenever the note list changes, so
 * every returned dispose must be called or the listeners inside leak per rebuild.
 */
export function renderCrmNoteChips(peerId: PeerId, notes: CrmNote[]) {
  let element: HTMLElement;

  const dispose = createRoot((dispose) => {
    element = (
      <div
        class="crm-note-chips"
        // The block lives INSIDE a bubble, and bubble clicks are handled by a
        // delegate on the chat container (select, reply, open media). Without this
        // every press of an action button — or a drag to select note text — would
        // also act on the message the note happens to sit above.
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
      >
        <For each={notes}>{(note) => <CrmNoteChip peerId={peerId} note={note} />}</For>
      </div>
    ) as HTMLElement;

    // Nothing to clean beyond the root itself, but keeping the hook makes the
    // ownership explicit for anything added inside a chip later.
    onCleanup(() => element?.remove());

    return dispose;
  });

  return {element, dispose};
}

