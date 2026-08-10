import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class DemoteChannelAdminDto {
  @ApiProperty({
    description: 'WhatsApp ID of the admin to demote back to a subscriber.',
    example: '628123456789@c.us',
  })
  @IsString()
  @IsNotEmpty()
  userId!: string;
}
