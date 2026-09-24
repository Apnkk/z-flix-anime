import { invoke } from '@tauri-apps/api/core';
import { saveSession, type AuthSession } from '@zflix/desktop-core';
import { WindowControls } from './TitleBar';

interface Props {
  productName: string;
  tagline: string;
  iconSrc: string;
  accent: string;
}

export function LoginGate({ productName, tagline, iconSrc, accent }: Props) {
  async function oauth(provider: 'discord' | 'google') {
    await invoke('start_oauth', { provider });
  }

  return (
    <div className="login-gate">
      <div className="login-gate-bg" style={{ ['--accent' as string]: accent }} />
      <header className="login-chrome">
        <div className="login-chrome-drag" data-tauri-drag-region />
        <WindowControls />
      </header>
      <div className="login-card">
        <div className="login-logo">
          <img src={iconSrc} alt="" />
        </div>
        <h1>{productName}</h1>
        <p className="login-tagline">{tagline}</p>
        <p className="login-hint">
          Connecte-toi pour accéder au catalogue. Si tu es déjà connecté sur ZLauncher, ta session sera reprise.
        </p>
        <div className="login-actions">
          <button type="button" className="btn cta full" onClick={() => void oauth('discord')}>
            Continuer avec Discord
          </button>
          <button type="button" className="btn full" onClick={() => void oauth('google')}>
            Continuer avec Google
          </button>
        </div>
      </div>
    </div>
  );
}

export function AuthSplash() {
  return (
    <div className="login-gate login-gate-splash">
      <div className="login-gate-bg" />
      <div className="login-spinner" />
      <p>Vérification de la session…</p>
    </div>
  );
}

export async function hydrateSession(
  setSession: (s: AuthSession | null) => void,
  setReady: (v: boolean) => void,
) {
  try {
    const s = await invoke<AuthSession | null>('get_auth_session');
    if (s) {
      saveSession(s);
      setSession(s);
    }
  } finally {
    setReady(true);
  }
}
