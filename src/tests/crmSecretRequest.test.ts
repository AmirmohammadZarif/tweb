import AppCrmManager from '@appManagers/appCrmManager';

function manager(respond: (method: string, path: string, options: any) => any) {
  const calls: {method: string, path: string, options: any}[] = [];
  const crm = Object.assign(Object.create(AppCrmManager.prototype), {
    log: Object.assign(() => {}, {error: () => {}}),
    isConnected: async() => true,
    sessionTelegramUserId: () => '111',
    request: async(method: string, path: string, options: any) => {
      calls.push({method, path, options});
      return respond(method, path, options);
    }
  });
  return {crm, calls};
}

describe('CRM secure-info requests', () => {
  it('issues a link for the chat with the session and the agent wording', async() => {
    const link = {id: 3, title: 'Gmail password', url: 'https://crm/vault/x', expires_at: '2026-11-13T10:00:00Z', message: 'msg'};
    const {crm, calls} = manager(() => ({data: link}));

    await expect(crm.issueSecretRequest('555', 'Gmail password', 'only the password')).resolves.toEqual(link);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe('/tickets/by-telegram/555/secret-requests');
    expect(calls[0].options.body).toEqual({session_telegram_user_id: '111', title: 'Gmail password', note: 'only the password'});
  });

  it('leaves an empty note out of the body', async() => {
    const {crm, calls} = manager(() => ({data: {}}));
    await crm.issueSecretRequest('555', 'Code');
    expect(calls[0].options.body).toEqual({session_telegram_user_id: '111', title: 'Code'});
  });

  it('lists requests and fails soft', async() => {
    const {crm} = manager(() => ({data: [{id: 1, title: 'x', status: 'pending', expires_at: '', submitted_at: null, vault_url: null}]}));
    await expect(crm.getSecretRequests('555')).resolves.toHaveLength(1);

    const failing = manager(() => {
      throw new Error('down');
    });
    await expect(failing.crm.getSecretRequests('555')).resolves.toBeUndefined();
    await expect(failing.crm.revokeSecretRequest('555', 1)).resolves.toBe(false);
  });

  it('revokes through the per-request endpoint', async() => {
    const {crm, calls} = manager(() => ({data: {}}));
    await expect(crm.revokeSecretRequest('555', 9)).resolves.toBe(true);
    expect(calls[0].path).toBe('/tickets/by-telegram/555/secret-requests/9/revoke');
  });
});
