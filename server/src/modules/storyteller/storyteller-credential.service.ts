import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

import { storytellerConfig } from '../../config/config';

const ALGORITHM = 'aes-256-gcm';

@Injectable()
export class StorytellerCredentialService {
  private readonly key: Buffer;

  constructor(@Inject(storytellerConfig.KEY) config: ConfigType<typeof storytellerConfig>) {
    this.key = createHash('sha256').update(config.encryptionKey, 'utf8').digest();
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
  }

  /** A changed key leaves a password nobody can read; that surfaces as "re-enter it", not a crash. */
  decrypt(value: string): string {
    try {
      const [version, iv, tag, ciphertext] = value.split(':');
      if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('unrecognised format');
      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      throw new BadRequestException('The stored Storyteller password could not be read. Re-enter it in Settings.');
    }
  }
}
