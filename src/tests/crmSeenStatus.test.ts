import {loadChatBubbles, LOAD_CHAT_BUBBLES_TIMEOUT} from '@/tests/helpers/chatBubbles';
import '@helpers/peerIdPolyfill';
import {MESSAGE_ID_OFFSET} from '@appManagers/constants';

const role = vi.hoisted(() => ({readOnly: false}));
vi.mock('@stores/crmRole', async(importOriginal) => ({
  ...await importOriginal<typeof import('@stores/crmRole')>(),
  useIsCrmLoggedIn: () => () => true,
  useIsCrmReadOnly: () => () => role.readOnly
}));

beforeEach(() => { role.readOnly = false; });

let ChatBubbles: typeof import('@components/chat/bubbles').default;
let AppCrmManager: typeof import('@appManagers/appCrmManager').default;

beforeAll(async() => {
  ChatBubbles = (await loadChatBubbles()).bubbles.default;
  AppCrmManager = (await import('@appManagers/appCrmManager')).default;
}, LOAD_CHAT_BUBBLES_TIMEOUT);

const peerId = (123).toPeerId();
const mid = MESSAGE_ID_OFFSET + 40;

function makeBubbleHarness(out: boolean) {
  const bubble = document.createElement('div');
  bubble.innerHTML = '<div class="bubble-content"><div class="agent-tag agent-tag-seen">Wrong</div></div>';
  const harness = Object.assign(Object.create(ChatBubbles.prototype), {
    chat: {getMessage: () => ({_: 'message', pFlags: {out}})},
    crmFirstSeen: {'40': {admin_id: 1, name: 'Viewer'}},
    crmAttributions: {'40': {admin_id: 2, name: 'Author'}}
  });
  return {harness, bubble};
}

describe('CRM viewer labels', () => {
  it('filters outgoing ids before reporting a read burst to the CRM', async() => {
    const reportMessagesSeen = vi.fn(async() => ({}));
    const harness = Object.assign(Object.create(ChatBubbles.prototype), {
      crmFirstSeen: {}, getMiddleware: () => () => true,
      chat: {peerId, getMessage: (id: number) => ({_: 'message', pFlags: {out: id !== mid}})},
      managers: {appCrmManager: {reportMessagesSeen}}, retagAgentBubbles: vi.fn()
    });
    harness.reportSeenToCrm(peerId, [mid, mid + 1]);
    expect(reportMessagesSeen).toHaveBeenCalledWith('123', [40]);
  });

  it('rechecks held reads after waiting for window focus', async() => {
    const idleController = (await import('@helpers/idleController')).default;
    let focus: () => void;
    const focusPromise = new Promise<void>((resolve) => focus = resolve);
    const spy = vi.spyOn(idleController, 'getFocusPromise').mockReturnValue(focusPromise);
    const harness = Object.assign(Object.create(ChatBubbles.prototype), {
      chat: {isPreview: false}, unreadedSeen: new Set([mid]),
      isReadHeld: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
      getMiddleware: () => () => true
    });
    harness.readUnreaded('history');
    const pending = harness.readPromise;
    focus();
    await pending;
    expect(harness.readPromise).toBeUndefined();
    expect(harness.unreadedSeen.has(mid)).toBe(true);
    spy.mockRestore();
  });

  it('holds reads after an already-claimed agent becomes read-only', async() => {
    const {ChatType} = await import('@components/chat/chatType');
    role.readOnly = true;
    const harness = Object.assign(Object.create(ChatBubbles.prototype), {
      chat: {peerId, type: ChatType.Chat}, manualReadReleased: true
    });
    expect(harness.isReadHeld()).toBe(true);
  });

  it('never labels an outbound message as seen by an agent, even when aligned incoming', () => {
    const {harness, bubble} = makeBubbleHarness(true);
    harness.setBubbleAgentTag(bubble, peerId, mid, false);
    expect(bubble.querySelector('.agent-tag-seen')).toBeNull();
    expect(bubble.querySelector('.agent-tag')?.textContent).toBe('Author');
  });

  it('uses the first viewer for an inbound message', () => {
    const {harness, bubble} = makeBubbleHarness(false);
    harness.setBubbleAgentTag(bubble, peerId, mid, true);
    expect(bubble.querySelector('.agent-tag-seen')).not.toBeNull();
  });

  it('does not launch a read with an empty seen set', () => {
    const harness = Object.assign(Object.create(ChatBubbles.prototype), {
      chat: {isPreview: false}, isReadHeld: () => false,
      unreadedSeen: new Set(), getMiddleware: vi.fn()
    });
    harness.readUnreaded('history');
    expect(harness.getMiddleware).not.toHaveBeenCalled();
    expect(harness.readPromise).toBeUndefined();
  });

  it('does not read on scroll to bottom while peek mode holds reads', () => {
    const readHistory = vi.fn();
    const harness = Object.assign(Object.create(ChatBubbles.prototype), {
      chat: {isPreview: false}, isReadHeld: () => true,
      managers: {appMessagesManager: {readHistory}}
    });
    harness.onScrolledAllDown();
    expect(readHistory).not.toHaveBeenCalled();
  });
});

function makeCrmHarness() {
  return Object.assign(new AppCrmManager() as any, {
    isConnected: async() => true,
    sessionTelegramUserId: () => '777',
    request: vi.fn(),
    rootScope: {dispatchEvent: vi.fn()},
    log: {error: vi.fn()}
  });
}

