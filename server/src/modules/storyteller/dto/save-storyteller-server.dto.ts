import { IsBoolean, IsNotEmpty, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class SaveStorytellerServerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(500)
  baseUrl!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  username!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  password?: string;

  @IsBoolean()
  enabled!: boolean;
}
