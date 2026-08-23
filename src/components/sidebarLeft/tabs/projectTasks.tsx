import styles from './projectTasks.module.scss';
import Section from '@components/section';
import Row from '@components/rowTsx';
import Button from '@components/buttonTsx';
import {createResource, createSignal, For, Show} from 'solid-js';
import {i18n, LangPackKey} from '@lib/langPack';
import rootScope from '@lib/rootScope';
import InputField from '@components/inputField';
import {toast, toastNew} from '@components/toast';
import {CrmTask, CrmTaskStatus} from '@lib/crm/types';
import classNames from '@helpers/string/classNames';
import appImManager from '@lib/appImManager';
import showCrmCreateTaskPopup from '@components/popups/crmCreateTask';
import I18n from '@lib/langPack';

// Prefer the CRM's own error text (e.g. "You do not have access to this
// project."); fall back to a generic localized message. Mirrors agentMetrics.
const showCrmError = (err: any, fallback: LangPackKey) => {
  const message = typeof err?.message === 'string' && !err.message.startsWith('CRM_') ? err.message : '';
  if(message) toast(message);
  else toastNew({langPackKey: fallback});
};

const formatMinutes = (minutes: number) => {
  if(!minutes || minutes <= 0) return '—';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if(!hours) return rest + 'm';
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
};

const formatDue = (iso?: string) => {
  if(!iso) return '';
  const date = new Date(iso);
  if(isNaN(date.getTime())) return '';
  return date.toLocaleDateString();
};

// One-tap increments. Time tracking only gets used if logging is cheaper than
// the work of remembering to log it — a form would defeat the purpose.
const QUICK_MINUTES = [15, 30, 60];

