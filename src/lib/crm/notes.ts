import rootScope from '@lib/rootScope';
import {toastNew} from '@components/toast';
import useIsCrmSuperAdmin, {useCrmUserId} from '@stores/crmRole';
import {CrmNote, CrmNoteVisibility} from './types';

// Shared behaviour for internal agent notes, so the three places that render them
// — the timeline chips, the topbar popup and the profile's Notes tab — agree on
// who may change a note and what happens when one does.

/**
 * May THIS agent edit or delete this note?
 *
 * Deliberately recomputed on the client rather than trusting the note's own
 * `can_edit`: realtime pushes are per department CHANNEL, and several agents share
 * one, so the server cannot stamp a per-viewer answer onto a broadcast. The CRM
 * enforces the same rule again on the write, so a wrong answer here costs an
 * affordance, never access.
 */
export function canEditCrmNote(note: CrmNote): boolean {
  if(!note) return false;
  if(useIsCrmSuperAdmin()()) return true;
  // A note left in another department's conversation is context, not ours to
  // rewrite — even for its author, who would be editing it out of the chat it
  // belongs to.
  if(note.is_foreign) return false;
  const me = useCrmUserId()();
  return me !== undefined && note.author_id === me;
}

export function isCrmNoteShared(note: CrmNote): boolean {
  return note?.visibility === 'all';
}

/** Newest-last, matching how notes are read: oldest hand-off first. */
export function sortCrmNotes(notes: CrmNote[]): CrmNote[] {
  return notes.slice().sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

/**
 * Merge one note into a list by id — the same operation for an add and an edit,
 * because a push carries the whole note either way. The id filter also absorbs the
 * race between our own optimistic append and the Reverb echo of that same write.
 */
export function mergeCrmNote(notes: CrmNote[], note: CrmNote): CrmNote[] {
  if(!note?.id) return notes;
  return sortCrmNotes(notes.filter((n) => n.id !== note.id).concat(note));
}

const errorStatus = (err: unknown) => (err as Error & {status?: number})?.status;

/**
 * Save an edit, telling every other view about it through the same push the CRM
 * broadcasts, so the timeline chips and the other panel update without refetching.
 * Resolves to the saved note, or undefined once the failure has been toasted.
 */
export async function saveCrmNote(
  peerId: PeerId,
  noteId: number,
  changes: {text?: string, visibility?: CrmNoteVisibility}
): Promise<CrmNote | undefined> {
  if(!peerId?.isUser() || !noteId) return undefined;

  try {
    const note = await rootScope.managers.appCrmManager.updateNoteByTelegram(
      '' + peerId.toUserId(),
      noteId,
      changes
    );
    if(!note) return undefined;
    rootScope.dispatchEvent('crm_note_push', {peerId, note});
    return note;
  } catch(err) {
    const status = errorStatus(err);
    toastNew({langPackKey: status === 403 ? 'Crm.Note.EditForbidden' : 'Crm.Note.EditFailed'});
    return undefined;
  }
}

/** Delete a note, then tell every other view. Returns whether it went through. */
export async function deleteCrmNote(peerId: PeerId, noteId: number): Promise<boolean> {
  if(!peerId?.isUser() || !noteId) return false;

  try {
    await rootScope.managers.appCrmManager.deleteNoteByTelegram('' + peerId.toUserId(), noteId);
    rootScope.dispatchEvent('crm_note_delete_push', {peerId, noteId});
    return true;
  } catch(err) {
    const status = errorStatus(err);
    toastNew({langPackKey: status === 403 ? 'Crm.Note.EditForbidden' : 'Crm.Note.DeleteFailed'});
    return false;
  }
}

/** Add a note, then tell every other view. Undefined once the failure is toasted. */
export async function addCrmNote(
  peerId: PeerId,
  text: string,
  visibility: CrmNoteVisibility
): Promise<CrmNote | undefined> {
  const value = (text || '').trim();
  if(!value || !peerId?.isUser()) return undefined;

  try {
    const note = await rootScope.managers.appCrmManager.addNoteByTelegram(
      '' + peerId.toUserId(),
      value,
      visibility
    );
    if(!note) {
      toastNew({langPackKey: 'Crm.Note.NoTicket'});
      return undefined;
    }

    rootScope.dispatchEvent('crm_note_push', {peerId, note});
    return note;
  } catch(err) {
    const status = errorStatus(err);
    toastNew({langPackKey: status === 404 ? 'Crm.Note.NoTicket' : 'Crm.Note.AddFailed'});
    return undefined;
  }
}
