import { BadRequestException } from '@nestjs/common';

import { StorytellerCredentialService } from './storyteller-credential.service';

describe('StorytellerCredentialService', () => {
  const service = new StorytellerCredentialService({ encryptionKey: 'a-key-that-is-long-enough' });

  it('round-trips a password without storing it in the clear', () => {
    const encrypted = service.encrypt('hunter2');
    expect(encrypted).not.toContain('hunter2');
    expect(service.decrypt(encrypted)).toBe('hunter2');
  });

  it('asks for the password again when the key has changed', () => {
    const encrypted = service.encrypt('hunter2');
    const rotated = new StorytellerCredentialService({ encryptionKey: 'a-different-key-entirely' });
    expect(() => rotated.decrypt(encrypted)).toThrow(BadRequestException);
  });
});
