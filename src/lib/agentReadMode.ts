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
// ON BY DEFAULT. The failure modes are not symmetric: a read receipt sent by
// accident cannot be taken back — the customer has already seen "seen", and the
// whole team has lost the chat's unread state — whereas a chat left unread for a
// few extra seconds costs nothing. So a fresh browser holds reads until the agent
// claims the chat, and turning that off is a deliberate per-agent choice.
//
// Per-browser and not synced: it is a working style. (An agent who needs it
// enforced rather than chosen has the CRM's read-only role, which pins it on.)

const KEY = 'agent_manual_read';

class AgentReadMode {
  private enabled: boolean;

  constructor() {
    this.enabled = this.read();
  }

  /**
   * '1' = on, '0' = explicitly off, absent = on (the default).
   *
   * Note this re-enables the mode for anyone who had previously turned it off,
   * since "off" used to be stored by REMOVING the key and is indistinguishable
   * from never having chosen. That is the safe direction to err in, and the
   * toggle is one click away. Storage failures also fall back to on.
   */
  private read() {
    try {
      return localStorage.getItem(KEY) !== '0';
    } catch{
      return true;
    }
  }

  public isEnabled() {
    return this.enabled;
  }

  public setEnabled(enabled: boolean) {
    this.enabled = !!enabled;
    try {
      // Both states are stored explicitly now — with the default flipped to on,
      // an absent key means "on", so turning it off has to be recorded.
      localStorage.setItem(KEY, this.enabled ? '1' : '0');
    } catch{}
    rootScope.dispatchEvent('agent_read_mode_update');
  }
}

const agentReadMode = new AgentReadMode();
export default agentReadMode;
