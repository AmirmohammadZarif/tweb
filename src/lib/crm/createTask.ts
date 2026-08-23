import rootScope from '@lib/rootScope';
import {toastNew} from '@components/toast';
import appSidebarLeft from '@components/sidebarLeft';
import appImManager from '@lib/appImManager';
import mediaSizes from '@helpers/mediaSizes';
import {AppProjectTasksTab} from '@components/solidJsTabs/tabs';
import showCrmCreateTaskPopup, {CrmTaskSourceProps} from '@components/popups/crmCreateTask';

/**
 * Capture a CRM task from inside a conversation — the "/task <title>" command in
 * the message input, and the "create task" entry in a message's context menu.
 *
 * The composer popup does the rest: which project, who it goes to (the agent who
 * triggered it by default, but any project member can be picked), and the
 * customer the message came from, which the CRM resolves from the chat id.
 */

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

export default async function createCrmTaskFromText(rawTitle: string, source: CrmTaskSourceProps = {}) {
  const title = rawTitle.trim();
  if(!title) {
    openCrmTasksTab();
    return;
  }

  if(!(await rootScope.managers.appCrmManager.isConnected())) {
    toastNew({langPackKey: 'Tasks.NotConnected'});
    return;
  }

  showCrmCreateTaskPopup({...source, text: title});
}
