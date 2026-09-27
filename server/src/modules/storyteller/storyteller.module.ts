import { Module } from '@nestjs/common';

import { LibraryModule } from '../library/library.module';
import { UploadModule } from '../upload/upload.module';
import { StorytellerAdminController } from './storyteller-admin.controller';
import { StorytellerAdminService } from './storyteller-admin.service';
import { StorytellerClientFactory } from './storyteller-client.factory';
import { StorytellerController } from './storyteller.controller';
import { StorytellerCredentialService } from './storyteller-credential.service';
import { StorytellerJobRunnerService } from './storyteller-job-runner.service';
import { StorytellerJobService } from './storyteller-job.service';
import { StorytellerRepository } from './storyteller.repository';

@Module({
  imports: [LibraryModule, UploadModule],
  controllers: [StorytellerController, StorytellerAdminController],
  providers: [
    StorytellerRepository,
    StorytellerCredentialService,
    StorytellerClientFactory,
    StorytellerAdminService,
    StorytellerJobService,
    StorytellerJobRunnerService,
  ],
})
export class StorytellerModule {}
