import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

/**
 * Owns engine access for label operations so the "session not started" guard and label
 * business rules (not-found mapping) live behind the service boundary, not in the controller.
 */
@Injectable()
export class LabelService {
  constructor(private readonly engines: EngineRegistry) {}

  private getEngine(sessionId: string): IWhatsAppEngine {
    // EngineRegistry.require()'s default is this exact 400 "Session is not started".
    return this.engines.require(sessionId);
  }

  getLabels(sessionId: string) {
    return this.getEngine(sessionId).getLabels();
  }

  async getLabelById(sessionId: string, labelId: string) {
    const label = await this.getEngine(sessionId).getLabelById(labelId);
    if (!label) {
      throw new NotFoundException(`Label ${labelId} not found`);
    }
    return label;
  }

  getChatLabels(sessionId: string, chatId: string) {
    return this.getEngine(sessionId).getChatLabels(chatId);
  }

  /**
   * Create or update a label. One operation on purpose: WhatsApp carries a single `label_edit`
   * write keyed by the label id, so whether this creates or updates depends only on whether that id
   * already exists — which is also why the caller chooses the id rather than being handed one.
   */
  upsertLabel(sessionId: string, labelId: string, body: { name?: string; color?: number }) {
    // Both fields are individually optional (either alone is a valid partial update), but an empty
    // body has nothing to write — on an unused id it would even create a nameless label — so it is
    // refused like the group-settings PUT refuses an empty patch.
    if (body.name === undefined && body.color === undefined) {
      throw new BadRequestException('At least one of name or color must be provided');
    }
    return this.getEngine(sessionId).upsertLabel({ id: labelId, ...body });
  }

  deleteLabel(sessionId: string, labelId: string) {
    return this.getEngine(sessionId).deleteLabel(labelId);
  }

  getChatsByLabel(sessionId: string, labelId: string) {
    return this.getEngine(sessionId).getChatsByLabel(labelId);
  }

  addLabelToChat(sessionId: string, chatId: string, labelId: string) {
    return this.getEngine(sessionId).addLabelToChat(chatId, labelId);
  }

  removeLabelFromChat(sessionId: string, chatId: string, labelId: string) {
    return this.getEngine(sessionId).removeLabelFromChat(chatId, labelId);
  }
}
