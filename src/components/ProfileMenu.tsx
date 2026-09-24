import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import {
  clearActiveProfile,
  saveSession,
  type AuthSession,
  type WatchProfile,
} from '@zflix/desktop-core';

interface Props {
  session: AuthSession;
  profile: WatchProfile;
  onSwitchProfile: () => void;
  onLogout: () => void;
  placement?: 'header' | 'rail';
}

export function ProfileMenu({ session, profile, onSwitchProfile, onLogout, placement = 'header' }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; place: 'up' | 'down' } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const place: 'up' | 'down' = placement === 'rail' || r.bottom > window.innerHeight - 220 ? 'up' : 'down';
    const left = Math.min(Math.max(12, r.left), window.innerWidth - 268);
    const top = place === 'up' ? r.top - 12 : r.bottom + 10;
    setPos({ top, left, place });
  }, [open, placement]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || dropRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', () => setOpen(false));
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const dropdown = open && pos ? createPortal(
    <div
      ref={dropRef}
      className={`profile-dropdown profile-dropdown-fixed profile-dropdown-${pos.place}`}
      style={
        pos.place === 'up'
          ? { left: pos.left, bottom: window.innerHeight - pos.top, top: 'auto' }
          : { left: pos.left, top: pos.top }
      }
    >
      <div className="profile-drop-head">
        <img src={encodeURI(profile.avatarUrl)} alt="" draggable={false} />
        <div>
          <strong>{profile.name}</strong>
          <span>{session.user.username || 'Compte Z-Flix'}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          clearActiveProfile();
          onSwitchProfile();
        }}
      >
        Changer de profil
      </button>
      <button
        type="button"
        className="danger"
        onClick={() => {
          setOpen(false);
          void invoke('logout_auth');
          saveSession(null);
          clearActiveProfile();
          onLogout();
        }}
      >
        Se déconnecter
      </button>
    </div>,
    document.body,
  ) : null;

  return (
    <div className={`profile-menu profile-menu-${placement}`} ref={ref}>
      <button
        type="button"
        className={`profile-chip${open ? ' on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={`Profil ${profile.name}`}
        aria-expanded={open}
      >
        <img src={encodeURI(profile.avatarUrl)} alt="" draggable={false} />
      </button>
      {dropdown}
    </div>
  );
}
