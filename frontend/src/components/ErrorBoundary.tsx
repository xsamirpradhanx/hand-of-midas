import React, { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  label?: string;
}

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? ` — ${this.props.label}` : ''}]`, error, info);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{
          padding: '1.5rem',
          background: 'rgba(255,77,77,0.08)',
          border: '1px solid rgba(255,77,77,0.25)',
          borderRadius: '8px',
          color: '#ff6b6b',
          fontSize: '0.9rem',
        }}>
          <strong>{this.props.label ?? 'Panel'} unavailable</strong>
          {this.state.message && (
            <p style={{ marginTop: '0.5rem', opacity: 0.75, fontSize: '0.8rem' }}>
              {this.state.message}
            </p>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
