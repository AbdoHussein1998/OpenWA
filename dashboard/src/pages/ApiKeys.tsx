





import {
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  Trans,
  useTranslation,
} from 'react-i18next';
import {
  useTable,
  tableFeatures,
  createColumnHelper,
  createCoreRowModel,
  columnVisibilityFeature,
  flexRender,
  type ColumnVisibilityState,
} from '@tanstack/react-table';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';

import type {
  ApiKey,
  GenericApiKeyRole,
} from '../services/api';

import {
  useAdminTeamLeadersQuery,
  useApiKeysQuery,
  useCreateAdminAgentMutation,
  useCreateAdminTeamLeaderMutation,
  useCreateApiKeyMutation,
  useDeleteApiKeyMutation,
  useReissueApiKeyMutation,
  useRevokeApiKeyMutation,
} from '../hooks/queries';

import {
  useDocumentTitle,
} from '../hooks/useDocumentTitle';

import {
  PageHeader,
} from '../components/PageHeader';

import {
  Modal,
} from '../components/Modal';

import {
  GeneratedKeyField,
} from '../components/GeneratedKeyField';

import {
  useToast,
} from '../hooks/useToast';

import {
  useRole,
} from '../hooks/useRole';

import {
  copyToClipboard,
} from '../utils/clipboard';

import './ApiKeys.css';

const genericRoleNames = [
  'admin',
  'operator',
  'viewer',
] as const satisfies readonly GenericApiKeyRole[];

const credentialRoleNames = [
  ...genericRoleNames,
  'team_leader',
  'agent',
] as const satisfies readonly ApiKey['role'][];

const roleFallbackLabels:
  Record<ApiKey['role'], string> = {
    admin: 'Admin',
    operator: 'Operator',
    viewer: 'Viewer',
    team_leader: 'Team Leader',
    agent: 'Agent',
  };

const roleFallbackDescriptions:
  Record<ApiKey['role'], string> = {
    admin:
      'Full administrative access.',
    operator:
      'Administrative access except infrastructure; the primary Admin API key remains deletion-protected.',
    viewer:
      'Read-only dashboard access.',
    team_leader:
      'Tenant-scoped Team Leader credential bound to a Team Leader principal.',
    agent:
      'Assignment-scoped Agent credential bound to an Agent principal.',
  };

interface NewCredentialForm {
  name: string;
  role: ApiKey['role'];
  email: string;
  teamLeaderId: string;
}

interface CreatedCredential {
  apiKey: string;
  name: string;
  role: ApiKey['role'];
  reason: 'created' | 'reissued';
}

const EMPTY_CREDENTIAL_FORM:
  NewCredentialForm = {
    name: '',
    role: 'operator',
    email: '',
    teamLeaderId: '',
  };

function isGenericApiKeyRole(
  role: ApiKey['role'],
): role is GenericApiKeyRole {
  return (
    genericRoleNames as readonly ApiKey['role'][]
  ).includes(role);
}

function isManagementRole(
  role: ApiKey['role'],
): role is
  | 'team_leader'
  | 'agent' {
  return (
    role === 'team_leader' ||
    role === 'agent'
  );
}

type ApiKeyWithPrimaryAdminFlag =
  ApiKey & {
    isPrimaryAdminKey?: boolean;
  };

function isPrimaryAdminKey(
  apiKey: ApiKey,
): boolean {
  return (
    apiKey as ApiKeyWithPrimaryAdminFlag
  ).isPrimaryAdminKey === true;
}

/**
 * Principal credentials are stored with a role prefix in the backend key
 * name (for example "Team Leader: Ahmed"). The Role column already carries
 * that information, so the Name column shows only the human-facing principal
 * name while leaving the persisted value untouched.
 */
function credentialDisplayName(
  apiKey: ApiKey,
): string {
  const name =
    apiKey.name.trim();

  if (
    apiKey.role ===
    'team_leader'
  ) {
    const stripped =
      name.replace(
        /^Team Leader:\s*/i,
        '',
      );

    return stripped || name;
  }

  if (
    apiKey.role === 'agent'
  ) {
    const stripped =
      name.replace(
        /^Agent:\s*/i,
        '',
      );

    return stripped || name;
  }

  return name;
}

function isValidEmail(
  value: string,
): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    value,
  );
}

function useWindowSize() {
  const [
    width,
    setWidth,
  ] = useState(
    window.innerWidth,
  );

  useEffect(() => {
    const handleResize =
      () =>
        setWidth(
          window.innerWidth,
        );

    window.addEventListener(
      'resize',
      handleResize,
    );

    return () =>
      window.removeEventListener(
        'resize',
        handleResize,
      );
  }, []);

  return width;
}

