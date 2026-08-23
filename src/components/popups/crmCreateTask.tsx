import {createEffect, createResource, createSignal, For, on, Show} from 'solid-js';
import PopupElement, {createPopup} from '@components/popups/indexTsx';
import {I18nTsx} from '@helpers/solid/i18n';
import I18n, {i18n} from '@lib/langPack';
import rootScope from '@lib/rootScope';
import InputField from '@components/inputField';
import CheckboxFieldTsx from '@components/checkboxFieldTsx';
import Row from '@components/rowTsx';
import Scrollable from '@components/scrollable2';
import {PeerTitleTsx} from '@components/peerTitleTsx';
import {toast, toastNew} from '@components/toast';
import {CrmProject, CrmProjectMember} from '@lib/crm/types';
import getServerMessageId from '@appManagers/utils/messageId/getServerMessageId';

import styles from './crmCreateTask.module.scss';

/**
 * The CRM task composer: project, title, details, and who it goes to.
 *
 * Used from two places — "turn this message into a task" in a conversation
 * (which also carries the customer and the exact message), and "assign to
 * someone else" in the My Tasks panel, where there is no chat at all. Both need
 * the same thing: a task can go to OTHER agents, not only the person creating
 * it, and the full captured text survives even when the title has to be short.
 */

// A task title is capped at 255 by the CRM, but a readable one is far shorter.
// Longer captures keep their first line as the title and the whole text as the
// description, so nothing the customer wrote is thrown away.
const TITLE_LIMIT = 120;

const splitCapture = (raw: string) => {
  const text = raw.trim().replace(/\s+/g, ' ');
  if(text.length <= TITLE_LIMIT) return {title: text, description: ''};

  // Prefer breaking on a word so the title does not end mid-word.
  const cut = text.lastIndexOf(' ', TITLE_LIMIT);
  return {
    title: text.slice(0, cut > 40 ? cut : TITLE_LIMIT) + '…',
    description: raw.trim()
  };
};

// Prefer the CRM's own message ("Some of the chosen assignees cannot access this
// project.") over a generic string, matching projectTasks/agentMetrics.
const showCrmError = (err: any) => {
  const message = typeof err?.message === 'string' && !err.message.startsWith('CRM_') ? err.message : '';
  if(message) toast(message);
  else toastNew({langPackKey: 'Tasks.CreateFailed'});
};

export type CrmTaskSourceProps = {
  // The customer's chat. Provenance is attached only for user peers — the CRM
  // resolves a customer by telegram chat id, which a channel/group id is not.
  peerId?: PeerId,
  mid?: number
};

