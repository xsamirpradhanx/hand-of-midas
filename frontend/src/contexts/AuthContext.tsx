/**
 * Authentication context using Amazon Cognito.
 *
 * Provides session management, sign-in, sign-up, confirmation, and sign-out
 * functionality via React context. Wraps the `amazon-cognito-identity-js`
 * library with a React-friendly API.
 *
 * @module AuthContext
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';
import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserSession,
  CognitoUserAttribute,
} from 'amazon-cognito-identity-js';
import { config } from '../config';

/* ─── Cognito Pool ─── */

export const userPool = new CognitoUserPool({
  UserPoolId: config.cognitoUserPoolId,
  ClientId: config.cognitoClientId,
});

/* ─── Types ─── */

/** User information surfaced by the auth context */
export interface AuthUser {
  email: string;
  sub: string;
}

/** Shape of the authentication context value */
export interface AuthContextValue {
  /** The currently authenticated user, or null */
  user: AuthUser | null;
  /** True while the initial session check is in progress */
  loading: boolean;
  /** Last authentication error message, if any */
  error: string | null;
  /** Sign in with email and password */
  signIn: (email: string, password: string) => Promise<void>;
  /** Register a new account */
  signUp: (email: string, password: string) => Promise<void>;
  /** Confirm a new account with the verification code */
  confirmSignUp: (email: string, code: string) => Promise<void>;
  /** Sign out the current user */
  signOut: () => void;
  /** Get the current JWT access token, or null if not authenticated */
  getSession: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/* ─── Provider ─── */

interface AuthProviderProps {
  children: ReactNode;
}

/**
 * Provides authentication state and methods to the component tree.
 *
 * Checks for an existing Cognito session on mount and keeps
 * `user` / `loading` / `error` in sync.
 */
export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Retrieve the current session and extract user info */
  const getSession = useCallback(async (): Promise<string | null> => {
    const cognitoUser = userPool.getCurrentUser();
    if (!cognitoUser) return null;

    return new Promise((resolve) => {
      cognitoUser.getSession(
        (err: Error | null, session: CognitoUserSession | null) => {
          if (err || !session || !session.isValid()) {
            resolve(null);
            return;
          }
          resolve(session.getIdToken().getJwtToken());
        },
      );
    });
  }, []);

  /** Check for existing session on mount */
  useEffect(() => {
    const cognitoUser = userPool.getCurrentUser();
    if (!cognitoUser) {
      setLoading(false);
      return;
    }

    cognitoUser.getSession(
      (err: Error | null, session: CognitoUserSession | null) => {
        if (err || !session || !session.isValid()) {
          setLoading(false);
          return;
        }

        const payload = session.getIdToken().decodePayload();
        setUser({
          email: (payload['email'] as string) ?? '',
          sub: (payload['sub'] as string) ?? '',
        });
        setLoading(false);
      },
    );
  }, []);

  /** Sign in with email and password */
  const signIn = useCallback(async (email: string, password: string) => {
    setError(null);

    const cognitoUser = new CognitoUser({
      Username: email,
      Pool: userPool,
    });

    const authDetails = new AuthenticationDetails({
      Username: email,
      Password: password,
    });

    return new Promise<void>((resolve, reject) => {
      cognitoUser.authenticateUser(authDetails, {
        onSuccess: (session: CognitoUserSession) => {
          const payload = session.getIdToken().decodePayload();
          setUser({
            email: (payload['email'] as string) ?? '',
            sub: (payload['sub'] as string) ?? '',
          });
          resolve();
        },
        onFailure: (err: Error) => {
          setError(err.message || 'Authentication failed');
          reject(err);
        },
      });
    });
  }, []);

  /** Register a new user */
  const signUp = useCallback(async (email: string, password: string) => {
    setError(null);

    const attributes = [
      new CognitoUserAttribute({ Name: 'email', Value: email }),
    ];

    return new Promise<void>((resolve, reject) => {
      userPool.signUp(email, password, attributes, [], (err) => {
        if (err) {
          setError(err.message || 'Sign up failed');
          reject(err);
          return;
        }
        resolve();
      });
    });
  }, []);

  /** Confirm sign-up with a verification code */
  const confirmSignUp = useCallback(async (email: string, code: string) => {
    setError(null);

    const cognitoUser = new CognitoUser({
      Username: email,
      Pool: userPool,
    });

    return new Promise<void>((resolve, reject) => {
      cognitoUser.confirmRegistration(code, true, (err) => {
        if (err) {
          setError(err.message || 'Confirmation failed');
          reject(err);
          return;
        }
        resolve();
      });
    });
  }, []);

  /** Sign out the current user */
  const signOut = useCallback(() => {
    const cognitoUser = userPool.getCurrentUser();
    if (cognitoUser) {
      cognitoUser.signOut();
    }
    setUser(null);
    setError(null);
  }, []);

  const value: AuthContextValue = {
    user,
    loading,
    error,
    signIn,
    signUp,
    confirmSignUp,
    signOut,
    getSession,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/* ─── Hook ─── */

/**
 * Hook to access the authentication context.
 *
 * @throws If used outside of an {@link AuthProvider}.
 */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
