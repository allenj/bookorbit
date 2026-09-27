import { BadRequestException, Logger } from '@nestjs/common';

import type { StorytellerServerRow } from '../../db/schema';
import { StorytellerAdminService } from './storyteller-admin.service';
import { StorytellerCredentialService } from './storyteller-credential.service';

function serverRow(overrides: Partial<StorytellerServerRow> = {}): StorytellerServerRow {
  return {
    id: 1,
    name: 'Storyteller',
    baseUrl: 'http://story.local:8001',
    username: 'jeff',
    passwordEnc: 'v1:stored',
    enabled: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('StorytellerAdminService', () => {
  const credentials = new StorytellerCredentialService({ encryptionKey: 'a-key-that-is-long-enough' });
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let clients: { invalidate: ReturnType<typeof vi.fn> };
  let service: StorytellerAdminService;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    repo = {
      findServer: vi.fn(() => Promise.resolve(null)),
      insertServer: vi.fn((values: Partial<StorytellerServerRow>) => Promise.resolve(serverRow(values))),
      updateServer: vi.fn((_id: number, values: Partial<StorytellerServerRow>) => Promise.resolve(serverRow(values))),
    };
    clients = { invalidate: vi.fn() };
    service = new StorytellerAdminService(repo as never, credentials, clients as never);
  });

  const dto = { name: 'Storyteller', baseUrl: 'http://story.local:8001/', username: 'jeff', enabled: true };

  it('encrypts the password and never returns it', async () => {
    const saved = await service.saveServer({ ...dto, password: 'hunter2' });

    const stored = repo.insertServer!.mock.calls[0]![0] as StorytellerServerRow;
    expect(stored.passwordEnc).not.toContain('hunter2');
    expect(credentials.decrypt(stored.passwordEnc!)).toBe('hunter2');
    expect(saved).toMatchObject({ hasPassword: true, baseUrl: 'http://story.local:8001' });
    expect(JSON.stringify(saved)).not.toContain(stored.passwordEnc);
  });

  it('keeps the stored password when an edit leaves it out', async () => {
    repo.findServer!.mockResolvedValue(serverRow());

    await service.saveServer({ ...dto, username: 'someone-else' });

    expect(repo.updateServer).toHaveBeenCalledWith(1, expect.objectContaining({ username: 'someone-else', passwordEnc: 'v1:stored' }));
    expect(clients.invalidate).toHaveBeenCalled();
  });

  it('needs a password the first time', async () => {
    await expect(service.saveServer(dto)).rejects.toThrow(BadRequestException);
    expect(repo.insertServer).not.toHaveBeenCalled();
  });
});