describe('shared-session viewer cache', () => {
  it('allows the server to correct a preexisting invalid viewer summary', async() => {
    const manager = makeCrmHarness();
    manager.rememberFirstSeen('123', {'30': {admin_id: 1, name: 'Invalid'}});
    manager.request.mockResolvedValue({data: {'123': {message_id: 10, admin_id: 2, name: 'Actual'}}});
    manager.pendingFirstSeenPeerIds.add(peerId);
    await manager.flushFirstSeenBatch();
    expect(manager.getFirstSeenCached(peerId)).toMatchObject({message_id: 10, name: 'Actual'});
  });

  it('retains successful chunks if a later report fails', async() => {
    const manager = makeCrmHarness();
    manager.request.mockResolvedValueOnce({data: {'1': {admin_id: 1, name: 'A'}}})
    .mockRejectedValueOnce(new Error('offline'));
    const result = await manager.reportMessagesSeen('123', Array.from({length: 201}, (_, i) => i + 1));
    expect(result).toHaveProperty('1');
    expect(manager.getFirstSeenCached(peerId).message_id).toBe(1);
  });

  it('splits a large claim into API-sized bursts without losing viewers', async() => {
    const manager = makeCrmHarness();
    manager.request.mockImplementation(async(_method: string, _url: string, {body}: any) => ({
      data: Object.fromEntries(body.message_ids.map((id: number) => [id, {name: 'A', admin_id: 1}]))
    }));
    const result = await manager.reportMessagesSeen('123', Array.from({length: 450}, (_, i) => i + 1));
    expect(manager.request.mock.calls.map((call: any) => call[2].body.message_ids.length)).toEqual([200, 200, 50]);
    expect(Object.keys(result)).toHaveLength(450);
    expect(manager.getFirstSeenCached(peerId).message_id).toBe(450);
  });

  it.each([{}, {'123': {message_id: 10, admin_id: 1, name: 'Old'}}])(
    'keeps a newer viewer when an older summary request completes late: %j', async(summary) => {
      const manager = makeCrmHarness();
      let resolve: (value: any) => void;
      manager.request.mockReturnValue(new Promise((r) => resolve = r));
      manager.pendingFirstSeenPeerIds.add(peerId);
      const pending = manager.flushFirstSeenBatch();
      manager.rememberFirstSeen('123', {'20': {admin_id: 2, name: 'New'}});
      resolve({data: summary});
      await pending;
      expect(manager.getFirstSeenCached(peerId)).toMatchObject({message_id: 20, name: 'New'});
    }
  );
});


describe('read update ordering', () => {
  it.each(['updateReadHistoryInbox', 'updateReadHistoryOutbox'])(
    'ignores a stale %s without moving the cursor or unread count backward', async(type) => {
      const {AppMessagesManager} = await import('@appManagers/appMessagesManager');
      const storage = {readMaxId: mid + 10, readOutboxMaxId: mid + 10};
      const dialog = {unread_count: 0, read_inbox_max_id: mid + 10, read_outbox_max_id: mid + 10};
      const dispatchEvent = vi.fn();
      const manager = Object.assign(new AppMessagesManager() as any, {
        appMessagesIdsManager: {generateMessageId: (id: number) => id || 0},
        appPeersManager: {getPeerId: () => peerId, isBotforum: () => false},
        getMonoforumThreadId: (): PeerId | undefined => undefined,
        getHistoryMessagesStorage: () => new Map(), getHistoryStorage: () => storage,
        getDialogOnly: () => dialog, rootScope: {dispatchEvent}
      });
      manager.onUpdateReadHistory({_: type, max_id: mid, peer: {}, still_unread_count: 5});
      expect(storage).toEqual({readMaxId: mid + 10, readOutboxMaxId: mid + 10});
      expect(dialog.unread_count).toBe(0);
      expect(dispatchEvent).not.toHaveBeenCalled();
    }
  );
});

describe('department viewer feed', () => {
  it('updates unopened peers and reconciles summaries after reconnect', async() => {
    const realtime = (await import('@lib/crm/crmRealtime')).default as any;
    const rootScope = (await import('@lib/rootScope')).default;
    const originalManagers = rootScope.managers;
    const refreshFirstSeenSummaries = vi.fn();
    const handlers = new Map<string, (data?: any) => void>();
    const dispatch = vi.spyOn(rootScope, 'dispatchEvent');
    try {
      rootScope.managers = {appCrmManager: {refreshFirstSeenSummaries}} as any;
      realtime.subscribeNotes({subscribe: () => ({bind: (name: string, callback: (data?: any) => void) => handlers.set(name, callback)})}, '777');
      handlers.get('inbound.seen')({peer_chat_id: '456', seen: {'10': {admin_id: 1, name: 'A'}}});
      expect(dispatch).toHaveBeenCalledWith('crm_first_seen_push', {
        peerId: (456).toPeerId(), seen: {'10': {admin_id: 1, name: 'A'}}
      });
      handlers.get('pusher:subscription_succeeded')();
      expect(refreshFirstSeenSummaries).toHaveBeenCalledOnce();
    } finally {
      rootScope.managers = originalManagers;
      realtime.teardown();
      dispatch.mockRestore();
    }
  });
});
