import {
  useEffect,
  useState,
} from 'react';

import {
  healthApi,
} from '../services/api';

/**
 * Resolve the application version from one shared source.
 *
 * The dashboard bundle version is available synchronously through
 * __APP_VERSION__, so both Login and Layout can render immediately.
 * When the health endpoint returns the running backend version (it does
 * so for authenticated callers), that live value replaces the build-time
 * fallback. If the health request fails or the backend intentionally omits
 * the version for an unauthenticated caller, the fallback is preserved.
 */
export function useAppVersion(): string {
  const [
    version,
    setVersion,
  ] = useState(
    __APP_VERSION__,
  );

  useEffect(() => {
    let active = true;

    void healthApi
      .check()
      .then(info => {
        if (
          active &&
          info.version
        ) {
          setVersion(
            info.version,
          );
        }
      })
      .catch(() => {
        /*
         * Keep the build-time version fallback when the API is unavailable.
         */
      });

    return () => {
      active = false;
    };
  }, []);

  return version;
}
