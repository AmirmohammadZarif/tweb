import rootScope from '@lib/rootScope';
import {toast, toastNew} from '@components/toast';
import PopupPeer from '@components/popups/peer';
import type {CrmProject} from '@lib/crm/types';
import appSidebarLeft from '@components/sidebarLeft';
import appImManager from '@lib/appImManager';
import mediaSizes from '@helpers/mediaSizes';
import {AppProjectTasksTab} from '@components/solidJsTabs/tabs';

/**
 * Capture a CRM task from inside a conversation — the "/task <title>" command in
 * the message input, and the "create task" entry in a message's context menu.
 *
 * The task is assigned to the agent who triggered it (the CRM does that when no
 * assignees are sent), because the point is "log the thing I just agreed to do"
 * without leaving the chat.
 */

// Prefer the CRM's own message (e.g. "You do not have access to this project.")
// over a generic string, matching agentMetrics/projectTasks.
const showCrmError = (err: any) => {
  const message = typeof err?.message === 'string' && !err.message.startsWith('CRM_') ? err.message : '';
  if(message) toast(message);
  else toastNew({langPackKey: 'Tasks.CreateFailed'});
};

const create = async(projectId: number, title: string) => {
  try {
    await rootScope.managers.appCrmManager.createTask({project_id: projectId, title});
    toastNew({langPackKey: 'Tasks.Created'});
  } catch(err) {
    showCrmError(err);
  }
};

/**
 * Open the My Tasks panel.
 *
 * On mobile the left column sits BEHIND the open chat, so creating the tab alone
 * leaves it invisible until the user presses back. Closing the current chat
 * first is what actually reveals it — on desktop both columns are visible, so
 * closing the chat there would be destructive for no gain.
 */
export function openCrmTasksTab() {
  if(mediaSizes.isMobile) {
    appImManager.setPeer(); // closes the chat, revealing the left column
  }

  appSidebarLeft.createTab(AppProjectTasksTab).open();
}

export default async function createCrmTaskFromText(rawTitle: string) {
  const title = rawTitle.trim();
  if(!title) {
    openCrmTasksTab();
    return;
  }

  if(!(await rootScope.managers.appCrmManager.isConnected())) {
    toastNew({langPackKey: 'Tasks.NotConnected'});
    return;
  }

  const projects: CrmProject[] = await rootScope.managers.appCrmManager.getProjects();

  if(!projects.length) {
    toastNew({langPackKey: 'Tasks.NoProjects'});
    return;
  }

  // One project — no point asking.
  if(projects.length === 1) {
    create(projects[0].id, title);
    return;
  }

  // Several — ask rather than silently guessing which project the work belongs
  // to, since picking wrong files the task where nobody will look for it.
  new PopupPeer('popup-crm-pick-project', {
    titleLangKey: 'Tasks.PickProject',
    descriptionLangKey: 'Tasks.PickProjectFor',
    descriptionLangArgs: [title],
    // PopupButton.text is a DOM node, not a string — project names are dynamic
    // so they cannot go through langKey.
    buttons: projects.slice(0, 8).map((project) => ({
      text: document.createTextNode(project.name),
      callback: () => create(project.id, title)
    }))
  }).show();
}
