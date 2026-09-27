import { Body, Controller, Delete, Get, HttpCode, Post, Put } from '@nestjs/common';
import { Permission } from '@bookorbit/types';

import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { SaveStorytellerServerDto } from './dto/save-storyteller-server.dto';
import { StorytellerAdminService } from './storyteller-admin.service';

@Controller('storyteller/admin')
@RequirePermission(Permission.ManageAppSettings)
export class StorytellerAdminController {
  constructor(private readonly adminService: StorytellerAdminService) {}

  @Get('server')
  async getServer() {
    return { server: await this.adminService.getServer() };
  }

  @Put('server')
  saveServer(@Body() dto: SaveStorytellerServerDto) {
    return this.adminService.saveServer(dto);
  }

  @Delete('server')
  @HttpCode(204)
  async deleteServer() {
    await this.adminService.deleteServer();
  }

  @Post('server/test')
  @HttpCode(200)
  testServer() {
    return this.adminService.testServer();
  }
}
