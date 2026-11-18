

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  FileText,
  Loader2,
  Paperclip,
  Send,
  Smile,
  X,
} from 'lucide-react';

import {
  isAgentTemplateQuotaError,
  messageApi,
  templateApi,
  type AgentTemplateQuotaError,
  type Chat,
  type MessageTemplate,
  type MessageType,
} from '../../services/api';
import {
  mergeOrAppend,
  type ChatMessageView,
} from '../../utils/chatMessages';
import { promoteChatWithSnippet } from '../../utils/chatList';
import {
  buildMediaSendPayload,
  buildOptimisticMetadata,
  quotedIdOf,
} from '../../utils/composerSend';
import {
  messagesQueryKey,
  useChatMessagesActions,
} from '../../hooks/useChatMessages';
import { useRole } from '../../hooks/useRole';
import { useToast } from '../../hooks/useToast';
import type { ScrollDirection } from '../../utils/scrollDecision';

// Map an attachment MIME type to the neutral MessageType for the optimistic outgoing bubble, so the
// placeholder matches what the backend will persist (e.g. a PDF is `document`, not `application`).
const messageTypeFromMime = (mimetype: string): MessageType => {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'document';
};

// Client pre-check before base64-encoding an upload, same cap as the message tester: base64
// inflates ~1.33x, so ~18 MiB raw stays under the backend's default 25 MiB body limit and the
// pick fails here with a toast instead of OOMing the tab on the FileReader.
const MEDIA_UPLOAD_MAX_BYTES = 18 * 1024 * 1024;

// Keep this in sync with the backend template renderer. The double-brace branch is tried first so
// `{{name}}` is consumed as one token, while the single-brace branch preserves the gateway's legacy
// `{name}` compatibility.
const TEMPLATE_PLACEHOLDER_PATTERN =
  /\{\{\s*([\w.-]+)\s*\}\}|\{(\w+)\}/g;

/** A picked-but-unsent file, staged until send, removal, or a move to another chat. */
export interface StagedAttachment {
  file: File;
  base64: string;
  mimetype: string;
  filename: string;
}

interface ChatComposerProps {
  selectedSessionId: string;
  activeChat: Chat;
  replyingTo: ChatMessageView | null;
  setReplyingTo: Dispatch<SetStateAction<ChatMessageView | null>>;
  onMessageAppended: (direction: ScrollDirection) => void;
  setChats: Dispatch<SetStateAction<Chat[]>>;
  messageInput: string;
  setMessageInput: Dispatch<SetStateAction<string>>;
  attachment: StagedAttachment | null;
  setAttachment: Dispatch<SetStateAction<StagedAttachment | null>>;
  previewUrl: string | null;
  setPreviewUrl: Dispatch<SetStateAction<string | null>>;
}

function extractTemplatePlaceholders(
  template: MessageTemplate,
): string[] {
  const source = [
    template.header,
    template.body,
    template.footer,
  ]
    .filter(
      (segment): segment is string =>
        segment != null &&
        segment.length > 0,
    )
    .join('\n\n');

  const keys = new Set<string>();

  for (const match of source.matchAll(TEMPLATE_PLACEHOLDER_PATTERN)) {
    const key =
      match[1] ??
      match[2];

    if (key) {
      keys.add(key);
    }
  }

  return Array.from(keys).sort();
}

function renderTemplateSegment(
  segment: string,
  vars: Record<string, string>,
): string {
  return segment.replace(
    TEMPLATE_PLACEHOLDER_PATTERN,
    (
      match,
      doubleKey: string | undefined,
      singleKey: string | undefined,
    ) => {
      const key =
        doubleKey ??
        singleKey;

      if (
        key !== undefined &&
        Object.prototype.hasOwnProperty.call(
          vars,
          key,
        )
      ) {
        return vars[key] ?? match;
      }

      return match;
    },
  );
}

/**
 * Client-side preview of the server's stored-template renderer.
 *
 * This is only for optimistic UI. The backend remains authoritative and renders the stored
 * template again from its database copy before sending.
 */