export default function showCrmCreateTaskPopup(props: CrmTaskSourceProps & {
  // Prefilled title. Empty when composing from scratch in the tasks panel.
  text?: string,
  // Lets the caller refresh its own list; the popup owns no list of its own.
  onCreated?: () => void
}) {
  const managers = rootScope.managers;
  const initial = splitCapture(props.text || '');
  const sourcePeerId = props.peerId?.isUser() ? props.peerId : undefined;

  createPopup(() => {
    const [projectId, setProjectId] = createSignal<number>();
    const [selected, setSelected] = createSignal<Set<number>>(new Set());
    const [busy, setBusy] = createSignal(false);

    const [projects] = createResource(() => managers.appCrmManager.getProjects());

    // Must be declared before the members resource below: createResource calls
    // its source immediately, so referencing this later would hit the temporal
    // dead zone and the picker would silently stay empty.
    const resolvedProjectId = () => projectId() ?? projects()?.[0]?.id;

    // Assignability is per project (see MobileProjectController::members), so the
    // list reloads whenever the project changes — picking someone who cannot see
    // the project is rejected by the CRM, not silently accepted. An undefined id
    // (projects still loading) correctly skips the fetch and re-runs once they
    // land, since createResource ignores a falsy source.
    const [members] = createResource(
      () => resolvedProjectId(),
      (id: number) => managers.appCrmManager.getProjectMembers(id)
    );

    // Default to "mine": a task with nobody on it is invisible work. The server
    // applies the same default, but preselecting makes it visible that handing
    // the task to someone else means UNCHECKING yourself.
    createEffect(on(members, (list) => {
      if(!list) return;
      const me = list.find((member) => member.is_me);
      setSelected(new Set(me ? [me.id] : []));
    }));

    const toggle = (member: CrmProjectMember, checked: boolean) => {
      const next = new Set(selected());
      checked ? next.add(member.id) : next.delete(member.id);
      setSelected(next);
    };

    const titleField = new InputField({
      label: 'Tasks.NewTitle',
      name: 'crm-task-title',
      plainText: true,
      maxLength: 255
    });
    titleField.setValueSilently(initial.title);

    const [description, setDescription] = createSignal(initial.description);

    const submit = async() => {
      const title = titleField.value.trim();
      const project = resolvedProjectId();

      if(!project || !title) {
        toastNew({langPackKey: 'Tasks.FillFields'});
        return false;
      }

      setBusy(true);
      try {
        await managers.appCrmManager.createTask({
          project_id: project,
          title,
          description: description().trim() || undefined,
          assignee_user_ids: selected().size ? Array.from(selected()) : undefined,
          source_peer_chat_id: sourcePeerId ? '' + sourcePeerId.toUserId() : undefined,
          // Server message ids are what the CRM stores everywhere else
          // (attributions, first-seen), so the coordinate matches those tables.
          source_message_id: sourcePeerId && props.mid ? getServerMessageId(props.mid) : undefined
        });
        toastNew({langPackKey: 'Tasks.Created'});
        props.onCreated?.();
      } catch(err) {
        showCrmError(err);
        setBusy(false);
        return false; // keep the popup open so the input is not lost
      }

      return true;
    };

    return (
      <PopupElement class={styles.popup} containerClass={styles.container} show>
        <PopupElement.Header>
          <PopupElement.CloseButton />
          <PopupElement.Title><I18nTsx key="Tasks.New" /></PopupElement.Title>
        </PopupElement.Header>

        <PopupElement.Body class={styles.body}>
          <Show when={sourcePeerId}>
            <div class={styles.customer}>
              <span class={styles.label}>{i18n('Tasks.ForCustomer')}</span>
              <PeerTitleTsx peerId={sourcePeerId} />
            </div>
          </Show>

          <Show
            when={projects()?.length}
            fallback={<div class={styles.empty}>{i18n('Tasks.NoProjects')}</div>}
          >
            <Show when={projects().length > 1}>
              <select
                class={styles.select}
                onChange={(e) => setProjectId(+e.currentTarget.value)}
              >
                <For each={projects()}>
                  {(project: CrmProject) => <option value={project.id}>{project.name}</option>}
                </For>
              </select>
            </Show>

            {titleField.container}

            <textarea
              class={styles.textarea}
              rows={3}
              placeholder={I18n.format('Tasks.Details', true)}
              value={description()}
              onInput={(e) => setDescription(e.currentTarget.value)}
            />

            <div class={styles.label}>{i18n('Tasks.AssignTo')}</div>
            <Show
              when={members()?.length}
              fallback={<div class={styles.empty}>{i18n('Tasks.NoMembers')}</div>}
            >
              <Scrollable class={styles.members}>
                <For each={members()}>
                  {(member: CrmProjectMember) => (
                    <Row>
                      <Row.CheckboxField>
                        <CheckboxFieldTsx
                          checked={selected().has(member.id)}
                          onChange={(checked) => toggle(member, checked)}
                        />
                      </Row.CheckboxField>
                      <Row.Title>{member.name}</Row.Title>
                    </Row>
                  )}
                </For>
              </Scrollable>
            </Show>
          </Show>
        </PopupElement.Body>

        <PopupElement.Buttons>
          <PopupElement.FooterButton langKey="Cancel" color="secondary" cancel />
          <PopupElement.FooterButton
            langKey="Tasks.Add"
            disabled={busy() || !projects()?.length}
            callback={submit}
          />
        </PopupElement.Buttons>
      </PopupElement>
    );
  });
}