const features =
  tableFeatures({
    columnVisibilityFeature,
    coreRowModel:
      createCoreRowModel(),
  });

const columnHelper =
  createColumnHelper<
    typeof features,
    ApiKey
  >();

export function ApiKeys() {
  const {
    t,
  } =
    useTranslation();

  const toast =
    useToast();

  const {
    isOperator,
  } = useRole();

  useDocumentTitle(
    t(
      'apiKeys.title',
    ),
  );

  const {
    data:
      apiKeys = [],
    isLoading:
      loading,
    isError:
      apiKeysError,
  } =
    useApiKeysQuery();

  const createMutation =
    useCreateApiKeyMutation();

  const createTeamLeaderMutation =
    useCreateAdminTeamLeaderMutation();

  const createAgentMutation =
    useCreateAdminAgentMutation();

  const deleteMutation =
    useDeleteApiKeyMutation();

  const revokeMutation =
    useRevokeApiKeyMutation();

  const reissueMutation =
    useReissueApiKeyMutation();

  /**
   * Plaintext API keys are intentionally kept only in React memory.
   *
   * The backend stores only a hash/prefix, so an existing plaintext key
   * cannot be recovered after a page reload. This map is populated only
   * by create/reissue responses received while this page is mounted.
   */
  const [
    knownApiKeys,
    setKnownApiKeys,
  ] =
    useState<Record<string, string>>(
      {},
    );

  const [
    copiedKeyId,
    setCopiedKeyId,
  ] =
    useState<string | null>(
      null,
    );

  const [
    visibleKeys,
    setVisibleKeys,
  ] =
    useState<
      Set<string>
    >(
      new Set(),
    );

  const [
    showModal,
    setShowModal,
  ] =
    useState(false);

  const [
    newKey,
    setNewKey,
  ] =
    useState<NewCredentialForm>(
      EMPTY_CREDENTIAL_FORM,
    );

  const [
    createdCredential,
    setCreatedCredential,
  ] =
    useState<CreatedCredential | null>(
      null,
    );


  const [
    createError,
    setCreateError,
  ] =
    useState<
      string | null
    >(
      null,
    );

  const [
    confirmAction,
    setConfirmAction,
  ] =
    useState<{
      type:
        | 'delete'
        | 'revoke'
        | 'reissue';
      id:
        string;
      name:
        string;
    } | null>(
      null,
    );

  /**
   * Team Leaders are only needed when the Admin chooses to create an
   * Agent. Do not make the management-principal request on every visit
   * to the API Keys page.
   */
  const teamLeadersQuery =
    useAdminTeamLeadersQuery(
      showModal &&
        !createdCredential &&
        newKey.role ===
          'agent',
    );

  const windowWidth =
    useWindowSize();

  const isMobile =
    windowWidth <
    768;

  const isSmall =
    windowWidth <
    640;

  const [
    columnVisibility,
    setColumnVisibility,
  ] =
    useState<ColumnVisibilityState>(
      {},
    );

  useEffect(() => {
    setColumnVisibility({
      key:
        !isSmall,
      lastUsed:
        !isMobile,
    });
  }, [
    isMobile,
    isSmall,
  ]);

  const roleLabel =
    (
      role:
        ApiKey['role'],
    ) =>
      t(
        `apiKeys.roles.${role}`,
        {
          defaultValue:
            roleFallbackLabels[
              role
            ],
        },
      );

  const roleDescription =
    (
      role:
        ApiKey['role'],
    ) =>
      t(
        `apiKeys.roleDescriptions.${role}`,
        {
          defaultValue:
            roleFallbackDescriptions[
              role
            ],
        },
      );

  const isCreating =
    createMutation.isPending ||
    createTeamLeaderMutation.isPending ||
    createAgentMutation.isPending;

  const canCreate =
    useMemo(() => {
      const name =
        newKey.name.trim();

      const email =
        newKey.email.trim();

      if (!name) {
        return false;
      }

      if (
        isGenericApiKeyRole(
          newKey.role,
        )
      ) {
        /**
         * Generic CreateApiKeyDto enforces MinLength(3).
         */
        return (
          name.length >=
          3
        );
      }

      if (
        newKey.role ===
        'team_leader'
      ) {
        return (
          !email ||
          isValidEmail(
            email,
          )
        );
      }

      return (
        Boolean(
          newKey.teamLeaderId,
        ) &&
        (!email ||
          isValidEmail(
            email,
          ))
      );
    }, [
      newKey,
    ]);

  const resetCreateModal =
    () => {
      setShowModal(
        false,
      );

      setCreatedCredential(
        null,
      );

      setNewKey(
        EMPTY_CREDENTIAL_FORM,
      );

      setCreateError(
        null,
      );

    };

  const openCreateModal =
    () => {
      setNewKey(
        EMPTY_CREDENTIAL_FORM,
      );

      setCreatedCredential(
        null,
      );

      setCreateError(
        null,
      );


      setShowModal(
        true,
      );
    };

  const handleCreate =
    async () => {
      const name =
        newKey.name.trim();

      const email =
        newKey.email.trim();

      if (!canCreate) {
        return;
      }

      setCreateError(
        null,
      );

      try {
        if (
          isGenericApiKeyRole(
            newKey.role,
          )
        ) {
          const created =
            await createMutation.mutateAsync(
              {
                name,
                role:
                  newKey.role,
              },
            );

          setKnownApiKeys(
            current => ({
              ...current,
              [created.id]:
                created.apiKey,
            }),
          );

          setCreatedCredential(
            {
              apiKey:
                created.apiKey,
              name:
                created.name,
              role:
                created.role,
              reason:
                'created',
            },
          );

          return;
        }

        if (
          newKey.role ===
          'team_leader'
        ) {
          const created =
            await createTeamLeaderMutation.mutateAsync(
              {
                name,
                ...(email
                  ? {
                      email,
                    }
                  : {}),
              },
            );

          setCreatedCredential(
            {
              apiKey:
                created.apiKey,
              name:
                created.teamLeader.name,
              role:
                'team_leader',
              reason:
                'created',
            },
          );

          return;
        }

        const created =
          await createAgentMutation.mutateAsync(
            {
              teamLeaderId:
                newKey.teamLeaderId,
              data: {
                name,
                ...(email
                  ? {
                      email,
                    }
                  : {}),
              },
            },
          );

        setCreatedCredential(
          {
            apiKey:
              created.apiKey,
            name:
              created.agent.name,
            role:
              'agent',
            reason:
              'created',
          },
        );
      } catch (
        error
      ) {
        const message =
          error instanceof
          Error
            ? error.message
            : t(
                'common.unknownError',
              );

        setCreateError(
          message,
        );

        toast.error(
          t(
            'apiKeys.createBtn',
          ),
          message,
        );
      }
    };

  const copyKnownApiKey =
    async (
      apiKey: ApiKey,
    ) => {
      const rawKey =
        knownApiKeys[apiKey.id];

      if (!rawKey) {
        toast.warning(
          t(
            'apiKeys.copyUnavailableTitle',
            {
              defaultValue:
                'Plaintext key unavailable',
            },
          ),
          t(
            'apiKeys.copyUnavailableDescription',
            {
              defaultValue:
                'This key was not created or reissued during the current page session. Reissue it to receive a new plaintext key.',
            },
          ),
        );

        return;
      }

      const copied =
        await copyToClipboard(
          rawKey,
        );

      if (!copied) {
        toast.error(
          t(
            'apiKeys.copyFailedTitle',
            {
              defaultValue:
                'Copy failed',
            },
          ),
          t(
            'apiKeys.copyFailedDescription',
            {
              defaultValue:
                'The API key could not be copied to the clipboard.',
            },
          ),
        );

        return;
      }

      setCopiedKeyId(
        apiKey.id,
      );

      window.setTimeout(
        () => {
          setCopiedKeyId(
            current =>
              current === apiKey.id
                ? null
                : current,
          );
        },
        1600,
      );
    };

  const handleReissue =
    async (
      id: string,
    ) => {
      try {
        const reissued =
          await reissueMutation.mutateAsync(
            id,
          );

        setKnownApiKeys(
          current => ({
            ...current,
            [reissued.id]:
              reissued.apiKey,
          }),
        );

        setCreatedCredential(
          {
            apiKey:
              reissued.apiKey,
            name:
              reissued.name,
            role:
              reissued.role,
            reason:
              'reissued',
          },
        );

        setShowModal(
          true,
        );

        toast.success(
          t(
            'apiKeys.reissueSuccessTitle',
            {
              defaultValue:
                'API key reissued',
            },
          ),
          t(
            'apiKeys.reissueSuccessDescription',
            {
              defaultValue:
                'The replacement plaintext key is available only in this page session. The previous key no longer authenticates.',
            },
          ),
        );
      } catch (
        error
      ) {
        toast.error(
          t(
            'apiKeys.actions.reissue',
            {
              defaultValue:
                'Reissue',
            },
          ),
          error instanceof Error
            ? error.message
            : t(
                'common.unknownError',
              ),
        );
      }
    };

  const handleRevoke =
    async (
      id:
        string,
    ) => {
      try {
        await revokeMutation.mutateAsync(
          id,
        );

        setKnownApiKeys(current => {
          const next = {
            ...current,
          };
          delete next[id];
          return next;
        });

        setVisibleKeys(previous => {
          const next =
            new Set(previous);
          next.delete(id);
          return next;
        });
      } catch (
        error
      ) {
        console.error(
          'Failed to revoke:',
          error,
        );

        toast.error(
          t(
            'apiKeys.actions.revoke',
          ),
          error instanceof
            Error
            ? error.message
            : t(
                'common.unknownError',
              ),
        );
      }
    };

  const handleDelete =
    async (
      id:
        string,
    ) => {
      try {
        await deleteMutation.mutateAsync(
          id,
        );

        setKnownApiKeys(current => {
          const next = {
            ...current,
          };
          delete next[id];
          return next;
        });

        setVisibleKeys(previous => {
          const next =
            new Set(previous);
          next.delete(id);
          return next;
        });
      } catch (
        error
      ) {
        console.error(
          'Failed to delete:',
          error,
        );

        toast.error(
          t(
            'apiKeys.actions.delete',
          ),
          error instanceof
            Error
            ? error.message
            : t(
                'common.unknownError',
              ),
        );
      }
    };

  const confirmAndExecute =
    () => {
      if (
        !confirmAction
      ) {
        return;
      }

      if (
        confirmAction.type ===
        'delete'
      ) {
        void handleDelete(
          confirmAction.id,
        );
      } else if (
        confirmAction.type ===
        'revoke'
      ) {
        void handleRevoke(
          confirmAction.id,
        );
      } else {
        void handleReissue(
          confirmAction.id,
        );
      }

      setConfirmAction(
        null,
      );
    };

  const toggleKeyVisibility =
    (
      id:
        string,
    ) => {
      setVisibleKeys(
        previous => {
          const next =
            new Set(
              previous,
            );

          if (
            next.has(
              id,
            )
          ) {
            next.delete(
              id,
            );
          } else {
            next.add(
              id,
            );
          }

          return next;
        },
      );
    };

  const columns =
    useMemo(
      () =>
        columnHelper.columns(
          [
            columnHelper.accessor(
              'name',
              {
                header:
                  () =>
                    t(
                      'apiKeys.columns.name',
                    ),

                cell:
                  info => {
                    const apiKey =
                      info.row.original;

                    return (
                      <span className="name-cell">
                        {credentialDisplayName(
                          apiKey,
                        )}

                        {isPrimaryAdminKey(
                          apiKey,
                        ) && (
                          <span
                            className="permission-badge"
                            title="Primary Admin API key"
                          >
                            Primary
                          </span>
                        )}
                      </span>
                    );
                  },
              },
            ),

            columnHelper.accessor(
              'keyPrefix',
              {
                id:
                  'key',

                header:
                  () =>
                    t(
                      'apiKeys.columns.key',
                    ),

                cell:
                  info => {
                    const apiKey =
                      info.row.original;

                    return (
                      <span className="key-cell">
                        <code>
                          {visibleKeys.has(
                            apiKey.id,
                          )
                            ? `${apiKey.keyPrefix}...`
                            : `${apiKey.keyPrefix}****`}
                        </code>

                        <button
                          className="icon-btn-sm"
                          onClick={() =>
                            toggleKeyVisibility(
                              apiKey.id,
                            )
                          }
                          aria-label={
                            visibleKeys.has(
                              apiKey.id,
                            )
                              ? t(
                                  'common.hideApiKey',
                                )
                              : t(
                                  'common.showApiKey',
                                )
                          }
                        >
                          {visibleKeys.has(
                            apiKey.id,
                          ) ? (
                            <EyeOff
                              size={14}
                            />
                          ) : (
                            <Eye
                              size={14}
                            />
                          )}
                        </button>
                      </span>
                    );
                  },
              },
            ),

            columnHelper.accessor(
              'role',
              {
                header:
                  () =>
                    t(
                      'apiKeys.columns.role',
                    ),

                cell:
                  info => (
                    <span className="permission-badge">
                      {roleLabel(
                        info.getValue(),
                      )}
                    </span>
                  ),
              },
            ),

            columnHelper.accessor(
              'isActive',
              {
                header:
                  () =>
                    t(
                      'apiKeys.columns.status',
                    ),

                cell:
                  info => (
                    <span
                      className={`status-badge ${
                        info.getValue()
                          ? 'active'
                          : 'inactive'
                      }`}
                    >
                      {info.getValue()
                        ? t(
                            'apiKeys.statuses.active',
                          )
                        : t(
                            'apiKeys.statuses.revoked',
                          )}
                    </span>
                  ),
              },
            ),

            columnHelper.accessor(
              'lastUsedAt',
              {
                id:
                  'lastUsed',

                header:
                  () =>
                    t(
                      'apiKeys.columns.lastUsed',
                    ),

                cell:
                  info => (
                    <span className="last-used">
                      {info.getValue()
                        ? new Date(
                            info.getValue()!,
                          ).toLocaleDateString()
                        : t(
                            'common.never',
                          )}
                    </span>
                  ),
              },
            ),

            columnHelper.display(
              {
                id:
                  'actions',

                header:
                  () =>
                    t(
                      'apiKeys.columns.actions',
                    ),

                cell:
                  info => {
                    const apiKey =
                      info.row.original;

                    const rawKey =
                      knownApiKeys[
                        apiKey.id
                      ];

                    const isReissuing =
                      reissueMutation.isPending &&
                      reissueMutation.variables ===
                        apiKey.id;

                    const isRevoking =
                      revokeMutation.isPending &&
                      revokeMutation.variables ===
                        apiKey.id;

                    const isDeleting =
                      deleteMutation.isPending &&
                      deleteMutation.variables ===
                        apiKey.id;

                    const displayName =
                      credentialDisplayName(
                        apiKey,
                      );

                    const deleteProtected =
                      isOperator &&
                      isPrimaryAdminKey(
                        apiKey,
                      );

                    return (
                      <span className="actions-cell">
                        <button
                          className="icon-btn"
                          onClick={() =>
                            void copyKnownApiKey(
                              apiKey,
                            )
                          }
                          disabled={
                            !rawKey
                          }
                          title={
                            rawKey
                              ? t(
                                  'apiKeys.actions.copy',
                                  {
                                    defaultValue:
                                      'Copy',
                                  },
                                )
                              : t(
                                  'apiKeys.copyUnavailableShort',
                                  {
                                    defaultValue:
                                      'Plaintext unavailable — reissue first',
                                  },
                                )
                          }
                          aria-label={
                            rawKey
                              ? `Copy API key for ${displayName}`
                              : `Plaintext API key for ${displayName} is unavailable`
                          }
                        >
                          {copiedKeyId ===
                          apiKey.id ? (
                            <Check
                              size={16}
                            />
                          ) : (
                            <Copy
                              size={16}
                            />
                          )}
                        </button>

                        <button
                          className="icon-btn"
                          onClick={() =>
                            setConfirmAction(
                              {
                                type:
                                  'reissue',
                                id:
                                  apiKey.id,
                                name:
                                  displayName,
                              },
                            )
                          }
                          disabled={
                            reissueMutation.isPending
                          }
                          title={t(
                            'apiKeys.actions.reissue',
                            {
                              defaultValue:
                                'Reissue',
                            },
                          )}
                          aria-label={`Reissue API key for ${displayName}`}
                        >
                          {isReissuing ? (
                            <Loader2
                              size={16}
                              className="animate-spin"
                            />
                          ) : (
                            <RefreshCw
                              size={16}
                            />
                          )}
                        </button>

                        {apiKey.isActive && (
                          <button
                            className="icon-btn"
                            onClick={() =>
                              setConfirmAction(
                                {
                                  type:
                                    'revoke',
                                  id:
                                    apiKey.id,
                                  name:
                                    displayName,
                                },
                              )
                            }
                            disabled={
                              revokeMutation.isPending ||
                              deleteMutation.isPending ||
                              reissueMutation.isPending
                            }
                            title={t(
                              'apiKeys.actions.revoke',
                            )}
                            aria-label={`Revoke API key for ${displayName}`}
                          >
                            {isRevoking ? (
                              <Loader2
                                size={16}
                                className="animate-spin"
                              />
                            ) : (
                              <KeyRound
                                size={16}
                              />
                            )}
                          </button>
                        )}

                        <button
                          className="icon-btn danger"
                          onClick={() =>
                            setConfirmAction(
                              {
                                type:
                                  'delete',
                                id:
                                  apiKey.id,
                                name:
                                  displayName,
                              },
                            )
                          }
                          disabled={
                            deleteProtected ||
                            deleteMutation.isPending ||
                            revokeMutation.isPending ||
                            reissueMutation.isPending
                          }
                          title={
                            deleteProtected
                              ? 'Operators cannot delete the primary Admin API key.'
                              : t(
                                  'apiKeys.actions.delete',
                                )
                          }
                          aria-label={
                            deleteProtected
                              ? `Primary Admin API key ${displayName} cannot be deleted by an Operator`
                              : `Delete API key for ${displayName}`
                          }
                        >
                          {isDeleting ? (
                            <Loader2
                              size={16}
                              className="animate-spin"
                            />
                          ) : (
                            <Trash2
                              size={16}
                            />
                          )}
                        </button>
                      </span>
                    );
                  },
              },
            ),
          ],
        ),
      [
        copiedKeyId,
        deleteMutation.isPending,
        deleteMutation.variables,
        isOperator,
        knownApiKeys,
        reissueMutation.isPending,
        reissueMutation.variables,
        revokeMutation.isPending,
        revokeMutation.variables,
        roleLabel,
        t,
        visibleKeys,
      ],
    );

  const table =
    useTable({
      features,
      data:
        apiKeys,
      columns,
      state: {
        columnVisibility,
      },
      onColumnVisibilityChange:
        setColumnVisibility,
    });

  if (loading) {
    return (
      <div
        className="api-keys-page"
        style={{
          display:
            'flex',
          alignItems:
            'center',
          justifyContent:
            'center',
          minHeight:
            '400px',
        }}
      >
        <Loader2
          className="animate-spin"
          size={32}
        />
      </div>
    );
  }

  return (
    <div className="api-keys-page">
      <PageHeader
        title={t(
          'apiKeys.title',
        )}
        subtitle={t(
          'apiKeys.subtitle',
        )}
        actions={
          <button
            className="btn-primary"
            onClick={
              openCreateModal
            }
          >
            <Plus
              size={18}
            />

            {t(
              'apiKeys.createBtn',
            )}
          </button>
        }
      />

      {apiKeysError && (
        <div
          className="error-banner"
          role="alert"
        >
          <AlertCircle
            size={20}
          />

          <span className="error-banner-text">
            {t(
              'dashboard.loadError',
            )}
          </span>
        </div>
      )}

      {showModal && (
        <Modal
          open
          onClose={
            resetCreateModal
          }
          title={
            createdCredential
              ? createdCredential.reason ===
                'reissued'
                ? t(
                    'apiKeys.reissuedTitle',
                    {
                      defaultValue:
                        'API Key Reissued',
                    },
                  )
                : t(
                    'apiKeys.createdTitle',
                  )
              : t(
                  'apiKeys.modalTitle',
                )
          }
          closeLabel={t(
            'common.close',
          )}
          hideCloseButton={
            isCreating
          }
          footer={
            !createdCredential ? (
              <>
                <button
                  className="btn-secondary"
                  onClick={
                    resetCreateModal
                  }
                  disabled={
                    isCreating
                  }
                >
                  {t(
                    'common.cancel',
                  )}
                </button>

                <button
                  className="btn-primary"
                  onClick={() =>
                    void handleCreate()
                  }
                  disabled={
                    isCreating ||
                    !canCreate
                  }
                >
                  {isCreating ? (
                    <Loader2
                      className="animate-spin"
                      size={16}
                    />
                  ) : (
                    t(
                      'common.create',
                    )
                  )}
                </button>
              </>
            ) : undefined
          }
        >
          {createdCredential ? (
            <div>
              <p
                style={{
                  marginBottom:
                    '1rem',
                  color:
                    'var(--text-muted)',
                }}
              >
                {createdCredential.reason ===
                'reissued'
                  ? t(
                      'apiKeys.reissuedHint',
                      {
                        defaultValue:
                          'The previous key is no longer valid. Copy the replacement key now; the plaintext will not be recoverable after this page session.',
                      },
                    )
                  : t(
                      'apiKeys.createdHint',
                    )}
              </p>

              <p
                style={{
                  marginBottom:
                    '1rem',
                  color:
                    'var(--text-secondary)',
                }}
              >
                <strong>
                  {
                    createdCredential.name
                  }
                </strong>{' '}
                ·{' '}
                {roleLabel(
                  createdCredential.role,
                )}
              </p>

              <GeneratedKeyField
                value={
                  createdCredential.apiKey
                }
                label={`${roleLabel(
                  createdCredential.role,
                )} API key`}
                description={
                  createdCredential.reason ===
                  'reissued'
                    ? 'This replacement plaintext key is returned only once. The previous key is invalid; copy and store this key now.'
                    : 'This plaintext key is returned only once. It is hidden by default; Copy always copies the complete key.'
                }
              />
            </div>
          ) : (
            <>
              <label htmlFor="ak-role">
                {t(
                  'common.role',
                )}
              </label>

              <select
                id="ak-role"
                value={
                  newKey.role
                }
                disabled={
                  isCreating
                }
                onChange={
                  event => {
                    const role =
                      event.target.value as
                        ApiKey['role'];

                    setNewKey(
                      current => ({
                        ...current,
                        role,
                        email:
                          '',
                        teamLeaderId:
                          '',
                      }),
                    );

                    setCreateError(
                      null,
                    );
                  }
                }
              >
                {credentialRoleNames.map(
                  role => (
                    <option
                      key={
                        role
                      }
                      value={
                        role
                      }
                    >
                      {roleLabel(
                        role,
                      )}
                    </option>
                  ),
                )}
              </select>

              <label htmlFor="ak-name">
                {newKey.role ===
                'team_leader'
                  ? 'Team Leader name'
                  : newKey.role ===
                      'agent'
                    ? 'Agent name'
                    : t(
                        'common.name',
                      )}
              </label>

              <input
                id="ak-name"
                type="text"
                maxLength={
                  100
                }
                placeholder={
                  isManagementRole(
                    newKey.role,
                  )
                    ? newKey.role ===
                      'team_leader'
                      ? 'Ahmed Hassan'
                      : 'Mohamed Ali'
                    : t(
                        'apiKeys.namePlaceholder',
                      )
                }
                value={
                  newKey.name
                }
                disabled={
                  isCreating
                }
                onChange={
                  event =>
                    setNewKey(
                      current => ({
                        ...current,
                        name:
                          event.target.value,
                      }),
                    )
                }
              />

              {newKey.role ===
                'team_leader' && (
                <>
                  <label htmlFor="ak-email">
                    Team Leader email
                  </label>

                  <input
                    id="ak-email"
                    type="email"
                    maxLength={
                      255
                    }
                    placeholder="ahmed.hassan@example.com"
                    value={
                      newKey.email
                    }
                    disabled={
                      isCreating
                    }
                    onChange={
                      event =>
                        setNewKey(
                          current => ({
                            ...current,
                            email:
                              event.target.value,
                          }),
                        )
                    }
                  />

                  <small
                    style={{
                      display:
                        'block',
                      marginTop:
                        '-0.25rem',
                      color:
                        'var(--text-muted)',
                    }}
                  >
                    Optional
                  </small>
                </>
              )}

              {newKey.role ===
                'agent' && (
                <>
                  <label htmlFor="ak-team-leader">
                    Team Leader
                  </label>

                  <select
                    id="ak-team-leader"
                    value={
                      newKey.teamLeaderId
                    }
                    disabled={
                      isCreating ||
                      teamLeadersQuery.isLoading
                    }
                    onChange={
                      event =>
                        setNewKey(
                          current => ({
                            ...current,
                            teamLeaderId:
                              event.target.value,
                          }),
                        )
                    }
                  >
                    <option value="">
                      {teamLeadersQuery.isLoading
                        ? 'Loading Team Leaders...'
                        : 'Select a Team Leader'}
                    </option>

                    {(teamLeadersQuery.data ??
                      []).map(
                      teamLeader => (
                        <option
                          key={
                            teamLeader.id
                          }
                          value={
                            teamLeader.id
                          }
                        >
                          {
                            teamLeader.name
                          }{' '}
                          ·{' '}
                          {teamLeader.email ||
                            'No email'}
                        </option>
                      ),
                    )}
                  </select>

                  <label htmlFor="ak-agent-email">
                    Agent email
                  </label>

                  <input
                    id="ak-agent-email"
                    type="email"
                    maxLength={
                      255
                    }
                    placeholder="mohamed.ali@example.com"
                    value={
                      newKey.email
                    }
                    disabled={
                      isCreating
                    }
                    onChange={
                      event =>
                        setNewKey(
                          current => ({
                            ...current,
                            email:
                              event.target.value,
                          }),
                        )
                    }
                  />

                  <small
                    style={{
                      display:
                        'block',
                      marginTop:
                        '-0.25rem',
                      color:
                        'var(--text-muted)',
                    }}
                  >
                    Optional
                  </small>

                  {teamLeadersQuery.isError && (
                    <div
                      className="error-banner"
                      role="alert"
                    >
                      <AlertCircle
                        size={18}
                      />

                      <span className="error-banner-text">
                        Failed to load Team Leaders.
                      </span>
                    </div>
                  )}

                  {!teamLeadersQuery.isLoading &&
                    !teamLeadersQuery.isError &&
                    (teamLeadersQuery.data ??
                      []).length ===
                      0 && (
                      <div
                        className="error-banner"
                        role="status"
                      >
                        <AlertCircle
                          size={18}
                        />

                        <span className="error-banner-text">
                          Create a Team Leader before creating an Agent.
                        </span>
                      </div>
                    )}
                </>
              )}

              {isGenericApiKeyRole(
                newKey.role,
              ) && (
                <p
                  style={{
                    margin:
                      '0.75rem 0 0',
                    color:
                      'var(--text-muted)',
                    fontSize:
                      '0.8rem',
                  }}
                >
                  This role is created through the generic API-key endpoint.
                </p>
              )}

              {isManagementRole(
                newKey.role,
              ) && (
                <p
                  style={{
                    margin:
                      '0.75rem 0 0',
                    color:
                      'var(--text-muted)',
                    fontSize:
                      '0.8rem',
                  }}
                >
                  This credential is created atomically with its principal record and is not minted through generic API-key creation.
                </p>
              )}

              {createError && (
                <div
                  className="error-banner"
                  role="alert"
                >
                  <AlertCircle
                    size={18}
                  />

                  <span className="error-banner-text">
                    {
                      createError
                    }
                  </span>
                </div>
              )}
            </>
          )}
        </Modal>
      )}

      <div className="api-keys-content">
        <div className="keys-table-container">
          {apiKeys.length ===
          0 ? (
            <div className="empty-table-state">
              <KeyRound
                size={48}
                strokeWidth={
                  1
                }
              />

              <h3>
                {t(
                  'apiKeys.empty.title',
                )}
              </h3>

              <p>
                {t(
                  'apiKeys.empty.description',
                )}
              </p>
            </div>
          ) : (
            <table className="keys-table">
              <thead>
                {table
                  .getHeaderGroups()
                  .map(
                    headerGroup => (
                      <tr
                        key={
                          headerGroup.id
                        }
                        className="table-row header"
                      >
                        {headerGroup.headers.map(
                          header => (
                            <th
                              key={
                                header.id
                              }
                            >
                              {header.isPlaceholder
                                ? null
                                : flexRender(
                                    header.column.columnDef.header,
                                    header.getContext(),
                                  )}
                            </th>
                          ),
                        )}
                      </tr>
                    ),
                  )}
              </thead>

              <tbody>
                {table
                  .getRowModel()
                  .rows.map(
                    row => (
                      <tr
                        key={
                          row.id
                        }
                        className="table-row"
                      >
                        {row
                          .getVisibleCells()
                          .map(
                            cell => (
                              <td
                                key={
                                  cell.id
                                }
                              >
                                {flexRender(
                                  cell.column.columnDef.cell,
                                  cell.getContext(),
                                )}
                              </td>
                            ),
                          )}
                      </tr>
                    ),
                  )}
              </tbody>
            </table>
          )}
        </div>

        <div className="permissions-reference">
          <h3>
            {t(
              'apiKeys.rolesTitle',
            )}
          </h3>

          <div className="permissions-list">
            {credentialRoleNames.map(
              role => (
                <div
                  key={
                    role
                  }
                  className="perm-item"
                >
                  <code>
                    {
                      role
                    }
                  </code>

                  <span>
                    {roleDescription(
                      role,
                    )}
                  </span>
                </div>
              ),
            )}
          </div>
        </div>
      </div>

      {confirmAction && (
        <Modal
          open
          onClose={() =>
            setConfirmAction(
              null,
            )
          }
          title={
            confirmAction.type ===
            'delete'
              ? t(
                  'apiKeys.confirm.deleteTitle',
                )
              : confirmAction.type ===
                  'revoke'
                ? t(
                    'apiKeys.confirm.revokeTitle',
                  )
                : t(
                    'apiKeys.confirm.reissueTitle',
                    {
                      defaultValue:
                        'Reissue API key',
                    },
                  )
          }
          className="confirm-modal"
          closeLabel={t(
            'common.close',
          )}
          footer={
            <>
              <button
                className="btn-secondary"
                onClick={() =>
                  setConfirmAction(
                    null,
                  )
                }
              >
                {t(
                  'common.cancel',
                )}
              </button>

              <button
                className={
                  confirmAction.type ===
                  'reissue'
                    ? 'btn-primary'
                    : 'btn-danger'
                }
                onClick={
                  confirmAndExecute
                }
                disabled={
                  reissueMutation.isPending ||
                  revokeMutation.isPending ||
                  deleteMutation.isPending
                }
              >
                {confirmAction.type ===
                'delete'
                  ? t(
                      'apiKeys.confirm.delete',
                    )
                  : confirmAction.type ===
                      'revoke'
                    ? t(
                        'apiKeys.confirm.revoke',
                      )
                    : t(
                        'apiKeys.actions.reissue',
                        {
                          defaultValue:
                            'Reissue',
                        },
                      )}
              </button>
            </>
          }
        >
          <div className="confirm-icon-wrapper">
            <AlertTriangle
              size={48}
              className="confirm-warning-icon"
            />
          </div>

          <p className="confirm-message">
            {confirmAction.type ===
            'reissue' ? (
              <>
                Reissue the API key for{' '}
                <strong>
                  {
                    confirmAction.name
                  }
                </strong>
                ? The previous plaintext key will stop authenticating immediately.
              </>
            ) : (
              <Trans
                i18nKey={
                  confirmAction.type ===
                  'delete'
                    ? 'apiKeys.confirm.deleteMessage'
                    : 'apiKeys.confirm.revokeMessage'
                }
                values={{
                  name:
                    confirmAction.name,
                }}
                components={{
                  strong:
                    <strong />,
                }}
              />
            )}
          </p>
        </Modal>
      )}
    </div>
  );
}