function renderStoredTemplate(
  template: MessageTemplate,
  vars: Record<string, string>,
): string {
  return [
    template.header,
    template.body,
    template.footer,
  ]
    .filter(
      (segment): segment is string =>
        segment != null &&
        segment.length > 0,
    )
    .map(segment =>
      renderTemplateSegment(
        segment,
        vars,
      ),
    )
    .join('\n\n');
}

/**
 * Empty variable inputs mean "not supplied", matching the backend renderer's missing-variable
 * behavior: the literal placeholder remains visible instead of being silently replaced with ''.
 */
function compactTemplateVars(
  vars: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(vars).filter(
      ([, value]) =>
        value !== '',
    ),
  );
}

function formatRetryAfter(
  seconds: number | null,
): string | null {
  if (
    seconds === null ||
    seconds <= 0
  ) {
    return null;
  }

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes =
    Math.ceil(
      seconds / 60,
    );

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours =
    Math.ceil(
      minutes / 60,
    );

  return `${hours}h`;
}

// The composer half of the chat room: attachment preview, emoji panel, reply banner, template mode,
// and the input bar with the whole optimistic-send flow.
//
// Manual drafts plus staged attachments live in the parent page so they survive closing the room.
// Stored-template identity deliberately stays local to this composer because it is valid only for
// the current session/chat scope and must never bleed into another conversation.
function ChatComposer({
  selectedSessionId,
  activeChat,
  replyingTo,
  setReplyingTo,
  onMessageAppended,
  setChats,
  messageInput,
  setMessageInput,
  attachment,
  setAttachment,
  previewUrl,
  setPreviewUrl,
}: ChatComposerProps) {
  const {
    t,
  } = useTranslation();

  const {
    canReadTemplates,
    canSendMessages,
  } = useRole();

  const {
    error: showErrorToast,
    warning: showWarningToast,
  } = useToast();

  const {
    appendMessage,
    removeMessage,
    updateMessage,
  } = useChatMessagesActions();

  const queryClient =
    useQueryClient();

  const [
    sending,
    setSending,
  ] = useState(false);

  const [
    showEmojiPicker,
    setShowEmojiPicker,
  ] = useState(false);

  const [
    showTemplatePicker,
    setShowTemplatePicker,
  ] = useState(false);

  const [
    templates,
    setTemplates,
  ] = useState<MessageTemplate[]>([]);

  const [
    loadingTemplates,
    setLoadingTemplates,
  ] = useState(false);

  const [
    selectedTemplate,
    setSelectedTemplate,
  ] = useState<MessageTemplate | null>(
    null,
  );

  const [
    templateVars,
    setTemplateVars,
  ] = useState<Record<string, string>>(
    {},
  );

  const [
    templateQuotaError,
    setTemplateQuotaError,
  ] =
    useState<AgentTemplateQuotaError | null>(
      null,
    );

  const templatePlaceholders =
    useMemo(
      () =>
        selectedTemplate
          ? extractTemplatePlaceholders(
              selectedTemplate,
            )
          : [],
      [
        selectedTemplate,
      ],
    );

  const effectiveTemplateVars =
    useMemo(
      () =>
        compactTemplateVars(
          templateVars,
        ),
      [
        templateVars,
      ],
    );

  const renderedTemplateText =
    useMemo(
      () =>
        selectedTemplate
          ? renderStoredTemplate(
              selectedTemplate,
              effectiveTemplateVars,
            )
          : '',
      [
        effectiveTemplateVars,
        selectedTemplate,
      ],
    );

  /**
   * Loads templates only for roles that may read them.
   *
   * The backend still performs the authoritative TEMPLATE_READ check; this capability gate simply
   * avoids issuing a request that the current dashboard role is known not to be allowed to make.
   */
  useEffect(() => {
    let cancelled = false;

    const loadTemplates =
      async () => {
        if (
          !canReadTemplates ||
          !selectedSessionId
        ) {
          setTemplates([]);
          setLoadingTemplates(false);
          return;
        }

        setLoadingTemplates(true);

        try {
          const result =
            await templateApi.list(
              selectedSessionId,
            );

          if (!cancelled) {
            setTemplates(
              result,
            );
          }
        } catch (err) {
          if (!cancelled) {
            setTemplates([]);

            showErrorToast(
              t(
                'chats.errors.loadTemplates',
                'Unable to load templates',
              ),
              err instanceof Error
                ? err.message
                : undefined,
            );
          }
        } finally {
          if (!cancelled) {
            setLoadingTemplates(
              false,
            );
          }
        }
      };

    void loadTemplates();

    return () => {
      cancelled = true;
    };
  }, [
    canReadTemplates,
    selectedSessionId,
    showErrorToast,
    t,
  ]);

  /**
   * A selected stored template is scoped to the current session/chat.
   *
   * Manual text remains parent-owned and keeps the historical draft behavior, but template identity
   * must never follow the user into another conversation where an accidental Send would target a
   * different chat.
   */
  useEffect(() => {
    setSelectedTemplate(
      null,
    );
    setTemplateVars({});
    setTemplateQuotaError(
      null,
    );
    setShowTemplatePicker(
      false,
    );
  }, [
    activeChat.id,
    selectedSessionId,
  ]);

  /**
   * If the role changes underneath an authenticated dashboard session, immediately leave template
   * mode when the new role cannot read/send templates.
   */
  useEffect(() => {
    if (
      canReadTemplates &&
      canSendMessages
    ) {
      return;
    }

    setSelectedTemplate(
      null,
    );
    setTemplateVars({});
    setTemplateQuotaError(
      null,
    );
    setShowTemplatePicker(
      false,
    );
  }, [
    canReadTemplates,
    canSendMessages,
  ]);

  // Monotonic token invalidating an in-flight attachment FileReader: picking a second file (or
  // removing the attachment) before `onload` fires must win over the late-arriving bytes —
  // otherwise the slower read overwrites the newer pick. Same pattern as composeImageReadSeq.
  const attachmentReadSeq =
    useRef(0);

  // Leaving this conversation — switching to another chat, or unmounting when the room closes —
  // invalidates an in-flight read, so its late `onload` drops the bytes instead of staging them
  // against whichever chat is open by then. The attachment state itself lives in the page.
  useEffect(() => {
    return () => {
      attachmentReadSeq.current +=
        1;
    };
  }, [
    activeChat.id,
  ]);

  const fileInputRef =
    useRef<HTMLInputElement | null>(
      null,
    );

  const popularEmojis = [
    '😀',
    '😂',
    '👍',
    '❤️',
    '🔥',
    '👏',
    '🙏',
    '🎉',
    '💡',
    '🤔',
    '😅',
    '😍',
    '😊',
    '😭',
    '😎',
    '😜',
    '🚀',
    '✨',
  ];

  const handleFileChange = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file =
      event.target.files?.[0];

    // Allow re-picking the same file after a rejection or removal.
    event.target.value = '';

    if (!file) {
      return;
    }

    // Template sends are a dedicated text-only backend operation. The button is disabled while
    // template mode is active, but retain this defensive fence for programmatic/file-input events.
    if (selectedTemplate) {
      showErrorToast(
        t(
          'chats.templates.attachmentNotAllowed',
          'Stored templates cannot be combined with attachments. Use the template as editable text first.',
        ),
      );
      return;
    }

    // Reject before base64-encoding: an oversized pick would inflate ~1.33x into the backend body
    // cap, and the 413 only applies after the whole body is uploaded — surface the toast now.
    if (
      file.size >
      MEDIA_UPLOAD_MAX_BYTES
    ) {
      showErrorToast(
        t(
          'chats.errors.fileTooLarge',
        ),
      );
      return;
    }

    if (
      file.type.startsWith(
        'image/',
      )
    ) {
      setPreviewUrl(
        URL.createObjectURL(
          file,
        ),
      );
    } else {
      setPreviewUrl(
        null,
      );
    }

    const myRead =
      ++attachmentReadSeq.current;

    const reader =
      new FileReader();

    reader.onload =
      readEvent => {
        // A newer pick, a removal, or an unmount since the read started supersedes these bytes.
        if (
          attachmentReadSeq.current !==
          myRead
        ) {
          return;
        }

        const dataUrl =
          readEvent.target
            ?.result as string;

        const base64Data =
          dataUrl.split(
            ',',
          )[1] ?? '';

        setAttachment({
          file,
          base64:
            base64Data,
          mimetype:
            file.type,
          filename:
            file.name,
        });
      };

    reader.readAsDataURL(
      file,
    );
  };

  const handleRemoveAttachment =
    () => {
      // An in-flight read must not resurrect the removed attachment.
      attachmentReadSeq.current +=
        1;

      setAttachment(
        null,
      );
      setPreviewUrl(
        null,
      );

      if (
        fileInputRef.current
      ) {
        fileInputRef.current.value =
          '';
      }
    };

  const triggerFileSelect =
    () => {
      fileInputRef.current?.click();
    };

  const handleEmojiClick = (
    emoji: string,
  ) => {
    if (selectedTemplate) {
      return;
    }

    setMessageInput(
      previous =>
        previous +
        emoji,
    );

    setShowEmojiPicker(
      false,
    );
  };

  const handleTemplateSelect = (
    template: MessageTemplate,
  ) => {
    if (
      attachment ||
      replyingTo
    ) {
      showErrorToast(
        t(
          'chats.templates.incompatibleDraft',
          'Stored templates cannot be combined with an attachment or reply. Finish or clear the current draft first.',
        ),
      );
      return;
    }

    const placeholders =
      extractTemplatePlaceholders(
        template,
      );

    const initialVars =
      Object.fromEntries(
        placeholders.map(
          key => [
            key,
            '',
          ],
        ),
      );

    // A stored-template selection is a distinct send mode. Clear the manual text rather than hiding
    // a draft behind template mode and unexpectedly revealing/sending it after the template send.
    setMessageInput(
      '',
    );
    setSelectedTemplate(
      template,
    );
    setTemplateVars(
      initialVars,
    );
    setTemplateQuotaError(
      null,
    );
    setShowTemplatePicker(
      false,
    );
    setShowEmojiPicker(
      false,
    );
  };

  const useTemplateAsEditableText =
    () => {
      if (!selectedTemplate) {
        return;
      }

      setMessageInput(
        renderedTemplateText,
      );
      setSelectedTemplate(
        null,
      );
      setTemplateVars({});
      setTemplateQuotaError(
        null,
      );
      setShowTemplatePicker(
        false,
      );
  };

  const cancelTemplateMode =
    () => {
      setSelectedTemplate(
        null,
      );
      setTemplateVars({});
      setTemplateQuotaError(
        null,
      );
      setShowTemplatePicker(
        false,
      );
      setMessageInput(
        '',
      );
  };

  const handleTemplateVariableChange =
    (
      key: string,
      value: string,
    ) => {
      setTemplateVars(
        previous => ({
          ...previous,
          [key]:
            value,
        }),
      );
    };

  // Handle sending a manual message/media OR a stored template.
  const handleSend =
    async (
      event?: FormEvent,
    ) => {
      event?.preventDefault();

      if (
        !canSendMessages ||
        !selectedSessionId ||
        !activeChat ||
        sending
      ) {
        return;
      }

      const currentTemplate =
        selectedTemplate;

      const isTemplateSend =
        currentTemplate !==
        null;

      // send-template deliberately has no quotedMessageId/media contract. Never silently route a
      // template selection through reply/send-media, because that would bypass Agent template quota.
      if (
        isTemplateSend &&
        (
          attachment ||
          replyingTo
        )
      ) {
        showErrorToast(
          t(
            'chats.templates.incompatibleDraft',
            'Stored templates cannot be combined with an attachment or reply. Use the template as editable text first.',
          ),
        );
        return;
      }

      const textToSend =
        isTemplateSend
          ? renderedTemplateText
          : messageInput.trim();

      if (
        !textToSend &&
        !attachment
      ) {
        return;
      }

      const currentAttachment =
        isTemplateSend
          ? null
          : attachment;

      const currentReplyingTo =
        isTemplateSend
          ? null
          : replyingTo;

      const currentTemplateVars =
        isTemplateSend
          ? {
              ...effectiveTemplateVars,
            }
          : {};

      // Preserve template identity + variables until the server confirms the send. In particular, a
      // quota 429 must leave the selection intact so the user can understand/retry it. Manual sends
      // keep the historical behavior of clearing the composer immediately.
      if (!isTemplateSend) {
        setMessageInput(
          '',
        );
        handleRemoveAttachment();
        setReplyingTo(
          null,
        );
      }

      setSending(
        true,
      );

      const tempId =
        `temp_${Date.now()}`;

      const tempMessage: ChatMessageView = {
        id:
          tempId,
        chatId:
          activeChat.id,
        from:
          'me',
        to:
          activeChat.id,
        body:
          currentAttachment
            ? currentAttachment.mimetype.startsWith(
                'image/',
              ) ||
              currentAttachment.mimetype.startsWith(
                'video/',
              ) ||
              currentAttachment.mimetype.startsWith(
                'audio/',
              )
              ? textToSend
              : currentAttachment.filename
            : textToSend,
        type:
          currentAttachment
            ? messageTypeFromMime(
                currentAttachment.mimetype,
              )
            : 'text',
        direction:
          'outgoing',
        status:
          'pending',
        createdAt:
          new Date().toISOString(),
        metadata:
          buildOptimisticMetadata(
            currentAttachment,
            currentReplyingTo,
          ),
      };

      appendMessage(
        selectedSessionId,
        activeChat.id,
        tempMessage,
      );

      onMessageAppended(
        'outgoing',
      );

      try {
        let result;

        if (
          isTemplateSend
        ) {
          result =
            await messageApi.sendTemplate(
              selectedSessionId,
              {
                chatId:
                  activeChat.id,
                templateId:
                  currentTemplate.id,
                vars:
                  currentTemplateVars,
              },
            );
        } else if (
          currentAttachment
        ) {
          let mediaType:
            | 'image'
            | 'video'
            | 'audio'
            | 'document' =
            'document';

          const mime =
            currentAttachment.mimetype;

          if (
            mime.startsWith(
              'image/',
            )
          ) {
            mediaType =
              'image';
          } else if (
            mime.startsWith(
              'video/',
            )
          ) {
            mediaType =
              'video';
          } else if (
            mime.startsWith(
              'audio/',
            )
          ) {
            mediaType =
              'audio';
          }

          // A reply that carries an attachment takes this branch, so the quote has to travel with
          // the media — the `else if` below never sees it.
          result =
            await messageApi.sendMedia(
              selectedSessionId,
              activeChat.id,
              mediaType,
              buildMediaSendPayload(
                currentAttachment,
                mediaType !==
                'audio'
                  ? textToSend
                  : undefined,
                currentReplyingTo,
              ),
            );
        } else if (
          currentReplyingTo
        ) {
          result =
            await messageApi.reply(
              selectedSessionId,
              {
                chatId:
                  activeChat.id,
                quotedMessageId:
                  quotedIdOf(
                    currentReplyingTo,
                  )!,
                text:
                  textToSend,
              },
            );
        } else {
          result =
            await messageApi.sendText(
              selectedSessionId,
              activeChat.id,
              textToSend,
            );
        }

        // Race guard: the realtime `message.sent` echo can arrive before this response and already
        // append the message by its real WA id (the dedup at receive time misses because the
        // optimistic placeholder still carries the temp id). If so, fold the placeholder INTO the
        // echo's row via mergeOrAppend instead of just dropping it — the echo may carry no media
        // payload (a Baileys API send echoes only a marker), so dropping the placeholder would erase
        // the attachment's base64 and leave a bare "📎 Media" bubble until the next refetch.
        const sendKey =
          messagesQueryKey(
            selectedSessionId,
            activeChat.id,
          );

        queryClient.setQueryData<
          ChatMessageView[]
        >(
          sendKey,
          (
            previous =
              [],
          ) => {
            const reconciled: ChatMessageView = {
              ...tempMessage,
              id:
                result.messageId,
              waMessageId:
                result.messageId,
              status:
                'sent',
            };

            const echoAlreadyAdded =
              previous.some(
                message =>
                  message.id ===
                    result.messageId ||
                  message.waMessageId ===
                    result.messageId,
              );

            if (
              echoAlreadyAdded
            ) {
              return mergeOrAppend(
                previous.filter(
                  message =>
                    message.id !==
                    tempId,
                ),
                reconciled,
              );
            }

            return previous.map(
              message =>
                message.id ===
                tempId
                  ? reconciled
                  : message,
            );
          },
        );

        // Update sidebar chat list (move active chat to the top with the new snippet).
        const snippet =
          currentAttachment
            ? `[${currentAttachment.mimetype.split('/')[0]}]`
            : textToSend;

        const sentAt =
          Math.floor(
            Date.now() /
              1000,
          );

        setChats(
          previousChats =>
            promoteChatWithSnippet(
              previousChats,
              activeChat.id,
              snippet,
              sentAt,
            ),
        );

        if (
          isTemplateSend
        ) {
          setSelectedTemplate(
            null,
          );
          setTemplateVars({});
          setTemplateQuotaError(
            null,
          );
        }
      } catch (err) {
        if (
          isTemplateSend &&
          isAgentTemplateQuotaError(
            err,
          )
        ) {
          // This refusal happens before the message send. Remove the optimistic placeholder instead
          // of leaving a misleading failed WhatsApp bubble, and preserve all template state.
          removeMessage(
            selectedSessionId,
            activeChat.id,
            tempId,
          );

          setTemplateQuotaError(
            err,
          );

          const retryAfter =
            formatRetryAfter(
              err.retryAfterSeconds,
            );

          showWarningToast(
            t(
              'chats.templates.quotaReached',
              'Template send limit reached',
            ),
            retryAfter
              ? t(
                  'chats.templates.quotaRetry',
                  `Used ${err.used24h} of ${err.templateSendLimit24h}. Try again in about ${retryAfter}.`,
                )
              : err.message,
          );
        } else {
          showErrorToast(
            t(
              'chats.errors.send',
            ),
            err instanceof Error
              ? err.message
              : undefined,
          );

          updateMessage(
            selectedSessionId,
            activeChat.id,
            tempId,
            {
              status:
                'failed',
            },
          );
        }
      } finally {
        setSending(
          false,
        );
      }
    };

  const retryAfterLabel =
    templateQuotaError
      ? formatRetryAfter(
          templateQuotaError.retryAfterSeconds,
        )
      : null;

  const templateButtonDisabled =
    !canReadTemplates ||
    !canSendMessages ||
    sending ||
    Boolean(
      attachment ||
      replyingTo ||
      selectedTemplate,
    );

  return (
    <>
      {/* Attachment preview banner */}
      {attachment && (
        <div className="attachment-preview-banner">
          {previewUrl ? (
            <img
              src={previewUrl}
              alt={attachment.filename}
              className="preview-thumbnail"
            />
          ) : (
            <div className="preview-file-icon">
              📎
            </div>
          )}

          <div className="preview-file-info">
            <span className="preview-filename">
              {attachment.filename}
            </span>

            <span className="preview-filesize">
              (
              {(
                attachment.file.size /
                1024
              ).toFixed(
                1,
              )}{' '}
              KB)
            </span>
          </div>

          <button
            type="button"
            className="btn-remove-attachment"
            onClick={handleRemoveAttachment}
            disabled={sending}
          >
            <X
              size={18}
            />
          </button>
        </div>
      )}

      {/* Popular emojis panel */}
      {showEmojiPicker &&
        !selectedTemplate && (
          <div className="chats-emoji-picker">
            <div className="emoji-grid">
              {popularEmojis.map(
                emoji => (
                  <button
                    key={emoji}
                    type="button"
                    className="emoji-btn"
                    onClick={() =>
                      handleEmojiClick(
                        emoji,
                      )
                    }
                  >
                    {emoji}
                  </button>
                ),
              )}
            </div>
          </div>
        )}

      {/* Template picker for the active session. */}
      {showTemplatePicker &&
        !selectedTemplate && (
          <div className="chats-template-picker">
            {loadingTemplates ? (
              <div className="template-picker-loading">
                <Loader2
                  className="animate-spin"
                  size={18}
                />

                <span>
                  {t(
                    'chats.loadingTemplates',
                    'Loading templates…',
                  )}
                </span>
              </div>
            ) : templates.length ===
              0 ? (
              <div className="template-picker-empty">
                {t(
                  'chats.noTemplates',
                  'No templates available',
                )}
              </div>
            ) : (
              <select
                className="template-select"
                value=""
                onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                  const template =
                    templates.find(
                      item =>
                        item.id ===
                        event.target.value,
                    );

                  if (
                    template
                  ) {
                    handleTemplateSelect(
                      template,
                    );
                  }
                }}
              >
                <option value="">
                  {t(
                    'chats.selectTemplate',
                    'Select template',
                  )}
                </option>

                {templates.map(
                  template => (
                    <option
                      key={
                        template.id
                      }
                      value={
                        template.id
                      }
                    >
                      {
                        template.name
                      }
                    </option>
                  ),
                )}
              </select>
            )}
          </div>
        )}

      {/* Stored-template mode. Identity remains intact until success or explicit conversion/cancel. */}
      {selectedTemplate && (
        <div className="chats-template-selection">
          <div className="template-selection-header">
            <div className="template-selection-copy">
              <span className="template-selection-label">
                {t(
                  'chats.templates.selected',
                  'Stored template',
                )}
              </span>

              <strong>
                {
                  selectedTemplate.name
                }
              </strong>
            </div>

            <div className="template-selection-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={
                  useTemplateAsEditableText
                }
                disabled={sending}
              >
                {t(
                  'chats.templates.useEditable',
                  'Use as editable text',
                )}
              </button>

              <button
                type="button"
                className="btn-remove-attachment"
                onClick={
                  cancelTemplateMode
                }
                disabled={sending}
                aria-label={t(
                  'common.cancel',
                  'Cancel',
                )}
                title={t(
                  'common.cancel',
                  'Cancel',
                )}
              >
                <X
                  size={18}
                />
              </button>
            </div>
          </div>

          {templatePlaceholders.length >
            0 && (
            <div className="template-variable-grid">
              {templatePlaceholders.map(
                key => (
                  <label
                    key={key}
                    className="template-variable-field"
                  >
                    <span>
                      {`{{${key}}}`}
                    </span>

                    <input
                      type="text"
                      value={
                        templateVars[
                          key
                        ] ?? ''
                      }
                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                        handleTemplateVariableChange(
                          key,
                          event.target
                            .value,
                        )
                      }
                      disabled={
                        sending
                      }
                      placeholder={t(
                        'chats.templates.variablePlaceholder',
                        'Value',
                      )}
                    />
                  </label>
                ),
              )}
            </div>
          )}

          {templateQuotaError && (
            <div
              className="template-quota-warning"
              role="alert"
            >
              <strong>
                {t(
                  'chats.templates.quotaReached',
                  'Template send limit reached',
                )}
              </strong>

              <span>
                {t(
                  'chats.templates.quotaUsage',
                  `Used ${templateQuotaError.used24h} of ${templateQuotaError.templateSendLimit24h} stored-template sends in the rolling 24-hour window.`,
                )}
              </span>

              {retryAfterLabel && (
                <span>
                  {t(
                    'chats.templates.quotaRetryShort',
                    `Retry in about ${retryAfterLabel}.`,
                  )}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Replying preview banner */}
      {replyingTo && (
        <div className="replying-preview-banner">
          <div className="replying-preview-content">
            <div className="replying-to-title">
              {t(
                'chats.replyingTo',
                {
                  name:
                    replyingTo.direction ===
                    'outgoing'
                      ? t(
                          'chats.you',
                        )
                      : activeChat.name ||
                        activeChat.id.split(
                          '@',
                        )[0],
                },
              )}
            </div>

            <div className="replying-to-body">
              {replyingTo.type !==
              'text'
                ? `[${replyingTo.type}]`
                : replyingTo.body}
            </div>
          </div>

          <button
            type="button"
            className="btn-close-reply"
            onClick={() =>
              setReplyingTo(
                null,
              )
            }
            disabled={sending}
          >
            <X
              size={18}
            />
          </button>
        </div>
      )}

      {/* Message input bar */}
      <footer className="room-input-footer">
        <form
          onSubmit={handleSend}
          className="input-form"
        >
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            style={{
              display:
                'none',
            }}
          />

          <button
            type="button"
            onClick={triggerFileSelect}
            disabled={
              !canSendMessages ||
              sending ||
              Boolean(
                selectedTemplate,
              )
            }
            className="btn-input-accessory"
            title={t(
              'chats.attachTitle',
            )}
          >
            <Paperclip
              size={20}
            />
          </button>

          <button
            type="button"
            onClick={() =>
              setShowEmojiPicker(
                previous =>
                  !previous,
              )
            }
            disabled={
              !canSendMessages ||
              sending ||
              Boolean(
                selectedTemplate,
              )
            }
            className={`btn-input-accessory ${
              showEmojiPicker
                ? 'active'
                : ''
            }`}
            title={t(
              'chats.emojiTitle',
            )}
          >
            <Smile
              size={20}
            />
          </button>

          {canReadTemplates && (
            <button
              type="button"
              onClick={() => {
                setShowEmojiPicker(
                  false,
                );

                setShowTemplatePicker(
                  previous =>
                    !previous,
                );
              }}
              disabled={
                templateButtonDisabled
              }
              className={`btn-input-accessory ${
                showTemplatePicker
                  ? 'active'
                  : ''
              }`}
              title={t(
                'chats.templates.title',
                'Templates',
              )}
              aria-label={t(
                'chats.templates.title',
                'Templates',
              )}
            >
              <FileText
                size={20}
              />
            </button>
          )}

          <textarea
            placeholder={
              canSendMessages
                ? selectedTemplate
                  ? t(
                      'chats.templates.preview',
                      'Template preview',
                    )
                  : attachment
                    ? t(
                        'chats.captionPlaceholder',
                      )
                    : t(
                        'chats.messagePlaceholder',
                      )
                : t(
                    'chats.noPermission',
                  )
            }
            value={
              selectedTemplate
                ? renderedTemplateText
                : messageInput
            }
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
              if (
                !selectedTemplate
              ) {
                setMessageInput(
                  event.target.value,
                );
              }
            }}
            readOnly={
              Boolean(
                selectedTemplate,
              )
            }
            disabled={
              !canSendMessages ||
              sending
            }
            className="message-text-input"
            rows={1}
          />

          <button
            type="submit"
            disabled={
              !canSendMessages ||
              sending ||
              (
                selectedTemplate
                  ? !renderedTemplateText.trim()
                  : !messageInput.trim() &&
                    !attachment
              )
            }
            className="btn-send-message"
            aria-label={
              selectedTemplate
                ? t(
                    'chats.templates.send',
                    'Send template',
                  )
                : t(
                    'chats.send',
                  )
            }
            title={
              selectedTemplate
                ? t(
                    'chats.templates.send',
                    'Send template',
                  )
                : undefined
            }
          >
            {sending ? (
              <Loader2
                className="animate-spin"
                size={24}
              />
            ) : (
              <Send
                size={28}
                strokeWidth={2.5}
              />
            )}
          </button>
        </form>
      </footer>
    </>
  );
}

export default ChatComposer;



