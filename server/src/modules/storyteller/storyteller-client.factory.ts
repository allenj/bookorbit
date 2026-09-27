import { Injectable } from '@nestjs/common';

import type { StorytellerServerRow } from '../../db/schema';
import { StorytellerApiError, StorytellerClient } from './storyteller.client';
import { StorytellerCredentialService } from './storyteller-credential.service';

/**
 * Keeps one client per saved server version. Each Storyteller sign-in creates a session row on the
 * Storyteller side, so the token has to outlive a single poll.
 */
@Injectable()
export class StorytellerClientFactory {
  private cached: { key: string; client: StorytellerClient } | null = null;

  constructor(private readonly credentials: StorytellerCredentialService) {}

  forServer(server: StorytellerServerRow): StorytellerClient {
    const key = `${server.id}:${server.updatedAt.getTime()}`;
    if (this.cached?.key === key) return this.cached.client;
    if (!server.passwordEnc) throw new StorytellerApiError('No Storyteller password is saved', null, false);
    const client = new StorytellerClient({
      baseUrl: server.baseUrl,
      username: server.username,
      password: this.credentials.decrypt(server.passwordEnc),
    });
    this.cached = { key, client };
    return client;
  }

  invalidate(): void {
    this.cached = null;
  }
}
