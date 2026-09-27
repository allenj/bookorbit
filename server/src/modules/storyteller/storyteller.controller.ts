import { Controller, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Permission } from '@bookorbit/types';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { StorytellerJobService } from './storyteller-job.service';

/**
 * A finished read-along is attached with the same permission as adding a file by hand, because
 * that is what it amounts to.
 */
@Controller('books/:bookId/storyteller')
export class StorytellerController {
  constructor(private readonly jobs: StorytellerJobService) {}

  @Get()
  getState(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser) {
    return this.jobs.getState(bookId, user);
  }

  @Post('jobs')
  @RequirePermission(Permission.LibraryUpload)
  start(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser) {
    return this.jobs.start(bookId, user);
  }

  @Post('jobs/retry')
  @HttpCode(200)
  @RequirePermission(Permission.LibraryUpload)
  retry(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser) {
    return this.jobs.retry(bookId, user);
  }

  @Post('jobs/cancel')
  @HttpCode(200)
  @RequirePermission(Permission.LibraryUpload)
  cancel(@Param('bookId', ParseIntPipe) bookId: number, @CurrentUser() user: RequestUser) {
    return this.jobs.cancel(bookId, user);
  }
}
