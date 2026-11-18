import {
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useTranslation } from 'react-i18next';

import {
  sessionApi,
  type CreateSessionInput,
  type Session,
} from '../services/api';
import { useToast } from './useToast';

export interface UseSessionCreateFormArgs {
  onCreated: (session: Session) => void;
  onFailed: (message: string) => void;
}

export interface SessionCreateForm {
  showCreateModal: boolean;
  setShowCreateModal: (open: boolean) => void;
  createInput: CreateSessionInput;
  setCreateInput: Dispatch<SetStateAction<CreateSessionInput>>;
  creating: boolean;
  handleCreate: () => Promise<void>;
}

const createEmptyInput = (): CreateSessionInput => ({
  name: '',
  targetPhone: '',
  config: {
    autoRejectCalls: false,
  },
  proxyUrl: '',
  proxyType: 'http',
});

function normalizeCreateInput(
  input: CreateSessionInput,
): CreateSessionInput {
  const name = input.name.trim();
  const targetPhone = input.targetPhone?.trim() ?? '';
  const proxyUrl = input.proxyUrl?.trim() ?? '';

  const configEntries = Object.entries(
    input.config ?? {},
  ).filter(([, value]) => value !== undefined);

  const config =
    configEntries.length > 0
      ? Object.fromEntries(configEntries)
      : undefined;

  return {
    name,
    ...(targetPhone
      ? { targetPhone }
      : {}),
    ...(config
      ? { config }
      : {}),
    ...(proxyUrl
      ? {
          proxyUrl,
          ...(input.proxyType
            ? { proxyType: input.proxyType }
            : {}),
        }
      : {}),
  };
}

/**
 * Owns the New Session modal state and submits the complete
 * CreateSessionInput accepted by the dashboard API layer.
 *
 * Pairing remains a separate operation. Creating a Session does not
 * automatically start it or open the QR/pairing modal.
 */
export function useSessionCreateForm({
  onCreated,
  onFailed,
}: UseSessionCreateFormArgs): SessionCreateForm {
  const { t } = useTranslation();
  const toast = useToast();

  const [showCreateModalState, setShowCreateModalState] =
    useState(false);
  const [createInput, setCreateInput] =
    useState<CreateSessionInput>(createEmptyInput);
  const [creating, setCreating] = useState(false);

  const setShowCreateModal = useCallback(
    (open: boolean) => {
      setShowCreateModalState(open);

      if (!open && !creating) {
        setCreateInput(createEmptyInput());
      }
    },
    [creating],
  );

  const handleCreate = useCallback(async () => {
    const input = normalizeCreateInput(createInput);

    if (!input.name) {
      return;
    }

    try {
      setCreating(true);

      const newSession =
        await sessionApi.create(input);

      setCreateInput(createEmptyInput());
      setShowCreateModalState(false);

      toast.success(
        t('sessions.create.successTitle'),
        t('sessions.create.successDesc', {
          name: newSession.name,
        }),
      );

      onCreated(newSession);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('sessions.create.errorDefault');

      toast.error(
        t('sessions.create.errorTitle'),
        message,
      );

      onFailed(message);
    } finally {
      setCreating(false);
    }
  }, [createInput, onCreated, onFailed, t, toast]);

  return {
    showCreateModal: showCreateModalState,
    setShowCreateModal,
    createInput,
    setCreateInput,
    creating,
    handleCreate,
  };
}
