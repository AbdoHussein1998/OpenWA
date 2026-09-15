import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEventHandler,
} from 'react';

import './CountryPhoneInput.css';

interface PhoneCountry {
  code: string;
  name: string;
  dialCode: string;
  flag: string;
  preserveLeadingZero?: boolean;
}

/**
 * Kept local to the dashboard so the phone fields do not gain a runtime
 * dependency on a third-party phone-input package.
 *
 * dialCode contains digits only because the API already expects the normalized
 * international number as digits for pairing flows. The UI adds the leading +.
 */
const PHONE_COUNTRIES: readonly PhoneCountry[] = [
  { code: 'AF', name: 'Afghanistan', dialCode: '93', flag: '🇦🇫' },
  { code: 'AL', name: 'Albania', dialCode: '355', flag: '🇦🇱' },
  { code: 'DZ', name: 'Algeria', dialCode: '213', flag: '🇩🇿' },
  { code: 'AD', name: 'Andorra', dialCode: '376', flag: '🇦🇩' },
  { code: 'AO', name: 'Angola', dialCode: '244', flag: '🇦🇴' },
  { code: 'AR', name: 'Argentina', dialCode: '54', flag: '🇦🇷' },
  { code: 'AM', name: 'Armenia', dialCode: '374', flag: '🇦🇲' },
  { code: 'AU', name: 'Australia', dialCode: '61', flag: '🇦🇺' },
  { code: 'AT', name: 'Austria', dialCode: '43', flag: '🇦🇹' },
  { code: 'AZ', name: 'Azerbaijan', dialCode: '994', flag: '🇦🇿' },
  { code: 'BS', name: 'Bahamas', dialCode: '1242', flag: '🇧🇸' },
  { code: 'BH', name: 'Bahrain', dialCode: '973', flag: '🇧🇭' },
  { code: 'BD', name: 'Bangladesh', dialCode: '880', flag: '🇧🇩' },
  { code: 'BB', name: 'Barbados', dialCode: '1246', flag: '🇧🇧' },
  { code: 'BY', name: 'Belarus', dialCode: '375', flag: '🇧🇾' },
  { code: 'BE', name: 'Belgium', dialCode: '32', flag: '🇧🇪' },
  { code: 'BZ', name: 'Belize', dialCode: '501', flag: '🇧🇿' },
  { code: 'BJ', name: 'Benin', dialCode: '229', flag: '🇧🇯' },
  { code: 'BT', name: 'Bhutan', dialCode: '975', flag: '🇧🇹' },
  { code: 'BO', name: 'Bolivia', dialCode: '591', flag: '🇧🇴' },
  { code: 'BA', name: 'Bosnia and Herzegovina', dialCode: '387', flag: '🇧🇦' },
  { code: 'BW', name: 'Botswana', dialCode: '267', flag: '🇧🇼' },
  { code: 'BR', name: 'Brazil', dialCode: '55', flag: '🇧🇷' },
  { code: 'BN', name: 'Brunei', dialCode: '673', flag: '🇧🇳' },
  { code: 'BG', name: 'Bulgaria', dialCode: '359', flag: '🇧🇬' },
  { code: 'BF', name: 'Burkina Faso', dialCode: '226', flag: '🇧🇫' },
  { code: 'BI', name: 'Burundi', dialCode: '257', flag: '🇧🇮' },
  { code: 'KH', name: 'Cambodia', dialCode: '855', flag: '🇰🇭' },
  { code: 'CM', name: 'Cameroon', dialCode: '237', flag: '🇨🇲' },
  { code: 'CA', name: 'Canada', dialCode: '1', flag: '🇨🇦' },
  { code: 'CV', name: 'Cape Verde', dialCode: '238', flag: '🇨🇻' },
  { code: 'CF', name: 'Central African Republic', dialCode: '236', flag: '🇨🇫' },
  { code: 'TD', name: 'Chad', dialCode: '235', flag: '🇹🇩' },
  { code: 'CL', name: 'Chile', dialCode: '56', flag: '🇨🇱' },
  { code: 'CN', name: 'China', dialCode: '86', flag: '🇨🇳' },
  { code: 'CO', name: 'Colombia', dialCode: '57', flag: '🇨🇴' },
  { code: 'KM', name: 'Comoros', dialCode: '269', flag: '🇰🇲' },
  { code: 'CG', name: 'Congo', dialCode: '242', flag: '🇨🇬' },
  { code: 'CD', name: 'Congo (DRC)', dialCode: '243', flag: '🇨🇩' },
  { code: 'CR', name: 'Costa Rica', dialCode: '506', flag: '🇨🇷' },
  { code: 'CI', name: "Côte d'Ivoire", dialCode: '225', flag: '🇨🇮' },
  { code: 'HR', name: 'Croatia', dialCode: '385', flag: '🇭🇷' },
  { code: 'CU', name: 'Cuba', dialCode: '53', flag: '🇨🇺' },
  { code: 'CY', name: 'Cyprus', dialCode: '357', flag: '🇨🇾' },
  { code: 'CZ', name: 'Czechia', dialCode: '420', flag: '🇨🇿' },
  { code: 'DK', name: 'Denmark', dialCode: '45', flag: '🇩🇰' },
  { code: 'DJ', name: 'Djibouti', dialCode: '253', flag: '🇩🇯' },
  { code: 'DM', name: 'Dominica', dialCode: '1767', flag: '🇩🇲' },
  { code: 'DO', name: 'Dominican Republic', dialCode: '1809', flag: '🇩🇴' },
  { code: 'EC', name: 'Ecuador', dialCode: '593', flag: '🇪🇨' },
  { code: 'EG', name: 'Egypt', dialCode: '20', flag: '🇪🇬' },
  { code: 'SV', name: 'El Salvador', dialCode: '503', flag: '🇸🇻' },
  { code: 'GQ', name: 'Equatorial Guinea', dialCode: '240', flag: '🇬🇶' },
  { code: 'ER', name: 'Eritrea', dialCode: '291', flag: '🇪🇷' },
  { code: 'EE', name: 'Estonia', dialCode: '372', flag: '🇪🇪' },
  { code: 'SZ', name: 'Eswatini', dialCode: '268', flag: '🇸🇿' },
  { code: 'ET', name: 'Ethiopia', dialCode: '251', flag: '🇪🇹' },
  { code: 'FJ', name: 'Fiji', dialCode: '679', flag: '🇫🇯' },
  { code: 'FI', name: 'Finland', dialCode: '358', flag: '🇫🇮' },
  { code: 'FR', name: 'France', dialCode: '33', flag: '🇫🇷' },
  { code: 'GA', name: 'Gabon', dialCode: '241', flag: '🇬🇦' },
  { code: 'GM', name: 'Gambia', dialCode: '220', flag: '🇬🇲' },
  { code: 'GE', name: 'Georgia', dialCode: '995', flag: '🇬🇪' },
  { code: 'DE', name: 'Germany', dialCode: '49', flag: '🇩🇪' },
  { code: 'GH', name: 'Ghana', dialCode: '233', flag: '🇬🇭' },
  { code: 'GR', name: 'Greece', dialCode: '30', flag: '🇬🇷' },
  { code: 'GD', name: 'Grenada', dialCode: '1473', flag: '🇬🇩' },
  { code: 'GT', name: 'Guatemala', dialCode: '502', flag: '🇬🇹' },
  { code: 'GN', name: 'Guinea', dialCode: '224', flag: '🇬🇳' },
  { code: 'GW', name: 'Guinea-Bissau', dialCode: '245', flag: '🇬🇼' },
  { code: 'GY', name: 'Guyana', dialCode: '592', flag: '🇬🇾' },
  { code: 'HT', name: 'Haiti', dialCode: '509', flag: '🇭🇹' },
  { code: 'HN', name: 'Honduras', dialCode: '504', flag: '🇭🇳' },
  { code: 'HK', name: 'Hong Kong', dialCode: '852', flag: '🇭🇰' },
  { code: 'HU', name: 'Hungary', dialCode: '36', flag: '🇭🇺' },
  { code: 'IS', name: 'Iceland', dialCode: '354', flag: '🇮🇸' },
  { code: 'IN', name: 'India', dialCode: '91', flag: '🇮🇳' },
  { code: 'ID', name: 'Indonesia', dialCode: '62', flag: '🇮🇩' },
  { code: 'IR', name: 'Iran', dialCode: '98', flag: '🇮🇷' },
  { code: 'IQ', name: 'Iraq', dialCode: '964', flag: '🇮🇶' },
  { code: 'IE', name: 'Ireland', dialCode: '353', flag: '🇮🇪' },
  { code: 'IL', name: 'Israel', dialCode: '972', flag: '🇮🇱' },
  { code: 'IT', name: 'Italy', dialCode: '39', flag: '🇮🇹', preserveLeadingZero: true },
  { code: 'JM', name: 'Jamaica', dialCode: '1876', flag: '🇯🇲' },
  { code: 'JP', name: 'Japan', dialCode: '81', flag: '🇯🇵' },
  { code: 'JO', name: 'Jordan', dialCode: '962', flag: '🇯🇴' },
  { code: 'KZ', name: 'Kazakhstan', dialCode: '7', flag: '🇰🇿' },
  { code: 'KE', name: 'Kenya', dialCode: '254', flag: '🇰🇪' },
  { code: 'KI', name: 'Kiribati', dialCode: '686', flag: '🇰🇮' },
  { code: 'KP', name: 'North Korea', dialCode: '850', flag: '🇰🇵' },
  { code: 'KR', name: 'South Korea', dialCode: '82', flag: '🇰🇷' },
  { code: 'KW', name: 'Kuwait', dialCode: '965', flag: '🇰🇼' },
  { code: 'KG', name: 'Kyrgyzstan', dialCode: '996', flag: '🇰🇬' },
  { code: 'LA', name: 'Laos', dialCode: '856', flag: '🇱🇦' },
  { code: 'LV', name: 'Latvia', dialCode: '371', flag: '🇱🇻' },
  { code: 'LB', name: 'Lebanon', dialCode: '961', flag: '🇱🇧' },
  { code: 'LS', name: 'Lesotho', dialCode: '266', flag: '🇱🇸' },
  { code: 'LR', name: 'Liberia', dialCode: '231', flag: '🇱🇷' },
  { code: 'LY', name: 'Libya', dialCode: '218', flag: '🇱🇾' },
  { code: 'LI', name: 'Liechtenstein', dialCode: '423', flag: '🇱🇮' },
  { code: 'LT', name: 'Lithuania', dialCode: '370', flag: '🇱🇹' },
  { code: 'LU', name: 'Luxembourg', dialCode: '352', flag: '🇱🇺' },
  { code: 'MO', name: 'Macao', dialCode: '853', flag: '🇲🇴' },
  { code: 'MG', name: 'Madagascar', dialCode: '261', flag: '🇲🇬' },
  { code: 'MW', name: 'Malawi', dialCode: '265', flag: '🇲🇼' },
  { code: 'MY', name: 'Malaysia', dialCode: '60', flag: '🇲🇾' },
  { code: 'MV', name: 'Maldives', dialCode: '960', flag: '🇲🇻' },
  { code: 'ML', name: 'Mali', dialCode: '223', flag: '🇲🇱' },
  { code: 'MT', name: 'Malta', dialCode: '356', flag: '🇲🇹' },
  { code: 'MH', name: 'Marshall Islands', dialCode: '692', flag: '🇲🇭' },
  { code: 'MR', name: 'Mauritania', dialCode: '222', flag: '🇲🇷' },
  { code: 'MU', name: 'Mauritius', dialCode: '230', flag: '🇲🇺' },
  { code: 'MX', name: 'Mexico', dialCode: '52', flag: '🇲🇽' },
  { code: 'FM', name: 'Micronesia', dialCode: '691', flag: '🇫🇲' },
  { code: 'MD', name: 'Moldova', dialCode: '373', flag: '🇲🇩' },
  { code: 'MC', name: 'Monaco', dialCode: '377', flag: '🇲🇨' },
  { code: 'MN', name: 'Mongolia', dialCode: '976', flag: '🇲🇳' },
  { code: 'ME', name: 'Montenegro', dialCode: '382', flag: '🇲🇪' },
  { code: 'MA', name: 'Morocco', dialCode: '212', flag: '🇲🇦' },
  { code: 'MZ', name: 'Mozambique', dialCode: '258', flag: '🇲🇿' },
  { code: 'MM', name: 'Myanmar', dialCode: '95', flag: '🇲🇲' },
  { code: 'NA', name: 'Namibia', dialCode: '264', flag: '🇳🇦' },
  { code: 'NR', name: 'Nauru', dialCode: '674', flag: '🇳🇷' },
  { code: 'NP', name: 'Nepal', dialCode: '977', flag: '🇳🇵' },
  { code: 'NL', name: 'Netherlands', dialCode: '31', flag: '🇳🇱' },
  { code: 'NZ', name: 'New Zealand', dialCode: '64', flag: '🇳🇿' },
  { code: 'NI', name: 'Nicaragua', dialCode: '505', flag: '🇳🇮' },
  { code: 'NE', name: 'Niger', dialCode: '227', flag: '🇳🇪' },
  { code: 'NG', name: 'Nigeria', dialCode: '234', flag: '🇳🇬' },
  { code: 'MK', name: 'North Macedonia', dialCode: '389', flag: '🇲🇰' },
  { code: 'NO', name: 'Norway', dialCode: '47', flag: '🇳🇴' },
  { code: 'OM', name: 'Oman', dialCode: '968', flag: '🇴🇲' },
  { code: 'PK', name: 'Pakistan', dialCode: '92', flag: '🇵🇰' },
  { code: 'PW', name: 'Palau', dialCode: '680', flag: '🇵🇼' },
  { code: 'PS', name: 'Palestine', dialCode: '970', flag: '🇵🇸' },
  { code: 'PA', name: 'Panama', dialCode: '507', flag: '🇵🇦' },
  { code: 'PG', name: 'Papua New Guinea', dialCode: '675', flag: '🇵🇬' },
  { code: 'PY', name: 'Paraguay', dialCode: '595', flag: '🇵🇾' },
  { code: 'PE', name: 'Peru', dialCode: '51', flag: '🇵🇪' },
  { code: 'PH', name: 'Philippines', dialCode: '63', flag: '🇵🇭' },
  { code: 'PL', name: 'Poland', dialCode: '48', flag: '🇵🇱' },
  { code: 'PT', name: 'Portugal', dialCode: '351', flag: '🇵🇹' },
  { code: 'QA', name: 'Qatar', dialCode: '974', flag: '🇶🇦' },
  { code: 'RO', name: 'Romania', dialCode: '40', flag: '🇷🇴' },
  { code: 'RU', name: 'Russia', dialCode: '7', flag: '🇷🇺' },
  { code: 'RW', name: 'Rwanda', dialCode: '250', flag: '🇷🇼' },
  { code: 'KN', name: 'Saint Kitts and Nevis', dialCode: '1869', flag: '🇰🇳' },
  { code: 'LC', name: 'Saint Lucia', dialCode: '1758', flag: '🇱🇨' },
  { code: 'VC', name: 'Saint Vincent and the Grenadines', dialCode: '1784', flag: '🇻🇨' },
  { code: 'WS', name: 'Samoa', dialCode: '685', flag: '🇼🇸' },
  { code: 'SM', name: 'San Marino', dialCode: '378', flag: '🇸🇲' },
  { code: 'ST', name: 'São Tomé and Príncipe', dialCode: '239', flag: '🇸🇹' },
  { code: 'SA', name: 'Saudi Arabia', dialCode: '966', flag: '🇸🇦' },
  { code: 'SN', name: 'Senegal', dialCode: '221', flag: '🇸🇳' },
  { code: 'RS', name: 'Serbia', dialCode: '381', flag: '🇷🇸' },
  { code: 'SC', name: 'Seychelles', dialCode: '248', flag: '🇸🇨' },
  { code: 'SL', name: 'Sierra Leone', dialCode: '232', flag: '🇸🇱' },
  { code: 'SG', name: 'Singapore', dialCode: '65', flag: '🇸🇬' },
  { code: 'SK', name: 'Slovakia', dialCode: '421', flag: '🇸🇰' },
  { code: 'SI', name: 'Slovenia', dialCode: '386', flag: '🇸🇮' },
  { code: 'SB', name: 'Solomon Islands', dialCode: '677', flag: '🇸🇧' },
  { code: 'SO', name: 'Somalia', dialCode: '252', flag: '🇸🇴' },
  { code: 'ZA', name: 'South Africa', dialCode: '27', flag: '🇿🇦' },
  { code: 'SS', name: 'South Sudan', dialCode: '211', flag: '🇸🇸' },
  { code: 'ES', name: 'Spain', dialCode: '34', flag: '🇪🇸' },
  { code: 'LK', name: 'Sri Lanka', dialCode: '94', flag: '🇱🇰' },
  { code: 'SD', name: 'Sudan', dialCode: '249', flag: '🇸🇩' },
  { code: 'SR', name: 'Suriname', dialCode: '597', flag: '🇸🇷' },
  { code: 'SE', name: 'Sweden', dialCode: '46', flag: '🇸🇪' },
  { code: 'CH', name: 'Switzerland', dialCode: '41', flag: '🇨🇭' },
  { code: 'SY', name: 'Syria', dialCode: '963', flag: '🇸🇾' },
  { code: 'TW', name: 'Taiwan', dialCode: '886', flag: '🇹🇼' },
  { code: 'TJ', name: 'Tajikistan', dialCode: '992', flag: '🇹🇯' },
  { code: 'TZ', name: 'Tanzania', dialCode: '255', flag: '🇹🇿' },
  { code: 'TH', name: 'Thailand', dialCode: '66', flag: '🇹🇭' },
  { code: 'TL', name: 'Timor-Leste', dialCode: '670', flag: '🇹🇱' },
  { code: 'TG', name: 'Togo', dialCode: '228', flag: '🇹🇬' },
  { code: 'TO', name: 'Tonga', dialCode: '676', flag: '🇹🇴' },
  { code: 'TT', name: 'Trinidad and Tobago', dialCode: '1868', flag: '🇹🇹' },
  { code: 'TN', name: 'Tunisia', dialCode: '216', flag: '🇹🇳' },
  { code: 'TR', name: 'Türkiye', dialCode: '90', flag: '🇹🇷' },
  { code: 'TM', name: 'Turkmenistan', dialCode: '993', flag: '🇹🇲' },
  { code: 'TV', name: 'Tuvalu', dialCode: '688', flag: '🇹🇻' },
  { code: 'UG', name: 'Uganda', dialCode: '256', flag: '🇺🇬' },
  { code: 'UA', name: 'Ukraine', dialCode: '380', flag: '🇺🇦' },
  { code: 'AE', name: 'United Arab Emirates', dialCode: '971', flag: '🇦🇪' },
  { code: 'GB', name: 'United Kingdom', dialCode: '44', flag: '🇬🇧' },
  { code: 'US', name: 'United States', dialCode: '1', flag: '🇺🇸' },
  { code: 'UY', name: 'Uruguay', dialCode: '598', flag: '🇺🇾' },
  { code: 'UZ', name: 'Uzbekistan', dialCode: '998', flag: '🇺🇿' },
  { code: 'VU', name: 'Vanuatu', dialCode: '678', flag: '🇻🇺' },
  { code: 'VA', name: 'Vatican City', dialCode: '39', flag: '🇻🇦', preserveLeadingZero: true },
  { code: 'VE', name: 'Venezuela', dialCode: '58', flag: '🇻🇪' },
  { code: 'VN', name: 'Vietnam', dialCode: '84', flag: '🇻🇳' },
  { code: 'YE', name: 'Yemen', dialCode: '967', flag: '🇾🇪' },
  { code: 'ZM', name: 'Zambia', dialCode: '260', flag: '🇿🇲' },
  { code: 'ZW', name: 'Zimbabwe', dialCode: '263', flag: '🇿🇼' },
] as const;

