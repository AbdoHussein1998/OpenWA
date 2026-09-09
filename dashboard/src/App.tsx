


import {
  Suspense,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
} from 'react-router-dom';
import {
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import {
  Loader2,
} from 'lucide-react';

import {
  lazyWithRetry as lazy,
} from './utils/lazyWithRetry';

import {
  Layout,
} from './components/Layout';
import {
  ToastProvider,
} from './components/Toast';
import {
  ErrorBoundary,
} from './components/ErrorBoundary';
import {
  RoleProvider,
} from './components/RoleProvider';

import {
  useRole,
} from './hooks/useRole';

import {
  API_BASE_URL,
} from './services/api';

import {
  clearActorState,
  isUserRole,
  resolveStartupValidation,
} from './utils/authLifecycle';

import {
  canAccessRoute,
  getRoleHome,
} from './utils/roleAccess';

import type {
  UserRole,
} from './types/role';

import './App.css';

const Login = lazy(() =>
  import('./pages/Login').then(m => ({
    default: m.Login,
  })),
);

const Dashboard = lazy(() =>
  import('./pages/Dashboard').then(m => ({
    default: m.Dashboard,
  })),
);

const Sessions = lazy(() =>
  import('./pages/Sessions').then(m => ({
    default: m.Sessions,
  })),
);

const Chats = lazy(() =>
  import('./pages/Chats').then(m => ({
    default: m.Chats,
  })),
);

const Webhooks = lazy(() =>
  import('./pages/Webhooks').then(m => ({
    default: m.Webhooks,
  })),
);

const Templates = lazy(() =>
  import('./pages/Templates').then(m => ({
    default: m.Templates,
  })),
);

const Logs = lazy(() =>
  import('./pages/Logs').then(m => ({
    default: m.Logs,
  })),
);

const ApiKeys = lazy(() =>
  import('./pages/ApiKeys').then(m => ({
    default: m.ApiKeys,
  })),
);

const MessageTester = lazy(() =>
  import('./pages/MessageTester').then(m => ({
    default: m.MessageTester,
  })),
);

const Infrastructure = lazy(() =>
  import('./pages/Infrastructure').then(m => ({
    default: m.Infrastructure,
  })),
);

const Plugins = lazy(() =>
  import('./pages/Plugins'),
);

const TeamLeader = lazy(() =>
  import('./pages/TeamLeader').then(m => ({
    default: m.TeamLeader,
  })),
);

const Agent = lazy(() =>
  import('./pages/Agent').then(m => ({
    default: m.Agent,
  })),
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

/**
 * Audit logs are currently Admin-only on the backend.
 *
 * Keep this explicit until /logs is represented directly in the
 * centralized roleAccess.ts route matrix.
 */
function canAccessAppRoute(
  role: UserRole,
  path: string,
): boolean {
  if (path === '/logs') {
    return role === 'admin';
  }

  return canAccessRoute(
    role,
    path,
  );
}

function RoleRoute({
  role,
  path,
  children,
}: {
  role: UserRole;
  path: string;
  children: ReactNode;
}) {
  if (
    !canAccessAppRoute(
      role,
      path,
    )
  ) {
    return (
      <Navigate
        to={getRoleHome(role)}
        replace
      />
    );
  }

  return <>{children}</>;
}

function AppContent() {
  /**
   * Capture the key once at mount.
   *
   * The startup validation effect is for genuine page refreshes with a
   * previously-saved key, not for the fresh login transition.
   */
  const [savedKey] =
    useState(() =>
      sessionStorage.getItem(
        'openwa_api_key',
      ),
    );

  const [
    isAuthenticated,
    setIsAuthenticated,
  ] = useState(
    !!savedKey,
  );

  const [
    ,
    setApiKey,
  ] = useState(
    savedKey || '',
  );

  const {
    setRole,
    role,
  } = useRole();

  /**
   * Only used while a saved role is not yet available.
   * Backend authorization remains authoritative.
   */
  const effectiveRole: UserRole =
    role ?? 'viewer';

  const handleLogin = (
    key: string,
    validatedRole?: string,
  ) => {
    setApiKey(key);

    sessionStorage.setItem(
      'openwa_api_key',
      key,
    );

    setRole(
      isUserRole(validatedRole)
        ? validatedRole
        : 'viewer',
    );

    setIsAuthenticated(true);
  };

  const handleLogout =
    useCallback(() => {
      setApiKey('');
      setIsAuthenticated(false);
      setRole(null);

      sessionStorage.removeItem(
        'openwa_api_key',
      );

      clearActorState(
        queryClient,
      );
    }, [
      setRole,
    ]);

  useEffect(() => {
    if (!savedKey) {
      return;
    }

    fetch(
      `${API_BASE_URL}/auth/validate`,
      {
        method: 'POST',
        headers: {
          'X-API-Key':
            savedKey,
        },
      },
    )
      .then(
        async response => {
          const decision =
            resolveStartupValidation(
              response.status,
              await response
                .json()
                .catch(
                  () => null,
                ),
            );

          if (
            decision.action ===
            'logout'
          ) {
            handleLogout();
          } else if (
            decision.action ===
            'role'
          ) {
            setRole(
              decision.role,
            );
          }
        },
      )
      .catch(() => {
        /**
         * A network failure does not prove the key is invalid.
         */
      });
  }, [
    savedKey,
    setRole,
    handleLogout,
  ]);

  const loadingFallback = (
    <div
      style={{
        display: 'flex',
        alignItems:
          'center',
        justifyContent:
          'center',
        minHeight:
          '100vh',
      }}
    >
      <Loader2
        className="animate-spin"
        size={32}
      />
    </div>
  );

  if (!isAuthenticated) {
    return (
      <Suspense
        fallback={
          loadingFallback
        }
      >
        <Login
          onLogin={
            handleLogin
          }
        />
      </Suspense>
    );
  }

  return (
    <ToastProvider>
      <BrowserRouter>
        <Suspense
          fallback={
            loadingFallback
          }
        >
          <Routes>
            <Route
              path="/"
              element={
                <Layout
                  onLogout={
                    handleLogout
                  }
                  userRole={
                    effectiveRole
                  }
                />
              }
            >
              <Route
                index
                element={
                  <RoleRoute
                    role={
                      effectiveRole
                    }
                    path="/"
                  >
                    <Dashboard />
                  </RoleRoute>
                }
              />

              <Route
                path="sessions"
                element={
                  <RoleRoute
                    role={
                      effectiveRole
                    }
                    path="/sessions"
                  >
                    <Sessions />
                  </RoleRoute>
                }
              />

              <Route
                path="chats"
                element={
                  <RoleRoute
                    role={
                      effectiveRole
                    }
                    path="/chats"
                  >
                    <Chats />
                  </RoleRoute>
                }
              />

              <Route
                path="webhooks"
                element={
                  <RoleRoute
                    role={
                      effectiveRole
                    }
                    path="/webhooks"
                  >
                    <Webhooks />
                  </RoleRoute>
                }
              />

              <Route
                path="templates"
                element={
                  <RoleRoute
                    role={
                      effectiveRole
                    }
                    path="/templates"
                  >
                    <Templates />
                  </RoleRoute>
                }
              />

              <Route
                path="api-keys"
                element={
                  <RoleRoute
                    role={
                      effectiveRole
                    }
                    path="/api-keys"
                  >
                    <ApiKeys />
                  </RoleRoute>
                }
              />

              <Route
                path="logs"
                element={
                  <RoleRoute
                    role={
                      effectiveRole
                    }
                    path="/logs"
                  >
                    <Logs />
                  </RoleRoute>
                }
              />

              <Route
                path="message-tester"
                element={
                  <RoleRoute
                    role={
                      effectiveRole
                    }
                    path="/message-tester"
                  >
                    <MessageTester />
                  </RoleRoute>
                }
              />

              <Route
                path="infrastructure"
                element={
                  <RoleRoute
                    role={
                      effectiveRole
                    }
                    path="/infrastructure"
                  >
                    <Infrastructure />
                  </RoleRoute>
                }
              />

              <Route
                path="plugins"
                element={
                  <RoleRoute
                    role={
                      effectiveRole
                    }
                    path="/plugins"
                  >
                    <Plugins />
                  </RoleRoute>
                }
              />

              <Route
                path="team-leader"
                element={
                  <RoleRoute
                    role={
                      effectiveRole
                    }
                    path="/team-leader"
                  >
                    <TeamLeader />
                  </RoleRoute>
                }
              />

              <Route
                path="agent"
                element={
                  <RoleRoute
                    role={
                      effectiveRole
                    }
                    path="/agent"
                  >
                    <Agent />
                  </RoleRoute>
                }
              />

              {/**
               * Old bookmarks remain valid, but there is no longer a
               * separate SPG/phone-discovery workspace.
               */}
              <Route
                path="spg-agents"
                element={
                  <RoleRoute
                    role={
                      effectiveRole
                    }
                    path="/spg-agents"
                  >
                    <Navigate
                      to="/agent"
                      replace
                    />
                  </RoleRoute>
                }
              />

              <Route
                path="*"
                element={
                  <Navigate
                    to={getRoleHome(
                      effectiveRole,
                    )}
                    replace
                  />
                }
              />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider
        client={
          queryClient
        }
      >
        <RoleProvider>
          <AppContent />
        </RoleProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;



