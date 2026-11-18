


import {
  Eye,
  Play,
  RefreshCw,
  Skull,
  Square,
  Trash2,
  Unlink,
  QrCode,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type {
  AccountRestriction,
  Session,
} from '../services/api';
import {
  canForceKillSession,
  canUnlinkSession,
  isSessionStarted,
} from '../utils/sessionActions';

import './SessionCard.css';

interface SessionCardProps {
  session: Session;

  /**
   * Fine-grained frontend capability flags.
   *
   * These mirror the backend distinction between:
   * - SESSION_START
   * - SESSION_SHUTDOWN
   * - SESSION_MANAGE
   *
   * Backend authorization remains authoritative.
   */
  canStartSessions: boolean;
  canShutdownSessions: boolean;
  canManageSessions: boolean;

  onView: (session: Session) => void;
  onStart: (session: Session) => void;
  onStop: (session: Session) => void;
  onUnlink: (session: Session) => void;
  onDelete: (session: Session) => void;
  onForceKill: (session: Session) => void;
  onShowQR: (session: Session) => void;

  /**
   * Optional restriction formatter.
   * Kept injectable because the Sessions page currently
   * owns the translation/formatting logic for restrictions.
   */
  restrictionTitle?: (
    restriction: AccountRestriction,
    session: Session,
  ) => string;
}

export function SessionCard({
  session,
  canStartSessions,
  canShutdownSessions,
  canManageSessions,
  onView,
  onStart,
  onStop,
  onUnlink,
  onDelete,
  onForceKill,
  onShowQR,
  restrictionTitle,
}: SessionCardProps) {
  const { t } = useTranslation();

  const formatStatus = (status: string) =>
    t(`sessionStatus.${status}`, {
      defaultValue: status,
    });

  const formatLastActive = (
    date?: string | null,
  ) => {
    if (!date) {
      return t('common.never');
    }

    const parsed = new Date(date);
    const timestamp = parsed.getTime();

    if (Number.isNaN(timestamp)) {
      return t('common.never');
    }

    const diff =
      Date.now() -
      timestamp;

    if (diff < 60000) {
      return t('common.justNow');
    }

    if (diff < 3600000) {
      return t('common.minAgo', {
        count:
          Math.floor(
            diff / 60000,
          ),
      });
    }

    return parsed.toLocaleDateString();
  };

  const isQrState =
    session.status ===
      'initializing' ||
    session.status ===
      'qr_ready';

  /**
   * `engineLoaded` is authoritative when present.
   *
   * Do not infer running/stopped state only from `status`: a
   * `disconnected` session can still own a live engine while it is in
   * reconnect backoff.
   */
  const started =
    isSessionStarted(
      session,
    );

  const unlinkAllowed =
    canUnlinkSession(
      session,
      canShutdownSessions,
    );

  const forceKillAllowed =
    canForceKillSession(
      session,
      canShutdownSessions,
    );

  const canStart =
    canStartSessions &&
    !started;

  const startActionIsInitial =
    session.status ===
      'created' ||
    session.status ===
      'disconnected';

  return (
    <div className="session-card">
      {/* =====================================================
          HEADER
         ===================================================== */}
      <div className="card-header">
        <h3
          title={
            session.name
          }
        >
          {session.name}
        </h3>

        <span
          className={`status-pill ${session.status}`}
        >
          {formatStatus(
            session.status,
          )}
        </span>
      </div>

      {/* =====================================================
          QR / PAIRING STATE
         ===================================================== */}
      {isQrState ? (
        <div className="qr-placeholder">
          <QrCode
            size={80}
            className="qr-icon"
          />

          <p>
            {session.status ===
            'qr_ready'
              ? t(
                  'sessions.qr.scanToConnect',
                )
              : t(
                  'sessions.qr.preparing',
                )}
          </p>

          {canManageSessions && (
            <button
              type="button"
              className="btn-sm"
              onClick={() =>
                onShowQR(
                  session,
                )
              }
              disabled={
                session.status !==
                'qr_ready'
              }
            >
              {session.status ===
              'qr_ready'
                ? t(
                    'sessions.qr.showQr',
                  )
                : t(
                    'sessions.qr.loading',
                  )}
            </button>
          )}
        </div>
      ) : (
        /* ===================================================
           SESSION INFORMATION
           =================================================== */
        <div className="session-info">
          <div className="info-row">
            <span className="info-label">
              {t(
                'sessions.card.phone',
              )}
            </span>

            <span className="info-value">
              {session.phone ||
                '—'}
            </span>
          </div>

          <div className="info-row">
            <span className="info-label">
              {t(
                'sessions.card.sessionId',
              )}
            </span>

            <span className="info-value mono">
              {session.id.substring(
                0,
                12,
              )}
            </span>
          </div>

          <div className="info-row">
            <span className="info-label">
              {t(
                'sessions.card.lastActive',
              )}
            </span>

            <span className="info-value">
              {formatLastActive(
                session.lastActive,
              )}
            </span>
          </div>

          {(
            session.status ===
              'failed' ||
            session.status ===
              'action_required'
          ) &&
            session.lastError && (
              <div className="info-row session-error">
                <span className="info-label">
                  {t(
                    'sessions.card.error',
                  )}
                </span>

                <span
                  className="info-value error-text"
                  title={
                    session.lastError
                  }
                >
                  {
                    session.lastError
                  }
                </span>
              </div>
            )}

          {session.restriction && (
            <div className="info-row session-restriction">
              <span className="info-label">
                {t(
                  'sessions.card.restriction',
                )}
              </span>

              <span
                className="info-value restriction-text"
                title={
                  restrictionTitle
                    ? restrictionTitle(
                        session.restriction,
                        session,
                      )
                    : session.restriction
                        .code
                }
              >
                {t(
                  `sessions.restriction.${session.restriction.kind}`,
                )}
              </span>
            </div>
          )}
        </div>
      )}

      {/* =====================================================
          ACTIONS
         ===================================================== */}
      <div className="card-actions">
        <button
          type="button"
          className="btn-action"
          onClick={() =>
            onView(
              session,
            )
          }
        >
          <Eye
            size={16}
          />

          {t(
            'sessions.actions.view',
          )}
        </button>

        {canShutdownSessions &&
        started ? (
          <button
            type="button"
            className="btn-action"
            onClick={() =>
              onStop(
                session,
              )
            }
          >
            <Square
              size={16}
            />

            {t(
              'sessions.actions.stop',
            )}
          </button>
        ) : canStart ? (
          <button
            type="button"
            className="btn-action"
            onClick={() =>
              onStart(
                session,
              )
            }
          >
            {startActionIsInitial ? (
              <Play
                size={16}
              />
            ) : (
              <RefreshCw
                size={16}
              />
            )}

            {startActionIsInitial
              ? t(
                  'sessions.actions.start',
                )
              : t(
                  'sessions.actions.reconnect',
                )}
          </button>
        ) : null}

        {unlinkAllowed && (
          <button
            type="button"
            className="btn-action danger"
            onClick={() =>
              onUnlink(
                session,
              )
            }
          >
            <Unlink
              size={16}
            />

            {t(
              'sessions.actions.unlink',
            )}
          </button>
        )}

        {canManageSessions && (
          <button
            type="button"
            className="btn-action danger"
            onClick={() =>
              onDelete(
                session,
              )
            }
          >
            <Trash2
              size={16}
            />

            {t(
              'sessions.actions.delete',
            )}
          </button>
        )}

        {forceKillAllowed && (
          <button
            type="button"
            className="btn-action danger"
            onClick={() =>
              onForceKill(
                session,
              )
            }
          >
            <Skull
              size={16}
            />

            {t(
              'sessions.actions.killStuck',
            )}
          </button>
        )}
      </div>
    </div>
  );
}


