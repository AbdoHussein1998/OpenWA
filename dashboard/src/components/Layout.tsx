






import {
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  NavLink,
  Outlet,
} from 'react-router-dom';
import {
  useTranslation,
} from 'react-i18next';
import {
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  FileText,
  Key,
  Languages,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Monitor,
  Moon,
  Puzzle,
  Send,
  Server,
  Smartphone,
  Sun,
  Users,
  Webhook,
  X,
  type LucideIcon,
} from 'lucide-react';

import {
  useTheme,
} from '../hooks/useTheme';

import type {
  UserRole,
} from '../types/role';

import {
  canAccessRoute,
} from '../utils/roleAccess';

import {
  languageOptions,
  resolveSupportedLanguage,
  rtlLanguages,
  type SupportedLanguage,
} from '../i18n';

import {
  healthApi,
} from '../services/api';

import './Layout.css';

interface LayoutProps {
  onLogout: () => void;
  userRole: UserRole | null;
}

interface NavItem {
  to: string;
  icon: LucideIcon;
  key:
    | 'dashboard'
    | 'sessions'
    | 'chats'
    | 'teamLeader'
    | 'agent'
    | 'webhooks'
    | 'templates'
    | 'apiKeys'
    | 'messageTester'
    | 'infrastructure'
    | 'plugins'
    | 'logs';
  fallbackLabel: string;
}

/**
 * Complete navigation catalog.
 *
 * Visibility is decided below from the authenticated role instead of
 * embedding adminOnly/nonAdminOnly flags into each item.
 */
const allNavItems: readonly NavItem[] = [
  {
    to: '/',
    icon:
      LayoutDashboard,
    key:
      'dashboard',
    fallbackLabel:
      'Dashboard',
  },
  {
    to:
      '/team-leader',
    icon:
      Users,
    key:
      'teamLeader',
    fallbackLabel:
      'Team Leader',
  },
  {
    to:
      '/agent',
    icon:
      Users,
    key:
      'agent',
    fallbackLabel:
      'Agent',
  },
  {
    to:
      '/sessions',
    icon:
      Smartphone,
    key:
      'sessions',
    fallbackLabel:
      'Sessions',
  },
  {
    to:
      '/chats',
    icon:
      MessageSquare,
    key:
      'chats',
    fallbackLabel:
      'Chats',
  },
  {
    to:
      '/webhooks',
    icon:
      Webhook,
    key:
      'webhooks',
    fallbackLabel:
      'Webhooks',
  },
  {
    to:
      '/templates',
    icon:
      ClipboardList,
    key:
      'templates',
    fallbackLabel:
      'Templates',
  },
  {
    to:
      '/api-keys',
    icon:
      Key,
    key:
      'apiKeys',
    fallbackLabel:
      'API Keys',
  },
  {
    to:
      '/message-tester',
    icon:
      Send,
    key:
      'messageTester',
    fallbackLabel:
      'Message Tester',
  },
  {
    to:
      '/infrastructure',
    icon:
      Server,
    key:
      'infrastructure',
    fallbackLabel:
      'Infrastructure',
  },
  {
    to:
      '/plugins',
    icon:
      Puzzle,
    key:
      'plugins',
    fallbackLabel:
      'Plugins',
  },
  {
    to:
      '/logs',
    icon:
      FileText,
    key:
      'logs',
    fallbackLabel:
      'Logs',
  },
];

const themeIcons = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

