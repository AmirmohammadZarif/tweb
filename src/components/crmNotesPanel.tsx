import {createEffect, createSignal, For, on, onCleanup, Show} from 'solid-js';
import Button from '@components/buttonTsx';
import CheckboxFieldTsx from '@components/checkboxFieldTsx';
import {IconTsx} from '@components/iconTsx';
import Scrollable from '@components/scrollable2';
import confirmationPopup from '@components/confirmationPopup';
import classNames from '@helpers/string/classNames';
import I18n, {i18n} from '@lib/langPack';
import rootScope from '@lib/rootScope';
import {CrmNote, CrmNoteVisibility} from '@lib/crm/types';
import {
  addCrmNote,
  canEditCrmNote,
  deleteCrmNote,
  isCrmNoteShared,
  mergeCrmNote,
  saveCrmNote,
  sortCrmNotes
} from '@lib/crm/notes';
import createCrmTaskFromText from '@lib/crm/createTask';
import {useIsCrmReadOnly} from '@stores/crmRole';

// Internal-notes panel: agents leave context for each other on the customer's
// ticket without messaging the customer. Self-contained so the SAME markup serves
// both mounts — the topbar popup and the profile's shared-media tab — and either
// one works on its own (it backfills from the CRM itself rather than borrowing the
// chat plate's state).
//
// Cross-view sync rides the three rootScope events the chat plate already speaks:
// `crm_notes_update` (a whole list, from a backfill or the plate) refreshes us,
// `crm_note_push` (one note, from Reverb or from our own compose/edit) merges in,
// and `crm_note_delete_push` removes one. Every write here goes through
// @lib/crm/notes, which dispatches those same events — which is what keeps the
// plate, the timeline chips, the popup and the sidebar tab consistent without any
// of them owning the others.
export default function CrmNotesPanel(props: {
  peerId: PeerId,
  class?: string,
  /** Give the list its own scroller (the popup). The sidebar tab scrolls as a whole. */
  scroll?: boolean,
  onCountChange?: (count: number) => void
}) {
  const [notes, setNotes] = createSignal<CrmNote[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [text, setText] = createSignal('');
  // Notes stay department-scoped unless the agent says otherwise — the toggle is
  // for the occasional "the other departments need to know this", not the default.
  const [shareAll, setShareAll] = createSignal(false);
  // id of the note currently open for editing, plus its working copy.
  const [editingId, setEditingId] = createSignal<number | undefined>();
  const [editText, setEditText] = createSignal('');

  const apply = (list: CrmNote[]) => {
    setNotes(sortCrmNotes(list));
    props.onCountChange?.(list.length);
  };

  // Bumps on every peer change so a stale response can't overwrite a newer one.
  let generation = 0;
  createEffect(on(() => props.peerId, (peerId) => {
    const current = ++generation;
    apply([]);
    setText('');
    setShareAll(false);
    setEditingId(undefined);
    if(!peerId?.isUser()) return;

    rootScope.managers.appCrmManager.getNotesByTelegram('' + peerId.toUserId()).then((result) => {
      if(generation !== current) return;
      apply(result.notes || []);
    });
  }));

  const onNotesUpdate = ({peerId, notes: list}: {peerId: PeerId, notes: CrmNote[]}) => {
    if(peerId !== props.peerId) return;
    apply(list || []);
  };

  const onNotePush = ({peerId, note}: {peerId: PeerId, note: CrmNote}) => {
    if(peerId !== props.peerId) return;
    apply(mergeCrmNote(notes(), note));
  };

  const onNoteDelete = ({peerId, noteId}: {peerId: PeerId, noteId: number}) => {
    if(peerId !== props.peerId) return;
    if(editingId() === noteId) setEditingId(undefined);
    apply(notes().filter((n) => n.id !== noteId));
  };

  rootScope.addEventListener('crm_notes_update', onNotesUpdate);
  rootScope.addEventListener('crm_note_push', onNotePush);
  rootScope.addEventListener('crm_note_delete_push', onNoteDelete);
  onCleanup(() => {
    rootScope.removeEventListener('crm_notes_update', onNotesUpdate);
    rootScope.removeEventListener('crm_note_push', onNotePush);
    rootScope.removeEventListener('crm_note_delete_push', onNoteDelete);
  });

  const visibility = (): CrmNoteVisibility => shareAll() ? 'all' : 'department';

  const submit = async() => {
    const value = text().trim();
    if(!value || busy()) return;

    setBusy(true);
    try {
      const note = await addCrmNote(props.peerId, value, visibility());
      if(note) {
        setText('');
        setShareAll(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (note: CrmNote) => {
    setEditingId(note.id);
    setEditText(note.text || '');
  };

  const saveEdit = async(note: CrmNote) => {
    const value = editText().trim();
    if(!value || busy()) return;
    if(value === note.text) {
      setEditingId(undefined);
      return;
    }

    setBusy(true);
    try {
      const saved = await saveCrmNote(props.peerId, note.id, {text: value});
      if(saved) setEditingId(undefined);
    } finally {
      setBusy(false);
    }
  };

  const toggleShared = async(note: CrmNote, share: boolean) => {
    if(busy()) return;
    setBusy(true);
    try {
      await saveCrmNote(props.peerId, note.id, {visibility: share ? 'all' : 'department'});
    } finally {
      setBusy(false);
    }
  };

  const remove = async(note: CrmNote) => {
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
      await deleteCrmNote(props.peerId, note.id);
    } finally {
      setBusy(false);
    }
  };

  // Hand the note off as a task instead of leaving it for whoever reads next. The
  // composer takes it from here; available on an inherited note too, since acting
  // on another department's hand-off is the point of sharing it.
  const convertToTask = (note: CrmNote) => {
    createCrmTaskFromText(note.text || '', {peerId: props.peerId});
  };

  const formatTime = (iso: string) => {
    const date = new Date(iso);
    return isNaN(date.getTime()) ? '' : date.toLocaleString();
  };

  // Enter submits, Shift+Enter inserts a newline — mirrors composing a message.
  const onComposeKeyDown = (e: KeyboardEvent) => {
    if(e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onEditKeyDown = (e: KeyboardEvent, note: CrmNote) => {
    if(e.key === 'Escape') {
      e.preventDefault();
      setEditingId(undefined);
      return;
    }

    if(e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEdit(note);
    }
  };

  const noteItem = (note: CrmNote) => {
    const editing = () => editingId() === note.id;
    const editable = () => canEditCrmNote(note);

    return (
      <div class={classNames('crm-notes-item', note.is_foreign && 'crm-notes-item--foreign')}>
        <div class="crm-notes-item-head">
          <span class="crm-notes-item-author">{note.author_name}</span>
          {/* Where a note came from only matters once it can travel: a shared note
              reads differently depending on whether this is the department that
              wrote it or one that inherited it. */}
          <Show when={note.is_foreign && note.department_name}>
            <span class="crm-notes-item-badge crm-notes-item-badge--foreign">
              {i18n('Crm.Note.FromDepartment', [note.department_name])}
            </span>
          </Show>
          <Show when={!note.is_foreign && isCrmNoteShared(note)}>
            <span class="crm-notes-item-badge">{i18n('Crm.Note.SharedBadge')}</span>
          </Show>
          <span class="crm-notes-item-time">
            {formatTime(note.created_at)}
            <Show when={note.edited_at}>
              {' · '}{i18n('Crm.Note.Edited')}
            </Show>
          </span>
          <Show when={!editing() && !useIsCrmReadOnly()()}>
            <span class="crm-notes-item-actions">
              <button
                class="crm-notes-item-action"
                title={I18n.format('Crm.Note.ConvertToTask', true)}
                onClick={() => convertToTask(note)}
              >
                <IconTsx icon="check" />
              </button>
              <Show when={editable()}>
                <button
                  class="crm-notes-item-action"
                  title={I18n.format('Edit', true)}
                  onClick={() => startEdit(note)}
                >
                  <IconTsx icon="edit" />
                </button>
                <button
                  class="crm-notes-item-action crm-notes-item-action--danger"
                  title={I18n.format('Delete', true)}
                  onClick={() => remove(note)}
                >
                  <IconTsx icon="delete" />
                </button>
              </Show>
            </span>
          </Show>
        </div>

        <Show
          when={editing()}
          fallback={<div class="crm-notes-item-text">{note.text}</div>}
        >
          <textarea
            class="crm-notes-textarea"
            rows={3}
            value={editText()}
            disabled={busy()}
            ref={(el) => queueMicrotask(() => el.focus())}
            onInput={(e) => setEditText(e.currentTarget.value)}
            onKeyDown={(e) => onEditKeyDown(e, note)}
          />
          <div class="crm-notes-item-edit-actions">
            <CheckboxFieldTsx
              toggle
              text="Crm.Note.ShareAllDepartments"
              checked={isCrmNoteShared(note)}
              onChange={(checked) => toggleShared(note, checked)}
            />
            <div class="crm-notes-item-edit-buttons">
              <Button
                class="btn-primary btn-transparent primary"
                onClick={() => setEditingId(undefined)}
              >
                {i18n('Cancel')}
              </Button>
              <Button
                class="btn-primary btn-color-primary"
                disabled={busy() || !editText().trim()}
                onClick={() => saveEdit(note)}
              >
                {i18n('Save')}
              </Button>
            </div>
          </div>
        </Show>
      </div>
    );
  };

  const list = () => <For each={notes()}>{noteItem}</For>;

  return (
    <div class={classNames('crm-notes', props.scroll && 'crm-notes--scroll', props.class)}>
      <Show
        when={notes().length}
        fallback={<div class="crm-notes-empty">{i18n('Crm.Note.None')}</div>}
      >
        <Show when={props.scroll} fallback={<div class="crm-notes-list">{list()}</div>}>
          <Scrollable class="crm-notes-list">{list()}</Scrollable>
        </Show>
      </Show>
      {/* Read-only trainees still READ their colleagues' notes — that is most of
          the value during onboarding — they just have no way to add one. */}
      <Show when={!useIsCrmReadOnly()()}>
        <div class="crm-notes-compose">
          <textarea
            class="crm-notes-textarea"
            rows={3}
            placeholder={I18n.format('Crm.Note.Placeholder', true)}
            value={text()}
            disabled={busy()}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={onComposeKeyDown}
          />
          <CheckboxFieldTsx
            class="crm-notes-share"
            toggle
            text="Crm.Note.ShareAllDepartments"
            checked={shareAll()}
            onChange={setShareAll}
          />
          <Button
            class="btn-primary btn-color-primary crm-notes-submit"
            disabled={busy() || !text().trim()}
            onClick={submit}
          >
            {i18n('Crm.Note.Add')}
          </Button>
        </div>
      </Show>
    </div>
  );
}

