import {createRoot, createSignal} from 'solid-js';
import rootScope from '@lib/rootScope';

// CRM session state for the signed-in agent, exposed as two default-false
// signals so every gate fails closed until the CRM confirms otherwise:
// - isCrmLoggedIn: the agent has a live CRM session (enabled + baseUrl + token).
//   Drives the chatlist gate — no conversations are shown without a session.
// - isCrmSuperAdmin: the session's user has the superadmin role. Gates the
//   sensitive extras (active sessions, phone numbers, usernames, contacts).
// - isCrmReadOnly: the session's user is an onboarding trainee — reading only.
// Kept fresh by AppCrmManager.refreshMe() on app start + login; every persist()
// there fires crm_config_update, which re-reads both flags here. A 401 fires
// crm_auth_required, flipping both back to false.
const [isCrmLoggedIn, setIsCrmLoggedIn] = createRoot(() => createSignal(false));
const [isCrmSuperAdmin, setIsCrmSuperAdmin] = createRoot(() => createSignal(false));
// Onboarding trainee: read the department's conversations, change nothing. Drives
// every write affordance in the UI (composer, context menu, CRM actions) and
// forces peek mode, so not even a read receipt leaves this session.
const [isCrmReadOnly, setIsCrmReadOnly] = createRoot(() => createSignal(false));
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
    setIsCrmReadOnly(loggedIn && !!config.user?.is_read_only);
    setCrmUserId(loggedIn ? config.user?.id : undefined);
    setRequireSensitiveApproval(config.requireSensitiveApproval !== false);
  }, () => {
    setIsCrmLoggedIn(false);
    setIsCrmSuperAdmin(false);
    setIsCrmReadOnly(false);
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

// True only while a read-only session is signed in. Note this is the UI half of
// the gate: the managers refuse the write themselves (isReadOnlyCached) and the
// CRM refuses its own writes, so a missed button is not a hole.
export function useIsCrmReadOnly() {
  return isCrmReadOnly;
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
