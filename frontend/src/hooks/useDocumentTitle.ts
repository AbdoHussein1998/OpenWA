import { useEffect } from 'react';

/**
 * Custom hook to set document title dynamically.
 * Automatically appends " | OpenWA" suffix.
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${title} | Al.Hakim`;

    return () => {
      document.title = previousTitle;
    };
  }, [title]);
}
