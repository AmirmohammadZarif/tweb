import {createRoot, createSignal} from 'solid-js';
import rootScope from '@lib/rootScope';

// CRM session state for the signed-in agent, exposed as two default-false
// signals so every gate fails closed until the CRM confirms otherwise:
// - isCrmLoggedIn: the agent has a live CRM session (enabled + baseUrl + token).
//   Drives the chatlist gate — no conversations are shown without a session.
// - isCrmSuperAdmin: the session's user has the superadmin role. Gates the
//   sensitive extras (active sessions, phone numbers, usernames, contacts).
// Kept fresh by AppCrmManager.refreshMe() on app start + login; every persist()
// there fires crm_config_update, which re-reads both flags here. A 401 fires
// crm_auth_required, flipping both back to false.
const [isCrmLoggedIn, setIsCrmLoggedIn] = createRoot(() => createSignal(false));
const [isCrmSuperAdmin, setIsCrmSuperAdmin] = createRoot(() => createSignal(false));
// The signed-in agent's own CRM id (undefined when logged out). Used to match
// per-agent sensitive-reveal approvals — see the sensitive-message workflow.
const [crmUserId, setCrmUserId] = createRoot(() => createSignal<number | undefined>(undefined));
// Whether revealing sensitive content needs superadmin approval. Defaults true
// (fail-safe): approval is assumed required until /config says otherwise.
const [requireSensitiveApproval, setRequireSensitiveApproval] = createRoot(() => createSignal(true));

const refresh = () => {
  rootScope.managers.appCrmManager.getConfig().then((config) => {
    const loggedIn = !!(config.enabled && config.baseUrl && config.token);
    setIsCrmLoggedIn(loggedIn);
    setIsCrmSuperAdmin(loggedIn && !!config.user?.is_super_admin);
    setCrmUserId(loggedIn ? config.user?.id : undefined);
    setRequireSensitiveApproval(config.requireSensitiveApproval !== false);
  }, () => {
    setIsCrmLoggedIn(false);
    setIsCrmSuperAdmin(false);
    setCrmUserId(undefined);
    setRequireSensitiveApproval(true);
  });
};

rootScope.addEventListener('crm_config_update', refresh);
rootScope.addEventListener('crm_auth_required', refresh);
if(rootScope.myId) {
  refresh();
} else {
  rootScope.addEventListener('user_auth', refresh);
}

export function useIsCrmLoggedIn() {
  return isCrmLoggedIn;
}

export function useCrmUserId() {
  return crmUserId;
}

export function useSensitiveRequireApproval() {
  return requireSensitiveApproval;
}

export default function useIsCrmSuperAdmin() {
  return isCrmSuperAdmin;
}
