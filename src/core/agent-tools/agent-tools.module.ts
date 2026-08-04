import { Global, Module } from '@nestjs/common';
import { ToolRegistryService } from './tool-registry.service';
import { SessionModule } from '../../modules/session/session.module';
import { MessageModule } from '../../modules/message/message.module';
import { ContactModule } from '../../modules/contact/contact.module';
import { GroupModule } from '../../modules/group/group.module';
import { WebhookModule } from '../../modules/webhook/webhook.module';
import { LabelModule } from '../../modules/label/label.module';
import { SessionService } from '../../modules/session/session.service';
import { MessageService } from '../../modules/message/message.service';
import { ContactService } from '../../modules/contact/contact.service';
import { GroupService } from '../../modules/group/group.service';
import { WebhookService } from '../../modules/webhook/webhook.service';
import { LabelService } from '../../modules/label/label.service';
import { allAgentTools } from './tools';

@Global()
@Module({
  imports: [SessionModule, MessageModule, ContactModule, GroupModule, WebhookModule, LabelModule],
  providers: [
    {
      provide: ToolRegistryService,
      inject: [SessionService, MessageService, ContactService, GroupService, WebhookService, LabelService],
      useFactory: (
        session: SessionService,
        message: MessageService,
        contact: ContactService,
        group: GroupService,
        webhook: WebhookService,
        labels: LabelService,
      ) => new ToolRegistryService(allAgentTools({ session, message, contact, group, webhook, labels })),
    },
  ],
  exports: [ToolRegistryService],
})
export class AgentToolsModule {}