const COUNTRY_BY_CODE = new Map(
  PHONE_COUNTRIES.map(country => [
    country.code,
    country,
  ]),
);

function digitsOnly(
  value: string,
): string {
  return value.replace(/\D/g, '');
}

function defaultCountryCode(): string {
  if (
    typeof navigator !==
    'undefined'
  ) {
    try {
      const locale =
        new Intl.Locale(
          navigator.language,
        );

      if (
        locale.region &&
        COUNTRY_BY_CODE.has(
          locale.region,
        )
      ) {
        return locale.region;
      }
    } catch {
      // Older browser: use the project-friendly fallback below.
    }
  }

  return 'EG';
}

function inferCountry(
  fullNumber: string,
  preferredCountryCode?: string,
): PhoneCountry {
  const normalized =
    digitsOnly(fullNumber);

  if (
    preferredCountryCode
  ) {
    const preferred =
      COUNTRY_BY_CODE.get(
        preferredCountryCode,
      );

    if (
      preferred &&
      normalized.startsWith(
        preferred.dialCode,
      )
    ) {
      return preferred;
    }
  }

  const inferred = [
    ...PHONE_COUNTRIES,
  ]
    .sort(
      (left, right) =>
        right.dialCode.length -
        left.dialCode.length,
    )
    .find(country =>
      normalized.startsWith(
        country.dialCode,
      ),
    );

  return (
    inferred ??
    COUNTRY_BY_CODE.get(
      defaultCountryCode(),
    ) ??
    PHONE_COUNTRIES[0]
  );
}

