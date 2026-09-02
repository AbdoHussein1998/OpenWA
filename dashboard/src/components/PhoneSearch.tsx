import { FormEvent, useCallback, useState } from 'react';
import { Search, Phone } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import './PhoneSearch.css';

interface PhoneSearchProps {
  onSearch: (phoneNumber: string) => void | Promise<void>;
  initialValue?: string;
  disabled?: boolean;
  placeholder?: string;
}

const E164_REGEX = /^\+[1-9]\d{1,14}$/;

export function PhoneSearch({
  onSearch,
  initialValue = '',
  disabled = false,
  placeholder,
}: PhoneSearchProps) {
  const { t } = useTranslation();

  const [phone, setPhone] = useState(initialValue);
  const [validationError, setValidationError] = useState('');

  const validatePhone = useCallback(
    (value: string): boolean => {
      const trimmed = value.trim();

      if (!trimmed) {
        setValidationError(
          t('phoneSearch.required', 'Phone number is required')
        );
        return false;
      }

      if (!E164_REGEX.test(trimmed)) {
        setValidationError(
          t(
            'phoneSearch.invalid',
            'Enter a valid phone number in E.164 format (e.g. +12345678900)'
          )
        );
        return false;
      }

      setValidationError('');
      return true;
    },
    [t]
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      if (disabled) {
        return;
      }

      const trimmed = phone.trim();

      if (!validatePhone(trimmed)) {
        return;
      }

      await onSearch(trimmed);
    },
    [disabled, phone, validatePhone, onSearch]
  );

  const handleChange = useCallback(
    (value: string) => {
      setPhone(value);

      if (validationError) {
        setValidationError('');
      }
    },
    [validationError]
  );

  return (
    <form onSubmit={handleSubmit} className="phone-search">
      <div
        className={`phone-search-wrapper ${
          validationError ? 'has-error' : ''
        }`}
      >
        <Phone
          size={20}
          className="phone-search-icon"
          aria-hidden="true"
        />

        <input
          type="tel"
          value={phone}
          onChange={(event) => handleChange(event.target.value)}
          placeholder={
            placeholder ??
            t('phoneSearch.placeholder', '+20 100 123 4567')
          }
          disabled={disabled}
          aria-label={t('phoneSearch.label', 'Phone number')}
          aria-invalid={Boolean(validationError)}
          aria-describedby={
            validationError ? 'phone-search-error' : undefined
          }
          autoComplete="tel"
        />

        <button
          type="submit"
          disabled={disabled || !phone.trim()}
          className="phone-search-button"
        >
          {disabled ? (
            <span
              className="phone-search-spinner"
              aria-hidden="true"
            />
          ) : (
            <>
              <Search size={18} aria-hidden="true" />
              {t('phoneSearch.search', 'Search')}
            </>
          )}
        </button>
      </div>

      {validationError && (
        <span
          id="phone-search-error"
          className="phone-search-error"
          role="alert"
        >
          {validationError}
        </span>
      )}

      <p className="phone-search-hint">
        {t(
          'phoneSearch.hint',
          'Enter the phone number in E.164 format (e.g. +12345678900)'
        )}
      </p>
    </form>
  );
}