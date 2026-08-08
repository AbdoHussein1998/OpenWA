import { Body, Controller, Get, Post, Put, Delete, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { ContactService } from './contact.service';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { UpsertContactDto } from './dto/upsert-contact.dto';
import {
  ContactAckResponseDto,
  ContactDto,
  NumberCheckResponseDto,
  ProfilePictureResponseDto,
  ProfilePicturesResponseDto,
  ResolvedPhoneResponseDto,
} from './dto/contact-response.dto';

@ApiTags('contacts')
@Controller('sessions/:sessionId/contacts')
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  @Get()
  @ApiOperation({ summary: 'Get all contacts for a session' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'List of contacts, windowed by limit/offset. A bare array — there is no envelope.',
    type: [ContactDto],
  })
  @ApiResponse({ status: 400, description: 'Session not ready' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max contacts to return (1–1000, default 1000)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Number of contacts to skip (for paging)' })
  async findAll(
    @Param('sessionId') sessionId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.contactService.getContacts(sessionId, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Get('profile-pictures')
  @ApiOperation({
    summary: 'Batch-resolve profile picture URLs for up to 50 contacts',
    description:
      'One request for a whole chat sidebar — avoids the burst of parallel single fetches that ' +
      'would exhaust the per-IP throttle. Engine lookups run 5 at a time; per-id failures return null.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiQuery({ name: 'ids', required: true, description: 'Comma-separated contact ids (max 50 used)' })
  @ApiResponse({ status: 200, description: 'Picture URL per requested id', type: ProfilePicturesResponseDto })
  // NOTE: declared BEFORE @Get(':contactId') so the literal segment wins over the param route.
  async getProfilePictures(@Param('sessionId') sessionId: string, @Query('ids') ids?: string) {
    const list = (ids ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const pictures = await this.contactService.getProfilePictures(sessionId, list);
    return { pictures };
  }

  @Get(':contactId')
  @ApiOperation({ summary: 'Get a specific contact by ID' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'contactId', description: 'Contact ID (e.g., 628xxx@c.us)' })
  @ApiResponse({
    status: 200,
    description: 'Contact details',
    type: ContactDto,
  })
  @ApiResponse({ status: 404, description: 'Contact not found' })
  async findOne(@Param('sessionId') sessionId: string, @Param('contactId') contactId: string) {
    return this.contactService.getContactById(sessionId, contactId);
  }

  @Get('check/:number')
  @ApiOperation({
    summary: 'Check if a phone number exists on WhatsApp',
    description:
      'Returns whether the number is a registered WhatsApp account and its canonical id. Use this to ' +
      'pre-validate a recipient before sending: the send endpoints return 201 on accepting a message ' +
      'even for numbers that are not on WhatsApp, so this is the only way to confirm a new number is ' +
      'reachable before you send to it.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'number', description: 'Phone number to check (e.g., 628123456789)' })
  @ApiResponse({
    status: 200,
    description: 'Number existence check result',
    type: NumberCheckResponseDto,
  })
  @ApiResponse({
    status: 503,
    description:
      'WhatsApp did not answer the lookup. Deliberately not reported as `exists: false` — that ' +
      'would be a claim about the number rather than about the query, and this route exists to be ' +
      'trusted before a send.',
  })
  async checkNumber(@Param('sessionId') sessionId: string, @Param('number') number: string) {
    // The engine returns the canonical chat id in its native format; we don't build the JID here
    // (decoupled from the whatsapp-web.js `@c.us` scheme).
    const whatsappId = await this.contactService.getNumberId(sessionId, number);
    return {
      number,
      exists: whatsappId !== null,
      whatsappId,
    };
  }

  // ========== Gap Quick Wins: Profile Picture, Block/Unblock ==========

  @Get(':contactId/profile-picture')
  @ApiOperation({ summary: 'Get profile picture URL for a contact' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'contactId', description: 'Contact ID (e.g., 628xxx@c.us)' })
  @ApiResponse({
    status: 200,
    description: 'Profile picture URL',
    type: ProfilePictureResponseDto,
  })
  @ApiResponse({
    status: 503,
    description:
      'WhatsApp did not answer the lookup. Deliberately not reported as `url: null` — that is the ' +
      'same answer a contact with no picture gives, and a caller cannot tell them apart.',
  })
  async getProfilePicture(@Param('sessionId') sessionId: string, @Param('contactId') contactId: string) {
    const url = await this.contactService.getProfilePicture(sessionId, contactId);
    return { url };
  }

  @Get(':contactId/phone')
  @ApiOperation({ summary: 'Resolve a contact id (e.g. an @lid) to a phone number — best-effort' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'contactId', description: 'Contact ID / JID to resolve (e.g., an @lid)' })
  @ApiResponse({
    status: 200,
    description: 'Resolved phone number (MSISDN digits), or null when the engine cannot map it',
    type: ResolvedPhoneResponseDto,
  })
  async resolvePhone(@Param('sessionId') sessionId: string, @Param('contactId') contactId: string) {
    const phone = await this.contactService.resolveContactPhone(sessionId, contactId);
    return { contactId, phone };
  }

  @Put(':contactId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Save a contact to the account's addressbook, or edit an existing entry" })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'contactId', description: 'Contact ID (e.g., 628xxx@c.us)' })
  @ApiResponse({ status: 200, description: 'Contact saved', type: ContactAckResponseDto })
  @ApiResponse({ status: 400, description: 'Session not active or invalid request' })
  @ApiResponse({
    status: 503,
    description:
      'WhatsApp did not answer within the request budget. The change may or may not have been applied — ' +
      'the gateway stopped waiting for a confirmation that never came.',
  })
  async upsertContact(
    @Param('sessionId') sessionId: string,
    @Param('contactId') contactId: string,
    @Body() dto: UpsertContactDto,
  ) {
    await this.contactService.upsertContact(sessionId, contactId, dto.firstName, dto.lastName);
    return { success: true, message: 'Contact saved' };
  }

  // Two path segments on the sibling route (`:contactId/block`) keep this single-segment DELETE
  // from shadowing the unblock route, whichever order they are declared in.
  @Delete(':contactId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: "Remove a contact from the account's addressbook" })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'contactId', description: 'Contact ID (e.g., 628xxx@c.us)' })
  @ApiResponse({ status: 200, description: 'Contact deleted', type: ContactAckResponseDto })
  @ApiResponse({ status: 400, description: 'Session not active' })
  @ApiResponse({
    status: 503,
    description:
      'WhatsApp did not answer within the request budget. The change may or may not have been applied — ' +
      'the gateway stopped waiting for a confirmation that never came.',
  })
  async deleteContact(@Param('sessionId') sessionId: string, @Param('contactId') contactId: string) {
    await this.contactService.deleteContact(sessionId, contactId);
    return { success: true, message: 'Contact deleted' };
  }

  @Post(':contactId/block')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Block a contact' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'contactId', description: 'Contact ID (e.g., 628xxx@c.us)' })
  @ApiResponse({
    status: 200,
    description: 'Contact blocked',
    type: ContactAckResponseDto,
  })
  @ApiResponse({
    status: 503,
    description:
      'WhatsApp did not answer within the request budget. The change may or may not have been applied — ' +
      'the gateway stopped waiting for a confirmation that never came.',
  })
  async blockContact(@Param('sessionId') sessionId: string, @Param('contactId') contactId: string) {
    await this.contactService.blockContact(sessionId, contactId);
    return { success: true, message: 'Contact blocked' };
  }

  @Delete(':contactId/block')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Unblock a contact' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'contactId', description: 'Contact ID (e.g., 628xxx@c.us)' })
  @ApiResponse({
    status: 200,
    description: 'Contact unblocked',
    type: ContactAckResponseDto,
  })
  @ApiResponse({
    status: 503,
    description:
      'WhatsApp did not answer within the request budget. The change may or may not have been applied — ' +
      'the gateway stopped waiting for a confirmation that never came.',
  })
  async unblockContact(@Param('sessionId') sessionId: string, @Param('contactId') contactId: string) {
    await this.contactService.unblockContact(sessionId, contactId);
    return { success: true, message: 'Contact unblocked' };
  }
}
