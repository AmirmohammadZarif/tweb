import '@helpers/peerIdPolyfill';
import getServerMessageId from '@appManagers/utils/messageId/getServerMessageId';
import type {Message} from '@layer';

const role = vi.hoisted(() => ({loggedIn: true, superAdmin: false, userId: 7 as number | undefined}));

vi.mock('@stores/crmRole', () => ({
  default: () => () => role.superAdmin,
  useIsCrmLoggedIn: () => () => role.loggedIn,
  useCrmUserId: () => () => role.userId
}));

const {default: rootScope} = await import('@lib/rootScope');
const {isCrmMediaLocked} = await import('@stores/crmSensitiveReveals');

const PEER = (555111 as UserId).toPeerId(false);
const MID = 4242 * 2 ** 20;
const SERVER_MID = getServerMessageId(MID);

function photo(overrides: Partial<Message.message> = {}): Message.message {
  return {
    _: 'message',
    pFlags: {},
    id: SERVER_MID,
    mid: MID,
    peerId: PEER,
    date: 0,
    message: '',
    media: {_: 'messageMediaPhoto', pFlags: {}},
    ...overrides
  } as Message.message;
}

function openChat(state: {approved?: number[], media?: number[]}) {
  rootScope.dispatchEventSingle('crm_sensitive_reveals_update', {
    peerId: PEER,
    state: {approved: state.approved || [], pending: [], media: state.media || []}
  });
}

describe('CRM sensitive image lock', () => {
  beforeEach(() => {
    role.loggedIn = true;
    role.superAdmin = false;
    role.userId = 7;
  });

  it('locks a flagged customer image until this agent is approved', () => {
    expect(SERVER_MID).toBeGreaterThan(0);
    openChat({media: [SERVER_MID]});
    expect(isCrmMediaLocked(photo())).toBe(true);

    rootScope.dispatchEventSingle('crm_sensitive_reveal_push', {peerId: PEER, messageId: SERVER_MID, userId: 8});
    expect(isCrmMediaLocked(photo()), 'an approval for another agent changes nothing').toBe(true);

    rootScope.dispatchEventSingle('crm_sensitive_reveal_push', {peerId: PEER, messageId: SERVER_MID, userId: 7});
    expect(isCrmMediaLocked(photo())).toBe(false);
  });

  it('locks an image as soon as the analysis push arrives', () => {
    openChat({});
    expect(isCrmMediaLocked(photo())).toBe(false);
    rootScope.dispatchEventSingle('crm_sensitive_media_push', {peerId: PEER, messageId: SERVER_MID});
    expect(isCrmMediaLocked(photo())).toBe(true);
  });

  it('never locks for superadmins, signed-out sessions, outgoing images or other chats', () => {
    openChat({media: [SERVER_MID]});
    expect(isCrmMediaLocked(photo({pFlags: {out: true}}))).toBe(false);
    expect(isCrmMediaLocked(photo({peerId: (999 as UserId).toPeerId(false)}))).toBe(false);

    role.superAdmin = true;
    expect(isCrmMediaLocked(photo())).toBe(false);

    role.superAdmin = false;
    role.loggedIn = false;
    expect(isCrmMediaLocked(photo())).toBe(false);
  });

  it('keeps an approved image open when the chat state is reloaded', () => {
    openChat({media: [SERVER_MID], approved: [SERVER_MID]});
    expect(isCrmMediaLocked(photo())).toBe(false);
  });
});
