import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class MarkChatReadDto {
  @ApiProperty({
    description: "Chat ID in the active engine's native format (e.g. 1234567890@c.us on whatsapp-web.js)",
    example: '1234567890@c.us',
  })
  @IsString()
  @IsNotEmpty()
  // Engine-neutral structural check (localpart@host, no whitespace) so a different engine's JID
  // scheme (e.g. Baileys 1234@s.whatsapp.net) is accepted too; the adapter validates/normalises
  // further for its own engine. Keeps the early-400 on obvious garbage without coupling to wwebjs.
  @Matches(/^[^\s@]+@[^\s@]+$/, {
    message: 'chatId must be a valid chat JID in the form localpart@host',
  })
  chatId!: string;

  @ApiPropertyOptional({
    description:
      'Specific message IDs to mark read. Baileys acknowledges individual messages, so without this ' +
      'only the newest message the engine still holds in memory gets a receipt — a burst leaves its ' +
      'earlier messages unread forever, and a restarted session has no message to acknowledge at all. ' +
      'Callers that persist inbound message IDs should send them here. Ignored by whatsapp-web.js, ' +
      'whose own sendSeen is chat-level.',
    type: [String],
    example: ['3EB0C767D26B8A3F1A2B', '3EB0C767D26B8A3F1A2C'],
  })
  @IsOptional()
  @IsArray()
  // Bounded so one request cannot hand the engine an unbounded key list to round-trip; a caller with
  // more than this to acknowledge is catching up on history, not marking a conversation read.
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  messageIds?: string[];
}