export function Layout({
  onLogout,
  userRole,
}: LayoutProps) {
  const {
    t,
    i18n,
  } = useTranslation();

  const {
    theme,
    setTheme,
    resolvedTheme,
  } = useTheme();

  const ThemeIcon =
    themeIcons[theme];

  const themeLabel =
    t(
      `theme.${theme}`,
    );

  /**
   * Navigation is role-aware and uses the same centralized route matrix
   * as App.tsx.
   *
   * - Team Leader sees the Team Leader workspace plus allowed tenant-scoped tools.
   * - Agent sees the Agent workspace and Templates. Assigned-session operations live inside /agent.
   * - Admin retains administrative surfaces, including Logs.
   * - Operator/Viewer keep only routes allowed by roleAccess.ts.
   *
   * This is UX only. NestJS remains the authorization boundary.
   */
  const navItems =
    allNavItems.filter(
      item =>
        userRole !== null &&
        canAccessRoute(
          userRole,
          item.to,
        ),
    );

  const [
    isCollapsed,
    setIsCollapsed,
  ] = useState(false);

  const [
    isMobileOpen,
    setIsMobileOpen,
  ] = useState(false);

  const [
    isMobile,
    setIsMobile,
  ] = useState(
    window.innerWidth <
      768,
  );

  /**
   * Show the build-time version immediately, then replace it with the
   * live backend version so a stale dashboard bundle cannot display the
   * wrong running version.
   */
  const [
    version,
    setVersion,
  ] = useState(
    __APP_VERSION__,
  );

  const [
    isLanguageMenuOpen,
    setIsLanguageMenuOpen,
  ] = useState(false);

  const languageMenuRef =
    useRef<HTMLDivElement>(
      null,
    );

  useEffect(() => {
    const handleResize =
      () => {
        const mobile =
          window.innerWidth <
          768;

        setIsMobile(
          mobile,
        );

        if (!mobile) {
          setIsMobileOpen(
            false,
          );
        }
      };

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

  useEffect(() => {
    let active = true;

    healthApi
      .check()
      .then(info => {
        if (
          active &&
          info?.version
        ) {
          setVersion(
            info.version,
          );
        }
      })
      .catch(() => {
        /**
         * Keep the build-time version fallback.
         */
      });

    return () => {
      active = false;
    };
  }, []);

  const handleNavClick =
    () => {
      if (isMobile) {
        setIsMobileOpen(
          false,
        );
      }
    };

  useEffect(() => {
    document.body.style.overflow =
      isMobileOpen
        ? 'hidden'
        : '';

    return () => {
      document.body.style.overflow =
        '';
    };
  }, [
    isMobileOpen,
  ]);

  useEffect(() => {
    if (
      !isLanguageMenuOpen
    ) {
      return;
    }

    const closeOnOutsideClick =
      (
        event: MouseEvent,
      ) => {
        if (
          !languageMenuRef.current?.contains(
            event.target as Node,
          )
        ) {
          setIsLanguageMenuOpen(
            false,
          );
        }
      };

    const closeOnEscape =
      (
        event: KeyboardEvent,
      ) => {
        if (
          event.key ===
          'Escape'
        ) {
          setIsLanguageMenuOpen(
            false,
          );
        }
      };

    document.addEventListener(
      'mousedown',
      closeOnOutsideClick,
    );

    document.addEventListener(
      'keydown',
      closeOnEscape,
    );

    return () => {
      document.removeEventListener(
        'mousedown',
        closeOnOutsideClick,
      );

      document.removeEventListener(
        'keydown',
        closeOnEscape,
      );
    };
  }, [
    isLanguageMenuOpen,
  ]);

  const toggleCollapse =
    () =>
      setIsCollapsed(
        value =>
          !value,
      );

  const toggleMobile =
    () =>
      setIsMobileOpen(
        value =>
          !value,
      );

  const currentLang =
    resolveSupportedLanguage(
      i18n.resolvedLanguage ||
        i18n.language,
    );

  const languageLabel =
    languageOptions.find(
      option =>
        option.value ===
        currentLang,
    )?.compactLabel ??
    'EN';

  const changeLanguage =
    (
      language: SupportedLanguage,
    ) => {
      setIsLanguageMenuOpen(
        false,
      );

      void i18n.changeLanguage(
        language,
      );
    };

  const isRtl =
    rtlLanguages.includes(
      currentLang,
    );

  return (
    <div className="layout">
      {isMobile && (
        <header className="mobile-header">
          <button
            className="mobile-menu-btn"
            onClick={
              toggleMobile
            }
            aria-label={
              t(
                'common.expand',
              )
            }
          >
            {isMobileOpen ? (
              <X
                size={24}
              />
            ) : (
              <Menu
                size={24}
              />
            )}
          </button>

          <div className="mobile-brand">
            <img
              src="/openwa_logo.webp"
              alt="OpenWA"
              className="sidebar-logo"
            />

            <span className="brand-name">
              {t(
                'common.appName',
              )}
            </span>
          </div>

          <div
            style={{
              width: 40,
            }}
          />
        </header>
      )}

      {isMobile &&
        isMobileOpen && (
          <div
            className="sidebar-overlay"
            onClick={() =>
              setIsMobileOpen(
                false,
              )
            }
          />
        )}

      <aside
        className={`sidebar ${
          isCollapsed
            ? 'collapsed'
            : ''
        } ${
          isMobile
            ? 'mobile'
            : ''
        } ${
          isMobileOpen
            ? 'open'
            : ''
        }`}
      >
        <div className="sidebar-header">
          <img
            src="/openwa_logo.webp"
            alt="OpenWA"
            className="sidebar-logo"
          />

          {!isCollapsed && (
            <div className="sidebar-brand">
              <span className="brand-name">
                {t(
                  'common.appName',
                )}
              </span>

              <span className="brand-version">
                v{version}
              </span>
            </div>
          )}
        </div>

        {!isMobile && (
          <button
            className="collapse-toggle"
            onClick={
              toggleCollapse
            }
            title={
              isCollapsed
                ? t(
                    'common.expand',
                  )
                : t(
                    'common.collapse',
                  )
            }
            aria-label={
              isCollapsed
                ? t(
                    'common.expand',
                  )
                : t(
                    'common.collapse',
                  )
            }
          >
            {isCollapsed ? (
              isRtl ? (
                <ChevronLeft
                  size={16}
                />
              ) : (
                <ChevronRight
                  size={16}
                />
              )
            ) : isRtl ? (
              <ChevronRight
                size={16}
              />
            ) : (
              <ChevronLeft
                size={16}
              />
            )}
          </button>
        )}

        <nav className="sidebar-nav">
          {navItems.map(
            ({
              to,
              icon: Icon,
              key,
              fallbackLabel,
            }) => {
              const label =
                t(
                  `nav.${key}`,
                  {
                    defaultValue:
                      fallbackLabel,
                  },
                );

              return (
                <NavLink
                  key={to}
                  to={to}
                  className={({
                    isActive,
                  }) =>
                    `nav-item ${
                      isActive
                        ? 'active'
                        : ''
                    }`
                  }
                  end={
                    to ===
                    '/'
                  }
                  onClick={
                    handleNavClick
                  }
                  title={
                    isCollapsed
                      ? label
                      : undefined
                  }
                >
                  <Icon
                    size={20}
                  />

                  {!isCollapsed && (
                    <span>
                      {
                        label
                      }
                    </span>
                  )}
                </NavLink>
              );
            },
          )}
        </nav>

        <div className="sidebar-footer">
          <div
            className="language-menu"
            ref={
              languageMenuRef
            }
          >
            <button
              className="theme-toggle-btn"
              onClick={() =>
                setIsLanguageMenuOpen(
                  open =>
                    !open,
                )
              }
              title={t(
                'common.language',
              )}
              aria-label={t(
                'common.language',
              )}
              aria-haspopup="menu"
              aria-expanded={
                isLanguageMenuOpen
              }
            >
              <Languages
                size={18}
              />

              {!isCollapsed && (
                <span>
                  {
                    languageLabel
                  }
                </span>
              )}
            </button>

            {isLanguageMenuOpen && (
              <div
                className="language-menu-list"
                role="menu"
                aria-label={t(
                  'common.language',
                )}
              >
                {languageOptions.map(
                  option => (
                    <button
                      key={
                        option.value
                      }
                      className={`language-menu-item ${
                        option.value ===
                        currentLang
                          ? 'active'
                          : ''
                      }`}
                      onClick={() =>
                        changeLanguage(
                          option.value,
                        )
                      }
                      role="menuitemradio"
                      aria-checked={
                        option.value ===
                        currentLang
                      }
                    >
                      <span>
                        {
                          option.label
                        }
                      </span>
                    </button>
                  ),
                )}
              </div>
            )}
          </div>

          <div className="appearance-menu">
            <button
              className="theme-toggle-btn"
              onClick={() =>
                setTheme(
                  resolvedTheme ===
                    'dark'
                    ? 'light'
                    : 'dark',
                )
              }
              title={t(
                'theme.toggleTo',
                {
                  value:
                    t(
                      resolvedTheme ===
                        'dark'
                        ? 'theme.light'
                        : 'theme.dark',
                    ),
                },
              )}
              aria-label={t(
                'theme.toggleTo',
                {
                  value:
                    t(
                      resolvedTheme ===
                        'dark'
                        ? 'theme.light'
                        : 'theme.dark',
                    ),
                },
              )}
            >
              <span
                className="appearance-button-cue"
                aria-hidden="true"
              >
                <ThemeIcon
                  size={16}
                />
              </span>

              {!isCollapsed && (
                <span>
                  {
                    themeLabel
                  }
                </span>
              )}
            </button>
          </div>

          <button
            className="logout-btn"
            onClick={
              onLogout
            }
            title={
              isCollapsed
                ? t(
                    'common.logout',
                  )
                : undefined
            }
          >
            <LogOut
              size={20}
            />

            {!isCollapsed && (
              <span>
                {t(
                  'common.logout',
                )}
              </span>
            )}
          </button>
        </div>
      </aside>

      <main
        className={`main-content ${
          isCollapsed
            ? 'expanded'
            : ''
        } ${
          isMobile
            ? 'mobile'
            : ''
        }`}
      >
        <Outlet />
      </main>
    </div>
  );
}








