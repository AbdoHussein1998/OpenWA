




import {
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import {
  Copy,
  FileText,
  Loader2,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';

import {
  type MessageTemplate,
  type TemplatePayload,
} from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../hooks/useToast';
import {
  useCreateTemplateMutation,
  useDeleteTemplateMutation,
  useSessionsQuery,
  useTemplatesQuery,
  useUpdateTemplateMutation,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { copyToClipboard } from '../utils/clipboard';

import './Templates.css';

type TemplateForm = {
  name: string;
  header: string;
  body: string;
  footer: string;
};

const EMPTY_FORM: TemplateForm = {
  name: '',
  header: '',
  body: '',
  footer: '',
};

// Keep preview/placeholder discovery aligned with the backend renderer: canonical {{name}} plus the
// legacy single-brace {name} form. Double braces are matched first so they are never partially
// consumed by the legacy branch.
const TEMPLATE_PLACEHOLDER_PATTERN =
  /\{\{\s*([\w.-]+)\s*\}\}|\{(\w+)\}/g;

function extractPlaceholders(
  template:
    | TemplateForm
    | MessageTemplate,
): string[] {
  const source = [
    template.header,
    template.body,
    template.footer,
  ]
    .filter(
      (segment): segment is string =>
        Boolean(
          segment,
        ),
    )
    .join('\n');

  const keys =
    new Set<string>();

  for (
    const match of source.matchAll(
      TEMPLATE_PLACEHOLDER_PATTERN,
    )
  ) {
    const key =
      match[1] ??
      match[2];

    if (key) {
      keys.add(
        key,
      );
    }
  }

  return Array.from(
    keys,
  ).sort();
}

function toPayload(
  form: TemplateForm,
): TemplatePayload {
  return {
    name:
      form.name.trim(),
    header:
      form.header.trim() ||
      null,
    body:
      form.body.trim(),
    footer:
      form.footer.trim() ||
      null,
  };
}

function renderPreview(
  template: TemplateForm,
  values: Record<string, string>,
): string {
  return [
    template.header,
    template.body,
    template.footer,
  ]
    .filter(
      Boolean,
    )
    .join('\n\n')
    .replace(
      TEMPLATE_PLACEHOLDER_PATTERN,
      (
        match,
        doubleKey:
          string | undefined,
        singleKey:
          string | undefined,
      ) => {
        const key =
          doubleKey ??
          singleKey;

        if (
          key !== undefined &&
          Object.prototype.hasOwnProperty.call(
            values,
            key,
          ) &&
          values[key]
        ) {
          return values[key];
        }

        return match;
      },
    );
}

export function Templates() {
  const {
    t,
  } =
    useTranslation();

  useDocumentTitle(
    t(
      'templates.title',
    ),
  );

  const {
    canManageTemplates,
    canReadTemplates,
  } =
    useRole();

  const [
    searchParams,
    setSearchParams,
  ] =
    useSearchParams();

  const requestedSessionId =
    searchParams.get(
      'session',
    ) ?? '';

  const {
    data:
      sessions = [],
    isLoading:
      loadingSessions,
  } =
    useSessionsQuery();

  const [
    selectedSessionId,
    setSelectedSessionId,
  ] =
    useState('');

  const [
    form,
    setForm,
  ] =
    useState<TemplateForm>(
      EMPTY_FORM,
    );

  const [
    editingTemplate,
    setEditingTemplate,
  ] =
    useState<MessageTemplate | null>(
      null,
    );

  const [
    deleteTarget,
    setDeleteTarget,
  ] =
    useState<MessageTemplate | null>(
      null,
    );

  const toast =
    useToast();

  const [
    previewValues,
    setPreviewValues,
  ] =
    useState<Record<string, string>>(
      {},
    );

  const [
    searchTerm,
    setSearchTerm,
  ] =
    useState('');

  const {
    data:
      templates = [],
    isLoading:
      loadingTemplates,
  } =
    useTemplatesQuery(
      selectedSessionId,
      canReadTemplates &&
        Boolean(
          selectedSessionId,
        ),
    );

  const createMutation =
    useCreateTemplateMutation();

  const updateMutation =
    useUpdateTemplateMutation();

  const deleteMutation =
    useDeleteTemplateMutation();

  const selectedSession =
    sessions.find(
      session =>
        session.id ===
        selectedSessionId,
    );

  const placeholders =
    useMemo(
      () =>
        extractPlaceholders(
          form,
        ),
      [
        form,
      ],
    );

  const preview =
    useMemo(
      () =>
        renderPreview(
          form,
          previewValues,
        ),
      [
        form,
        previewValues,
      ],
    );

  const filteredTemplates =
    useMemo(() => {
      const query =
        searchTerm
          .trim()
          .toLowerCase();

      if (!query) {
        return templates;
      }

      return templates.filter(
        template =>
          [
            template.name,
            template.header,
            template.body,
            template.footer,
          ]
            .filter(
              (
                value,
              ): value is string =>
                Boolean(
                  value,
                ),
            )
            .some(
              value =>
                value
                  .toLowerCase()
                  .includes(
                    query,
                  ),
            ),
      );
    }, [
      searchTerm,
      templates,
    ]);

  const isSaving =
    createMutation.isPending ||
    updateMutation.isPending;

  /**
   * Resolve the selected session only from the sessions authorized for
   * the current API key.
   *
   * `/templates?session=<id>` is a navigation hint, not an authorization
   * mechanism. If the requested id is not present in the backend-scoped
   * sessions list (for example, an Agent pastes another session id), we
   * fall back to the first authorized session and normalize the URL.
   */
  useEffect(() => {
    const requestedIsAuthorized =
      Boolean(
        requestedSessionId,
      ) &&
      sessions.some(
        session =>
          session.id ===
          requestedSessionId,
      );

    const currentIsAuthorized =
      Boolean(
        selectedSessionId,
      ) &&
      sessions.some(
        session =>
          session.id ===
          selectedSessionId,
      );

    const nextSessionId =
      requestedIsAuthorized
        ? requestedSessionId
        : currentIsAuthorized
          ? selectedSessionId
          : sessions[0]?.id ??
            '';

    if (
      nextSessionId !==
      selectedSessionId
    ) {
      setSelectedSessionId(
        nextSessionId,
      );

      setForm(
        EMPTY_FORM,
      );

      setEditingTemplate(
        null,
      );

      setPreviewValues({});
    }

    if (
      nextSessionId &&
      requestedSessionId !==
        nextSessionId
    ) {
      setSearchParams(
        {
          session:
            nextSessionId,
        },
        {
          replace:
            true,
        },
      );
    }
  }, [
    requestedSessionId,
    selectedSessionId,
    sessions,
    setSearchParams,
  ]);

  useEffect(() => {
    setPreviewValues(
      current => {
        const next:
          Record<
            string,
            string
          > =
          {};

        for (
          const key of
            placeholders
        ) {
          next[key] =
            current[key] ||
            '';
        }

        return next;
      },
    );
  }, [
    placeholders,
  ]);

  const resetForm =
    () => {
      setForm(
        EMPTY_FORM,
      );

      setEditingTemplate(
        null,
      );

      setPreviewValues({});
    };

  const openTemplate =
    (
      template:
        MessageTemplate,
    ) => {
      setEditingTemplate(
        template,
      );

      setForm({
        name:
          template.name,
        header:
          template.header ||
          '',
        body:
          template.body,
        footer:
          template.footer ||
          '',
      });

      window.scrollTo({
        top:
          0,
        behavior:
          'smooth',
      });
    };

  const handleSave =
    async () => {
      if (
        !canManageTemplates ||
        !selectedSessionId ||
        !form.name.trim() ||
        !form.body.trim()
      ) {
        return;
      }

      try {
        if (
          editingTemplate
        ) {
          await updateMutation.mutateAsync(
            {
              sessionId:
                selectedSessionId,
              id:
                editingTemplate.id,
              data:
                toPayload(
                  form,
                ),
            },
          );

          toast.success(
            t(
              'templates.toasts.updated',
            ),
          );
        } else {
          await createMutation.mutateAsync(
            {
              sessionId:
                selectedSessionId,
              data:
                toPayload(
                  form,
                ),
            },
          );

          toast.success(
            t(
              'templates.toasts.created',
            ),
          );
        }

        resetForm();
      } catch (
        error
      ) {
        toast.error(
          t(
            editingTemplate
              ? 'templates.toasts.updateFailed'
              : 'templates.toasts.createFailed',
            {
              message:
                error instanceof
                Error
                  ? error.message
                  : t(
                      'common.unknownError',
                    ),
            },
          ),
        );
      }
    };

  const handleDelete =
    async () => {
      if (
        !canManageTemplates ||
        !selectedSessionId ||
        !deleteTarget
      ) {
        return;
      }

      try {
        await deleteMutation.mutateAsync(
          {
            sessionId:
              selectedSessionId,
            id:
              deleteTarget.id,
          },
        );

        toast.success(
          t(
            'templates.toasts.deleted',
          ),
        );

        if (
          editingTemplate?.id ===
          deleteTarget.id
        ) {
          resetForm();
        }

        setDeleteTarget(
          null,
        );
      } catch (
        error
      ) {
        toast.error(
          t(
            'templates.toasts.deleteFailed',
            {
              message:
                error instanceof
                Error
                  ? error.message
                  : t(
                      'common.unknownError',
                    ),
            },
          ),
        );
      }
    };

  const copyName =
    async (
      name: string,
    ) => {
      if (
        await copyToClipboard(
          name,
        )
      ) {
        toast.success(
          t(
            'templates.toasts.copied',
          ),
        );
      }
    };

  if (
    loadingSessions
  ) {
    return (
      <div className="templates-page templates-loading">
        <Loader2
          className="animate-spin"
          size={32}
        />
      </div>
    );
  }

  return (
    <div className="templates-page">
      <PageHeader
        title={
          t(
            'templates.title',
          )
        }
        subtitle={
          canManageTemplates
            ? t(
                'templates.subtitle',
              )
            : t(
                'templates.readOnlySubtitle',
                'Browse stored templates available to your assigned session.',
              )
        }
        actions={
          <select
            className="templates-session-select"
            aria-label={
              t(
                'templates.sessionSelect',
              )
            }
            value={
              selectedSessionId
            }
            onChange={
              event => {
                const sessionId =
                  event.target.value;

                setSelectedSessionId(
                  sessionId,
                );

                setSearchParams(
                  sessionId
                    ? {
                        session:
                          sessionId,
                      }
                    : {},
                  {
                    replace:
                      true,
                  },
                );

                resetForm();
              }
            }
          >
            {sessions.length ===
              0 && (
              <option value="">
                {t(
                  'templates.noSessions',
                )}
              </option>
            )}

            {sessions.map(
              session => (
                <option
                  key={
                    session.id
                  }
                  value={
                    session.id
                  }
                >
                  {
                    session.name
                  }
                </option>
              ),
            )}
          </select>
        }
      />

      {sessions.length ===
      0 ? (
        <div className="templates-empty-page">
          <FileText
            size={48}
            strokeWidth={1}
          />

          <h3>
            {t(
              'templates.empty.noSessionsTitle',
            )}
          </h3>

          <p>
            {t(
              'templates.empty.noSessionsDesc',
            )}
          </p>
        </div>
      ) : (
        <div className="templates-workspace">
          <aside className="templates-library">
            <div className="templates-library-header">
              <div>
                <h2>
                  {t(
                    'templates.savedTitle',
                  )}
                </h2>

                <span>
                  {t(
                    'templates.count',
                    {
                      count:
                        templates.length,
                    },
                  )}
                </span>
              </div>

              {canManageTemplates && (
                <button
                  className="btn-primary templates-new-btn"
                  onClick={
                    resetForm
                  }
                  type="button"
                >
                  <Plus
                    size={16}
                  />

                  {t(
                    'templates.newTemplate',
                  )}
                </button>
              )}
            </div>

            <div className="templates-search">
              <Search
                size={16}
              />

              <input
                value={
                  searchTerm
                }
                onChange={
                  event =>
                    setSearchTerm(
                      event.target.value,
                    )
                }
                placeholder={
                  t(
                    'common.search',
                  )
                }
              />
            </div>

            {loadingTemplates ? (
              <div className="templates-loading-inline">
                <Loader2
                  className="animate-spin"
                  size={24}
                />
              </div>
            ) : templates.length ===
              0 ? (
              <div className="templates-empty-list">
                <FileText
                  size={40}
                  strokeWidth={1}
                />

                <h3>
                  {t(
                    'templates.empty.title',
                  )}
                </h3>

                <p>
                  {t(
                    'templates.empty.description',
                  )}
                </p>
              </div>
            ) : filteredTemplates.length ===
              0 ? (
              <div className="templates-empty-list compact">
                <Search
                  size={32}
                  strokeWidth={1.5}
                />

                <h3>
                  {t(
                    'templates.empty.title',
                  )}
                </h3>
              </div>
            ) : (
              <div
                className="template-list"
                role="list"
              >
                {filteredTemplates.map(
                  template => {
                    const templatePlaceholders =
                      extractPlaceholders(
                        template,
                      );

                    const isSelected =
                      editingTemplate?.id ===
                      template.id;

                    return (
                      <button
                        key={
                          template.id
                        }
                        className={`template-list-item ${
                          isSelected
                            ? 'selected'
                            : ''
                        }`}
                        onClick={() =>
                          openTemplate(
                            template,
                          )
                        }
                        type="button"
                      >
                        <span className="template-list-title">
                          {
                            template.name
                          }
                        </span>

                        <span className="template-list-body">
                          {
                            template.body
                          }
                        </span>

                        <span className="template-list-meta">
                          {templatePlaceholders.length >
                          0
                            ? templatePlaceholders
                                .map(
                                  key =>
                                    `{{${key}}}`,
                                )
                                .join(
                                  ' ',
                                )
                            : t(
                                'templates.noPlaceholders',
                              )}
                        </span>
                      </button>
                    );
                  },
                )}
              </div>
            )}
          </aside>

          <section className="template-editor">
            <div className="template-editor-header">
              <div>
                <h2>
                  {editingTemplate
                    ? canManageTemplates
                      ? t(
                          'templates.editTitle',
                        )
                      : t(
                          'templates.viewTitle',
                          'View template',
                        )
                    : canManageTemplates
                      ? t(
                          'templates.createTitle',
                        )
                      : t(
                          'templates.selectTitle',
                          'Select a template',
                        )}
                </h2>

                <p>
                  {selectedSession
                    ? t(
                        'templates.sessionHint',
                        {
                          name:
                            selectedSession.name,
                        },
                      )
                    : ''}
                </p>
              </div>

              <div className="template-header-actions">
                {editingTemplate && (
                  <button
                    className="icon-btn"
                    title={
                      t(
                        'templates.actions.copyName',
                      )
                    }
                    onClick={() =>
                      void copyName(
                        editingTemplate.name,
                      )
                    }
                    type="button"
                  >
                    <Copy
                      size={16}
                    />
                  </button>
                )}

                {editingTemplate &&
                  canManageTemplates && (
                  <button
                    className="icon-btn danger"
                    title={
                      t(
                        'common.delete',
                      )
                    }
                    onClick={() =>
                      setDeleteTarget(
                        editingTemplate,
                      )
                    }
                    type="button"
                  >
                    <Trash2
                      size={16}
                    />
                  </button>
                )}
              </div>
            </div>

            <div className="template-form">
              <div className="form-group">
                <label htmlFor="tpl-1">
                  {t(
                    'common.name',
                  )}
                </label>

                <input
                  id="tpl-1"
                  value={
                    form.name
                  }
                  onChange={
                    event =>
                      setForm({
                        ...form,
                        name:
                          event.target.value,
                      })
                  }
                  placeholder={
                    t(
                      'templates.namePlaceholder',
                    )
                  }
                  disabled={
                    !canManageTemplates
                  }
                />
              </div>

              <div className="template-message-fields">
                <div className="form-group">
                  <label htmlFor="tpl-2">
                    {t(
                      'templates.header',
                    )}
                  </label>

                  <input
                    id="tpl-2"
                    value={
                      form.header
                    }
                    onChange={
                      event =>
                        setForm({
                          ...form,
                          header:
                            event.target.value,
                        })
                    }
                    placeholder={
                      t(
                        'templates.headerPlaceholder',
                      )
                    }
                    disabled={
                      !canManageTemplates
                    }
                  />
                </div>

                <div className="form-group body-field">
                  <label htmlFor="tpl-3">
                    {t(
                      'templates.body',
                    )}
                  </label>

                  <textarea
                    id="tpl-3"
                    value={
                      form.body
                    }
                    onChange={
                      event =>
                        setForm({
                          ...form,
                          body:
                            event.target.value,
                        })
                    }
                    placeholder={
                      t(
                        'templates.bodyPlaceholder',
                      )
                    }
                    rows={10}
                    disabled={
                      !canManageTemplates
                    }
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="tpl-4">
                    {t(
                      'templates.footer',
                    )}
                  </label>

                  <input
                    id="tpl-4"
                    value={
                      form.footer
                    }
                    onChange={
                      event =>
                        setForm({
                          ...form,
                          footer:
                            event.target.value,
                        })
                    }
                    placeholder={
                      t(
                        'templates.footerPlaceholder',
                      )
                    }
                    disabled={
                      !canManageTemplates
                    }
                  />
                </div>
              </div>

              {canManageTemplates && (
                <div className="template-editor-actions">
                  <button
                    className="btn-secondary"
                    onClick={
                      resetForm
                    }
                    disabled={
                      isSaving
                    }
                    type="button"
                  >
                    {t(
                      'common.cancel',
                    )}
                  </button>

                  <button
                    className="btn-primary"
                    onClick={() =>
                      void handleSave()
                    }
                    disabled={
                      isSaving ||
                      !selectedSessionId ||
                      !form.name.trim() ||
                      !form.body.trim()
                    }
                    type="button"
                  >
                    {isSaving ? (
                      <Loader2
                        size={18}
                        className="animate-spin"
                      />
                    ) : (
                      <Plus
                        size={18}
                      />
                    )}

                    {t(
                      editingTemplate
                        ? 'templates.saveChanges'
                        : 'templates.createTemplate',
                    )}
                  </button>
                </div>
              )}
            </div>
          </section>

          <aside className="template-preview">
            <div className="template-preview-header">
              <h2>
                {t(
                  'templates.previewTitle',
                )}
              </h2>

              <span>
                {
                  placeholders.length
                }
              </span>
            </div>

            <div className="template-preview-message">
              <pre>
                {preview ||
                  t(
                    'templates.previewEmpty',
                  )}
              </pre>
            </div>

            <div className="template-variable-panel">
              {placeholders.length >
              0 ? (
                <div className="placeholder-list">
                  {placeholders.map(
                    key => (
                      <label
                        key={
                          key
                        }
                      >
                        <span>
                          {`{{${key}}}`}
                        </span>

                        <input
                          value={
                            previewValues[
                              key
                            ] ||
                            ''
                          }
                          onChange={
                            event =>
                              setPreviewValues({
                                ...previewValues,
                                [key]:
                                  event.target.value,
                              })
                          }
                          placeholder={
                            t(
                              'templates.previewValuePlaceholder',
                            )
                          }
                        />
                      </label>
                    ),
                  )}
                </div>
              ) : (
                <p className="template-muted">
                  {t(
                    'templates.noPlaceholders',
                  )}
                </p>
              )}
            </div>
          </aside>
        </div>
      )}

      {deleteTarget &&
        canManageTemplates && (
        <Modal
          open
          onClose={() =>
            setDeleteTarget(
              null,
            )
          }
          title={
            t(
              'templates.deleteTitle',
            )
          }
          className="modal-sm"
          closeLabel={
            t(
              'common.close',
            )
          }
          footer={
            <>
              <button
                className="btn-secondary"
                onClick={() =>
                  setDeleteTarget(
                    null,
                  )
                }
                type="button"
              >
                {t(
                  'common.cancel',
                )}
              </button>

              <button
                className="btn-danger"
                onClick={() =>
                  void handleDelete()
                }
                disabled={
                  deleteMutation.isPending
                }
                type="button"
              >
                {deleteMutation.isPending ? (
                  <Loader2
                    size={18}
                    className="animate-spin"
                  />
                ) : (
                  <Trash2
                    size={18}
                  />
                )}

                {t(
                  'common.delete',
                )}
              </button>
            </>
          }
        >
          <p>
            {t(
              'templates.deleteConfirm',
              {
                name:
                  deleteTarget.name,
              },
            )}
          </p>
        </Modal>
      )}
    </div>
  );
}






