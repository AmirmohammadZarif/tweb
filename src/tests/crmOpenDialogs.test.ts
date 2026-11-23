import {describe, expect, it, vi} from 'vitest';
import '@helpers/peerIdPolyfill';
import {AppMessagesManager, Dialog} from '@appManagers/appMessagesManager';
import {GLOBAL_FOLDER_ID} from '@lib/storages/dialogs';

function harness() {
  const cache = new Map<PeerId, Dialog>();
  const manager = Object.assign(Object.create(AppMessagesManager.prototype), {
    log: {warn: vi.fn()},
    getDialogOnly: vi.fn((peerId: PeerId) => cache.get(peerId)),
    fillConversations: vi.fn(async() => {}),
    appUsersManager: {hasUser: vi.fn(() => false)},
    reloadConversation: vi.fn()
  });
  return {manager, cache};
}

const peer = (123).toPeerId();
const other = (456).toPeerId();
const dialog = (peerId: PeerId) => ({_: 'dialog', peerId}) as Dialog;

describe('CRM open-ticket dialog hydration', () => {
  it('discovers uncached Telegram users before trying to render their chats', async() => {
    const {manager, cache} = harness();
    const found = dialog(peer);
    manager.fillConversations.mockImplementation(async() => { cache.set(peer, found); });
    expect(await manager.getConversationsByPeerIds([peer])).toEqual([found]);
    expect(manager.fillConversations).toHaveBeenCalledWith(GLOBAL_FOLDER_ID);
    expect(manager.reloadConversation).not.toHaveBeenCalled();
  });

  it('keeps the cached path free of network requests and deduplicates peers', async() => {
    const {manager, cache} = harness();
    cache.set(peer, dialog(peer));
    expect(await manager.getConversationsByPeerIds([peer, peer])).toEqual([dialog(peer)]);
    expect(manager.fillConversations).not.toHaveBeenCalled();
  });

  it('keeps valid chats when another peer is unreachable or unknown', async() => {
    const {manager, cache} = harness();
    cache.set(peer, dialog(peer));
    manager.appUsersManager.hasUser.mockReturnValue(true);
    manager.reloadConversation.mockRejectedValue(new Error('PEER_ID_INVALID'));
    expect(await manager.getConversationsByPeerIds([peer, other])).toEqual([dialog(peer)]);
    manager.appUsersManager.hasUser.mockReturnValue(false);
    manager.reloadConversation.mockClear();
    expect(await manager.getConversationsByPeerIds([peer, other])).toEqual([dialog(peer)]);
    expect(manager.reloadConversation).not.toHaveBeenCalled();
  });

  it('preserves cached chats when Telegram dialog discovery fails', async() => {
    const {manager, cache} = harness();
    cache.set(peer, dialog(peer));
    manager.fillConversations.mockRejectedValue(new Error('NETWORK_ERROR'));
    expect(await manager.getConversationsByPeerIds([peer, other])).toEqual([dialog(peer)]);
    expect(manager.log.warn).toHaveBeenCalled();
  });

  it('retries a known peer after completing dialog discovery', async() => {
    const {manager} = harness();
    manager.appUsersManager.hasUser.mockReturnValue(true);
    manager.reloadConversation.mockResolvedValue(dialog(peer));
    expect(await manager.getConversationsByPeerIds([peer])).toEqual([dialog(peer)]);
  });

  it('stops at the end of Telegram dialogs when a CRM peer is absent', async() => {
    const {manager} = harness();
    manager.fillConversationsPromises = {};
    manager.fillConversations = AppMessagesManager.prototype.fillConversations;
    manager.middleware = {get: () => () => true};
    manager.dialogsStorage = {getOffsetDate: () => 0, isDialogsLoaded: () => false};
    manager.getTopMessages = vi.fn(async() => ({isEnd: true}));
    expect(await manager.getConversationsByPeerIds([peer])).toEqual([]);
    expect(manager.getTopMessages).toHaveBeenCalledTimes(1);
  });
});