function nationalFromFull(
  fullNumber: string,
  country: PhoneCountry,
): string {
  const normalized =
    digitsOnly(fullNumber);

  if (
    normalized.startsWith(
      country.dialCode,
    )
  ) {
    return normalized.slice(
      country.dialCode.length,
    );
  }

  return normalized;
}

function normalizeNationalForInternational(
  nationalNumber: string,
  country: PhoneCountry,
): string {
  const digits =
    digitsOnly(nationalNumber);

  if (
    country.preserveLeadingZero
  ) {
    return digits;
  }

  // Most countries use 0 only as a domestic trunk prefix. Removing it here
  // lets users type familiar local forms such as 010... with Egypt selected
  // while still sending the API 2010... in international form.
  return digits.replace(/^0+/, '');
}

export interface CountryPhoneInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  inputClassName?: string;
  wrapperClassName?: string;
  countrySelectClassName?: string;
  defaultCountry?: string;
  autoComplete?: string;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  ariaLabel?: string;
}

/**
 * Country-code selector + national phone textbox.
 *
 * `value` and `onChange` deliberately keep the existing API shape: one full
 * international phone number containing digits only. This means the Sessions
 * and pairing endpoints do not need to change.
 */
export function CountryPhoneInput({
  id,
  value,
  onChange,
  disabled = false,
  required = false,
  placeholder = 'Phone number',
  inputClassName,
  wrapperClassName,
  countrySelectClassName,
  defaultCountry,
  autoComplete = 'tel-national',
  onKeyDown,
  ariaLabel = 'Country code',
}: CountryPhoneInputProps) {
  const initialCountry =
    useMemo(
      () =>
        inferCountry(
          value,
          defaultCountry ??
            defaultCountryCode(),
        ),
      // Initial state only. External value synchronization is handled below.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    );

  const [
    countryCode,
    setCountryCode,
  ] = useState(
    initialCountry.code,
  );

  const [
    nationalNumber,
    setNationalNumber,
  ] = useState(
    nationalFromFull(
      value,
      initialCountry,
    ),
  );

  const lastEmittedValueRef =
    useRef(
      digitsOnly(value),
    );

  const selectedCountry =
    COUNTRY_BY_CODE.get(
      countryCode,
    ) ?? initialCountry;

  useEffect(() => {
    const normalizedExternal =
      digitsOnly(value);

    if (
      normalizedExternal ===
      lastEmittedValueRef.current
    ) {
      return;
    }

    if (!normalizedExternal) {
      setNationalNumber('');
      lastEmittedValueRef.current = '';
      return;
    }

    const inferred =
      inferCountry(
        normalizedExternal,
        countryCode,
      );

    setCountryCode(
      inferred.code,
    );
    setNationalNumber(
      nationalFromFull(
        normalizedExternal,
        inferred,
      ),
    );
    lastEmittedValueRef.current =
      normalizedExternal;
  }, [
    countryCode,
    value,
  ]);

  const emit = (
    country: PhoneCountry,
    localNumber: string,
  ) => {
    if (!localNumber) {
      lastEmittedValueRef.current = '';
      onChange('');
      return;
    }

    const normalizedNational =
      normalizeNationalForInternational(
        localNumber,
        country,
      );

    const fullNumber =
      `${country.dialCode}${normalizedNational}`;

    lastEmittedValueRef.current =
      fullNumber;
    onChange(fullNumber);
  };

  return (
    <div
      className={[
        'country-phone-input',
        wrapperClassName,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <select
        className={[
          'country-phone-input__country',
          countrySelectClassName,
        ]
          .filter(Boolean)
          .join(' ')}
        value={countryCode}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={event => {
          const nextCountry =
            COUNTRY_BY_CODE.get(
              event.target.value,
            );

          if (!nextCountry) {
            return;
          }

          setCountryCode(
            nextCountry.code,
          );
          emit(
            nextCountry,
            nationalNumber,
          );
        }}
      >
        {PHONE_COUNTRIES.map(
          country => (
            <option
              key={country.code}
              value={country.code}
              aria-label={`${country.name} (+${country.dialCode})`}
              title={`${country.name} (+${country.dialCode})`}
            >
              {country.flag}{' '}+{country.dialCode}
            </option>
          ),
        )}
      </select>

      <div className="country-phone-input__number-wrap">
        <span
          className="country-phone-input__prefix"
          aria-hidden="true"
        >
          +{selectedCountry.dialCode}
        </span>

        <input
          id={id}
          type="tel"
          inputMode="numeric"
          autoComplete={autoComplete}
          className={[
            'country-phone-input__number',
            inputClassName,
          ]
            .filter(Boolean)
            .join(' ')}
          value={nationalNumber}
          disabled={disabled}
          required={required}
          maxLength={15}
          placeholder={placeholder}
          onKeyDown={onKeyDown}
          onChange={event => {
            const nextNational =
              digitsOnly(
                event.target.value,
              );

            setNationalNumber(
              nextNational,
            );
            emit(
              selectedCountry,
              nextNational,
            );
          }}
        />
      </div>
    </div>
  );
}
