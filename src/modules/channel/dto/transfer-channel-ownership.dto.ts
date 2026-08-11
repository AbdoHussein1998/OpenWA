import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class TransferChannelOwnershipDto {
  @ApiProperty({
    description:
      'WhatsApp ID of the account that becomes the new owner. This is irreversible: once the ' +
      'transfer lands, this session can no longer take the channel back.',
    example: '628123456789@c.us',
  })
  @IsString()
  @IsNotEmpty()
  newOwnerId!: string;
}
