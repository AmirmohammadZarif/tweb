import rootScope from '@lib/rootScope';

// Manual-read ("peek") mode — per-browser, like the agent identity.
//
// Reading is entirely client-driven: opening a chat is what makes tweb call
// readHistory, which both tells the CUSTOMER their message was read (the second
// tick) and clears the unread state for every other agent on the shared
// department account. That makes "I glanced at this chat" indistinguishable from
// "I took this chat".
//
// With this mode on, opening a chat sends no read at all: the customer sees
// nothing, the chat stays bold for the team, and the agent claims it explicitly
// (topbar "Mark as read", /read, or simply by replying). Only then does tweb read
// the history and record the first viewer — see ChatBubbles.markChatRead.
//
// Deliberately per-browser and not synced: it is a working style, and the agent
// who turns it on is the one who has to remember to claim chats.

const KEY = 'agent_manual_read';

class AgentReadMode {
  private enabled: boolean;

  constructor() {
    this.enabled = this.read();
  }

  private read() {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch{
      return false;
    }
  }

  public isEnabled() {
    return this.enabled;
  }

  public setEnabled(enabled: boolean) {
    this.enabled = !!enabled;
    try {
      if(this.enabled) localStorage.setItem(KEY, '1');
      else localStorage.removeItem(KEY);
    } catch{}
    rootScope.dispatchEvent('agent_read_mode_update');
  }
}

const agentReadMode = new AgentReadMode();
export default agentReadMode;
