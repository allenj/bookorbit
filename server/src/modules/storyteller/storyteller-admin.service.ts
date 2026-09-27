import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { StorytellerServer, StorytellerTestResult } from '@bookorbit/types';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { StorytellerServerRow } from '../../db/schema';
import type { SaveStorytellerServerDto } from './dto/save-storyteller-server.dto';
import { StorytellerClient } from './storyteller.client';
import { StorytellerClientFactory } from './storyteller-client.factory';
import { StorytellerCredentialService } from './storyteller-credential.service';
import { StorytellerRepository } from './storyteller.repository';

export function toStorytellerServer(row: StorytellerServerRow): StorytellerServer {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    username: row.username,
    hasPassword: row.passwordEnc !== null,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class StorytellerAdminService {
  private readonly logger = new Logger(StorytellerAdminService.name);

  constructor(
    private readonly repo: StorytellerRepository,
    private readonly credentials: StorytellerCredentialService,
    private readonly clients: StorytellerClientFactory,
  ) {}

  async getServer(): Promise<StorytellerServer | null> {
    const row = await this.repo.findServer();
    return row ? toStorytellerServer(row) : null;
  }

  /** There is one server; saving creates it the first time and edits it after. */
  async saveServer(dto: SaveStorytellerServerDto): Promise<StorytellerServer> {
    const existing = await this.repo.findServer();
    const passwordEnc = dto.password !== undefined ? this.credentials.encrypt(dto.password) : (existing?.passwordEnc ?? null);
    if (!passwordEnc) throw new BadRequestException('A password is required to connect to Storyteller');

    const values = { name: dto.name, baseUrl: dto.baseUrl.replace(/\/+$/, ''), username: dto.username, passwordEnc, enabled: dto.enabled };
    const row = existing ? await this.repo.updateServer(existing.id, values) : await this.repo.insertServer(values);
    if (!row) throw new NotFoundException('Storyteller server not found');
    this.clients.invalidate();
    return toStorytellerServer(row);
  }

  async deleteServer(): Promise<void> {
    const existing = await this.repo.findServer();
    if (!existing) throw new NotFoundException('No Storyteller server is configured');
    await this.repo.deleteServer(existing.id);
    this.clients.invalidate();
  }

  /** A fresh client every time, so a test proves the saved credentials rather than a cached token. */
  async testServer(): Promise<StorytellerTestResult> {
    const event = 'storyteller.admin.test_server';
    const startedAt = Date.now();
    const server = await this.repo.findServer();
    if (!server) throw new NotFoundException('No Storyteller server is configured');
    this.logger.log(`[${event}] [start] serverId=${server.id} - testing Storyteller connection`);

    try {
      if (!server.passwordEnc) throw new BadRequestException('No Storyteller password is saved');
      const client = new StorytellerClient({
        baseUrl: server.baseUrl,
        username: server.username,
        password: this.credentials.decrypt(server.passwordEnc),
      });
      await client.checkHealth();
      await client.login();
      await client.getMaxUploadChunkSize();
      this.logger.log(
        `[${event}] [end] serverId=${server.id} durationMs=${Date.now() - startedAt} connected=true - Storyteller connection test completed`,
      );
      return { connected: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[${event}] [fail] serverId=${server.id} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(message)}" - Storyteller connection test failed`,
      );
      return { connected: false, error: message };
    }
  }
}
