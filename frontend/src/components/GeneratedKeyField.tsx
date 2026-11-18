import {
  useState,
} from 'react';

import {
  Check,
  Copy,
  Eye,
  EyeOff,
} from 'lucide-react';

import {
  copyToClipboard,
} from '../utils/clipboard';

interface GeneratedKeyFieldProps {
  value: string;
  label?: string;
  description?: string;
}

/**
 * Displays a plaintext credential returned once by the API.
 *
 * The value is masked by default, but Copy always uses the original
 * plaintext value rather than the rendered/masked representation.
 */
export function GeneratedKeyField({
  value,
  label = 'API key',
  description,
}: GeneratedKeyFieldProps) {
  const [
    visible,
    setVisible,
  ] =
    useState(false);

  const [
    copied,
    setCopied,
  ] =
    useState(false);

  const handleCopy =
    async () => {
      if (
        !await copyToClipboard(
          value,
        )
      ) {
        return;
      }

      setCopied(
        true,
      );

      window.setTimeout(
        () =>
          setCopied(
            false,
          ),
        2000,
      );
    };

  return (
    <div>
      <div
        style={{
          display:
            'flex',
          flexDirection:
            'column',
          gap:
            '0.25rem',
          marginBottom:
            '0.5rem',
        }}
      >
        <strong>
          {label}
        </strong>

        {description && (
          <span
            style={{
              color:
                'var(--text-muted)',
              fontSize:
                '0.85rem',
            }}
          >
            {description}
          </span>
        )}
      </div>

      <div
        style={{
          display:
            'flex',
          gap:
            '0.5rem',
          alignItems:
            'center',
        }}
      >
        <input
          type={
            visible
              ? 'text'
              : 'password'
          }
          readOnly
          value={
            value
          }
          autoComplete="off"
          spellCheck={
            false
          }
          aria-label={
            label
          }
          style={{
            flex:
              1,
            minWidth:
              0,
            fontFamily:
              'monospace',
          }}
        />

        <button
          type="button"
          className="btn-secondary"
          onClick={() =>
            setVisible(
              current =>
                !current,
            )
          }
          aria-label={
            visible
              ? `Hide ${label}`
              : `Show ${label}`
          }
          title={
            visible
              ? `Hide ${label}`
              : `Show ${label}`
          }
        >
          {visible ? (
            <EyeOff
              size={17}
            />
          ) : (
            <Eye
              size={17}
            />
          )}
        </button>

        <button
          type="button"
          className="btn-secondary"
          onClick={() =>
            void handleCopy()
          }
          aria-label={`Copy ${label}`}
          title={`Copy ${label}`}
        >
          {copied ? (
            <Check
              size={17}
            />
          ) : (
            <Copy
              size={17}
            />
          )}

          <span
            aria-live="polite"
          >
            {copied
              ? 'Copied'
              : 'Copy'}
          </span>
        </button>
      </div>
    </div>
  );
}
