import AppCrmManager from '@appManagers/appCrmManager';

function manager(access: 'admin' | 'read_only' | null, sessionId = '111') {
  return Object.assign(Object.create(AppCrmManager.prototype), {
    accessCheckedAt: Date.now(),
    sessionTelegramUserId: () => '111',
    config: {enabled: true, baseUrl: 'https://crm.example', token: 'agent', user: {
      id: 1, department_access: access, session_telegram_user_id: sessionId
    }}
  });
}

describe('department-scoped CRM access', () => {
  it('allows writing only in the active admin department', () => {
    const crm = manager('admin');
    expect(crm.isLoggedInCached()).toBe(true);
    expect(crm.isReadOnlyCached()).toBe(false);
    crm.config.user.department_access = 'read_only';
    expect(crm.isLoggedInCached()).toBe(true);
    expect(crm.isReadOnlyCached()).toBe(true);
  });

  it('blocks reads and writes without membership or with another accounts cached grant', () => {
    for(const crm of [manager(null), manager('admin', '222')]) {
      expect(crm.isLoggedInCached()).toBe(false);
      expect(crm.isReadOnlyCached()).toBe(true);
    }
  });

  it('does not trust persisted or expired access after startup or a failed refresh', () => {
    const crm = manager('admin');
    for(const checkedAt of [0, Date.now() - 61000]) {
      crm.accessCheckedAt = checkedAt;
      expect(crm.isLoggedInCached()).toBe(false);
      expect(crm.isReadOnlyCached()).toBe(true);
    }
  });

  it('publishes fail-closed access to the UI store', async() => {
    const crm = manager('admin', '222');
    const config = await crm.getConfig();
    expect(config.user.department_access).toBeNull();
    expect(config.user.is_read_only).toBe(true);
  });
});