export default function ProjectTasks() {
  const managers = rootScope.managers;

  const [includeDone, setIncludeDone] = createSignal(false);
  // A task handed to a colleague leaves "assigned to me" entirely, so without
  // this the agent who created it can no longer see it anywhere in the client.
  const [includeCreated, setIncludeCreated] = createSignal(false);
  const [expandedId, setExpandedId] = createSignal<number>();
  const [busy, setBusy] = createSignal(false);
  const [newProjectId, setNewProjectId] = createSignal<number>();

  const [projects] = createResource(() => managers.appCrmManager.getProjects());
  // The source MUST stay truthy. createResource skips the fetcher entirely when
  // its source returns false/null/undefined, so passing the `includeDone` signal
  // directly meant the list never loaded until the toggle was flipped on — and
  // flipping it back off then left the stale "with completed" result on screen.
  // An object is always truthy and still changes identity on every toggle.
  const [tasks, {refetch}] = createResource(
    () => ({includeDone: includeDone(), includeCreated: includeCreated()}),
    (query: {includeDone: boolean, includeCreated: boolean}) => managers.appCrmManager.getMyTasks(query)
  );

  const titleField = new InputField({
    label: 'Tasks.NewTitle',
    name: 'crm-task-title',
    plainText: true,
    maxLength: 255
  });

  const resolvedProjectId = () => newProjectId() ?? projects()?.[0]?.id;

  const createTask = async() => {
    const title = titleField.value.trim();
    const projectId = resolvedProjectId();

    if(!projectId || !title) {
      toastNew({langPackKey: 'Tasks.FillFields'});
      return;
    }

    setBusy(true);
    try {
      await managers.appCrmManager.createTask({project_id: projectId, title});
      titleField.setValueSilently('');
      toastNew({langPackKey: 'Tasks.Created'});
      refetch();
    } catch(err) {
      showCrmError(err, 'Tasks.CreateFailed');
    } finally {
      setBusy(false);
    }
  };

  // The inline form above is the fast path: one field, straight onto my own
  // list. Handing work to someone else needs a project-scoped assignee picker,
  // which is the composer the chat entry points already use — so reuse it
  // rather than growing a second one here.
  const createForSomeoneElse = () => {
    showCrmCreateTaskPopup({
      text: titleField.value.trim(),
      onCreated: () => {
        titleField.setValueSilently('');
        // A task created for someone else is invisible in the default list;
        // switching the toggle on is what makes the result of the action show up.
        setIncludeCreated(true);
        refetch();
      }
    });
  };

  const logTime = async(task: CrmTask, minutes: number) => {
    setBusy(true);
    try {
      await managers.appCrmManager.logTaskTime(task.id, minutes);
      toastNew({langPackKey: 'Tasks.TimeLogged'});
      refetch();
    } catch(err) {
      showCrmError(err, 'Tasks.TimeFailed');
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async(task: CrmTask, status: CrmTaskStatus) => {
    setBusy(true);
    try {
      await managers.appCrmManager.setTaskStatus(task.id, status);
      refetch();
    } catch(err) {
      showCrmError(err, 'Tasks.StatusFailed');
    } finally {
      setBusy(false);
    }
  };

  const toggleExpanded = (task: CrmTask) => {
    setExpandedId(expandedId() === task.id ? undefined : task.id);
  };

  // Tasks captured from a conversation carry the customer and the exact message.
  // Jumping straight back to it is the whole point of storing the coordinate —
  // otherwise the agent has to search the chat list for a name.
  const openSource = (task: CrmTask) => {
    const chatId = task.source?.peer_chat_id || task.customer?.telegram_chat_id;
    if(!chatId) return;

    appImManager.setInnerPeer({
      peerId: chatId.toPeerId(false),
      // For user peers the client mid IS the server id (generateMessageId only
      // offsets channels), so the stored id can be jumped to as-is.
      lastMsgId: task.source?.message_id
    });
  };

  const subtitleFor = (task: CrmTask) => {
    const parts: string[] = [];
    if(task.project?.name) parts.push(task.project.name);
    if(task.customer?.name) parts.push(task.customer.name);
    parts.push(task.status_label);

    if(task.is_assigned_to_me === false) {
      // Not my work — say whose it is, otherwise it reads as a task I owe.
      const names = (task.assignees || []).map((assignee) => assignee.name).join(', ');
      parts.push(names || I18n.format('Tasks.Delegated', true));
    } else {
      // Who else is on it — a task shared with someone reads very differently
      // from one that is only yours.
      const others = (task.assignees || []).length - 1;
      if(others > 0) parts.push('+' + others);
    }
    if(task.my_spent_minutes > 0 || task.my_estimate_minutes > 0) {
      parts.push(`${formatMinutes(task.my_spent_minutes)} / ${formatMinutes(task.my_estimate_minutes)}`);
    }
    return parts.join(' · ');
  };

  return (
    <>
      <Section name="Tasks.New">
        <Show
          when={projects()?.length}
          fallback={<div class={styles.empty}>{i18n('Tasks.NoProjects')}</div>}
        >
          <div class={styles.inlineForm}>
            <select
              class="input-field-input"
              onChange={(e) => setNewProjectId(+e.currentTarget.value)}
            >
              <For each={projects()}>
                {(project) => <option value={project.id}>{project.name}</option>}
              </For>
            </select>

            {titleField.container}

            <Button
              class="btn-primary btn-color-primary"
              onClick={createTask}
              disabled={busy()}
            >
              {i18n('Tasks.Add')}
            </Button>

            <Button
              class="btn-primary btn-transparent primary"
              icon="adduser"
              onClick={createForSomeoneElse}
              disabled={busy()}
            >
              {i18n('Tasks.ForSomeoneElse')}
            </Button>
          </div>
        </Show>
      </Section>

      <Section name="Tasks.Mine" caption="Tasks.Caption">
        <Row clickable={() => setIncludeDone(!includeDone())}>
          <Row.Title>{i18n('Tasks.ShowDone')}</Row.Title>
          <Row.RightContent>
            <span class={styles.badge}>{includeDone() ? '✓' : '—'}</span>
          </Row.RightContent>
        </Row>

        <Row clickable={() => setIncludeCreated(!includeCreated())}>
          <Row.Title>{i18n('Tasks.ShowDelegated')}</Row.Title>
          <Row.RightContent>
            <span class={styles.badge}>{includeCreated() ? '✓' : '—'}</span>
          </Row.RightContent>
        </Row>

        <Show
          when={tasks()?.length}
          fallback={<div class={styles.empty}>{i18n('Tasks.Empty')}</div>}
        >
          <For each={tasks()}>
            {(task) => (
              <>
                <Row clickable={() => toggleExpanded(task)}>
                  <Row.Title>
                    <span class={classNames(task.status === 'done' && styles.done)}>{task.title}</span>
                  </Row.Title>
                  <Row.Subtitle>
                    <span class={styles.meta}>
                      <span>{subtitleFor(task)}</span>
                      <Show when={task.due_at}>
                        <span class={classNames(styles.badge, task.is_overdue && styles.overdue)}>
                          {formatDue(task.due_at)}
                        </span>
                      </Show>
                    </span>
                    <Show when={task.my_estimate_minutes > 0}>
                      <div class={styles.progressTrack}>
                        <div
                          class={styles.progressBar}
                          style={{width: Math.min(100, task.my_progress) + '%'}}
                        />
                      </div>
                    </Show>
                  </Row.Subtitle>
                </Row>

                <Show when={expandedId() === task.id}>
                  <div class={styles.actions}>
                    <For each={QUICK_MINUTES}>
                      {(minutes) => (
                        <Button
                          class="btn-primary btn-transparent primary"
                          onClick={() => logTime(task, minutes)}
                          disabled={busy()}
                        >
                          {'+' + formatMinutes(minutes)}
                        </Button>
                      )}
                    </For>

                    <Show when={task.source?.peer_chat_id || task.customer?.telegram_chat_id}>
                      <Button
                        class="btn-primary btn-transparent primary"
                        onClick={() => openSource(task)}
                      >
                        {i18n('Tasks.OpenChat')}
                      </Button>
                    </Show>

                    <Button
                      class="btn-primary btn-transparent primary"
                      onClick={() => setStatus(task, task.status === 'done' ? 'todo' : 'done')}
                      disabled={busy()}
                    >
                      {task.status === 'done' ? i18n('Tasks.Reopen') : i18n('Tasks.MarkDone')}
                    </Button>
                  </div>
                </Show>
              </>
            )}
          </For>
        </Show>
      </Section>
    </>
  );
}
