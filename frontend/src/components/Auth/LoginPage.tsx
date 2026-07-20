import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import styles from './LoginPage.module.css';

export const LoginPage: React.FC = () => {
  const [isSignUp, setIsSignUp] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  
  const { signIn, signUp, confirmSignUp } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isConfirming) {
        await confirmSignUp(email, code);
        setIsConfirming(false);
        setIsSignUp(false);
        setError('Email confirmed! You can now sign in.');
      } else if (isSignUp) {
        await signUp(email, password);
        setIsConfirming(true);
      } else {
        await signIn(email, password);
        navigate('/');
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.header}>
          <div className={styles.logoGlow}>
            <img src="/logo.png" alt="Hand of Midas Logo" className={styles.logo} />
          </div>
          <h1 className={styles.title}>Hand of Midas</h1>
          <p className={styles.tagline}>Whale Flow Intelligence</p>
          <p className={styles.subtitle}>
            {isConfirming 
              ? 'Confirm your email' 
              : isSignUp 
                ? 'Create a new account' 
                : 'Sign in to your account'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className={styles.form}>
          {error && <div className={styles.error}>{error}</div>}

          {!isConfirming && (
            <>
              <div className={styles.inputGroup}>
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className={styles.inputGroup}>
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
            </>
          )}

          {isConfirming && (
            <div className={styles.inputGroup}>
              <label htmlFor="code">Confirmation Code</label>
              <input
                id="code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            </div>
          )}

          <button type="submit" disabled={loading} className={styles.submitBtn}>
            {loading ? 'Processing...' : isConfirming ? 'Confirm' : isSignUp ? 'Sign Up' : 'Sign In'}
          </button>
        </form>

        {!isConfirming && (
          <div className={styles.footer}>
            <button 
              className={styles.toggleBtn}
              onClick={() => {
                setIsSignUp(!isSignUp);
                setError('');
              }}
            >
              {isSignUp ? 'Already have an account? Sign In' : 'Need an account? Sign Up'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
