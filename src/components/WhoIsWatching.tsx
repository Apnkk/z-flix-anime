import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  AVATAR_CATEGORIES_ANIME,
  PROFILE_LIMIT,
  accountAvatarUrl,
  avatarPath,
  clearActiveProfile,
  createProfile,
  deleteProfile,
  setActiveProfileId,
  syncAccountProfile,
  updateProfile,
  type AuthSession,
  type WatchProfile,
} from '@zflix/desktop-core';

const AVATAR_CATEGORIES = AVATAR_CATEGORIES_ANIME;
const DEFAULT_CAT = Object.keys(AVATAR_CATEGORIES)[0] || 'One Piece';
import { WindowControls } from './TitleBar';

interface Props {
  session: AuthSession;
  productName: string;
  accent?: string;
  onSelect: (profile: WatchProfile) => void;
  onLogout: () => void;
}

export function WhoIsWatching({ session, productName, accent = '#e50914', onSelect, onLogout }: Props) {
  const [profiles, setProfiles] = useState<WatchProfile[]>(() => syncAccountProfile(session));
  const [managing, setManaging] = useState(false);
  const [editor, setEditor] = useState<null | { id?: string; name: string; avatarUrl: string }>(null);
  const [category, setCategory] = useState(() => DEFAULT_CAT);

  const accountUrl = useMemo(() => accountAvatarUrl(session), [session]);
  const categories = useMemo(() => Object.keys(AVATAR_CATEGORIES), []);

  function openCreate() {
    const first = AVATAR_CATEGORIES[DEFAULT_CAT]?.[0] || 'Avatar One Piece 1.png';
    setEditor({
      name: '',
      avatarUrl: avatarPath(DEFAULT_CAT, first),
    });
    setCategory(DEFAULT_CAT);
  }

  function openEdit(p: WatchProfile) {
    setEditor({ id: p.id, name: p.name, avatarUrl: p.avatarUrl });
    const found = categories.find((c) => p.avatarUrl.includes(`/avatars/${c}/`));
    setCategory(found || DEFAULT_CAT);
  }

  function saveEditor() {
    if (!editor || !editor.name.trim()) return;
    if (editor.id) {
      setProfiles(updateProfile(editor.id, { name: editor.name.trim(), avatarUrl: editor.avatarUrl }));
    } else {
      setProfiles(createProfile(editor.name.trim(), editor.avatarUrl));
    }
    setEditor(null);
    setManaging(false);
  }

  function pick(p: WatchProfile) {
    if (managing) {
      openEdit(p);
      return;
    }
    setActiveProfileId(p.id);
    onSelect(p);
  }

  return (
    <div className="who-page" style={{ ['--accent' as string]: accent }}>
      <div className="who-bg" />
      <div className="who-vignette" />
      <header className="who-chrome">
        <div className="who-chrome-brand" data-tauri-drag-region>
          <img src="/icon.png" alt="" draggable={false} />
          <span>{productName}</span>
        </div>
        <div className="who-chrome-drag" data-tauri-drag-region />
        <WindowControls />
      </header>

      <AnimatePresence mode="wait">
        {!editor ? (
          <motion.div
            key="pick"
            className="who-body"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            <h1 className="who-title">Qui regarde {productName} ?</h1>
            <div className="who-grid">
              {profiles.map((p, i) => (
                <motion.button
                  type="button"
                  key={p.id}
                  className={`who-card${managing ? ' who-card-edit' : ''}`}
                  onClick={() => pick(p)}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.05 * i, duration: 0.35 }}
                  whileHover={{ y: -6 }}
                  whileTap={{ scale: 0.97 }}
                >
                  <span className="who-avatar">
                    <img src={encodeURI(p.avatarUrl)} alt="" draggable={false} />
                    {managing && (
                      <span className="who-edit-badge">
                        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                        </svg>
                      </span>
                    )}
                  </span>
                  <span className="who-name">{p.name}</span>
                  {p.isAccount && <span className="who-badge">Compte</span>}
                </motion.button>
              ))}
              {!managing && profiles.length < PROFILE_LIMIT && (
                <motion.button
                  type="button"
                  className="who-card who-card-add"
                  onClick={openCreate}
                  whileHover={{ y: -6 }}
                  whileTap={{ scale: 0.97 }}
                >
                  <span className="who-avatar who-avatar-plus">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </span>
                  <span className="who-name">Ajouter</span>
                </motion.button>
              )}
            </div>
            <div className="who-actions">
              <button type="button" className={`who-btn twin${managing ? ' on' : ''}`} onClick={() => setManaging((v) => !v)}>
                {managing ? 'Terminer' : 'Gérer les profils'}
              </button>
              <button
                type="button"
                className="who-btn twin"
                onClick={() => {
                  clearActiveProfile();
                  onLogout();
                }}
              >
                Se déconnecter
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="edit"
            className="who-body who-edit"
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="who-edit-top">
              <h1 className="who-title">{editor.id ? 'Modifier le profil' : 'Ajouter un profil'}</h1>
              <p className="who-edit-sub">Choisis un avatar et un nom — comme sur Z-Flix.</p>
            </div>

            <div className="who-edit-layout">
              <div className="who-edit-side">
                <div className="who-preview">
                  <div className="who-avatar who-avatar-lg">
                    <img src={encodeURI(editor.avatarUrl)} alt="" draggable={false} />
                  </div>
                </div>
                <label className="who-field">
                  <span>Nom du profil</span>
                  <input
                    className="who-input"
                    placeholder="Ex. Ares, Kids…"
                    value={editor.name}
                    maxLength={24}
                    onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                    autoFocus
                  />
                </label>
                <div className="who-edit-btns">
                  <button type="button" className="who-btn solid" disabled={!editor.name.trim()} onClick={saveEditor}>
                    Enregistrer
                  </button>
                  <button type="button" className="who-btn ghost" onClick={() => setEditor(null)}>
                    Annuler
                  </button>
                  {editor.id && !profiles.find((p) => p.id === editor.id)?.isAccount && (
                    <button
                      type="button"
                      className="who-btn danger"
                      onClick={() => {
                        setProfiles(deleteProfile(editor.id!));
                        setEditor(null);
                      }}
                    >
                      Supprimer
                    </button>
                  )}
                </div>
              </div>

              <div className="who-picker">
                <div className="who-picker-head">
                  <div>
                    <h3>Choisir un avatar</h3>
                    <p className="who-picker-cat">{category}</p>
                  </div>
                  <span className="who-picker-count">{(AVATAR_CATEGORIES[category] || []).length} avatars</span>
                </div>

                <div className="who-picker-body">
                  <nav className="who-cat-rail" aria-label="Catégories d'avatars">
                    {accountUrl && (
                      <button
                        type="button"
                        className={`who-cat-item who-cat-account${editor.avatarUrl === accountUrl ? ' on' : ''}`}
                        onClick={() => setEditor({ ...editor, avatarUrl: accountUrl })}
                      >
                        <img src={accountUrl} alt="" draggable={false} />
                        <span>Mon compte</span>
                      </button>
                    )}
                    {categories.map((c) => (
                      <button
                        type="button"
                        key={c}
                        className={`who-cat-item${category === c ? ' on' : ''}`}
                        onClick={() => setCategory(c)}
                      >
                        <img
                          src={encodeURI(avatarPath(c, AVATAR_CATEGORIES[c][0]))}
                          alt=""
                          draggable={false}
                        />
                        <span>{c}</span>
                      </button>
                    ))}
                  </nav>

                  <div className="who-opts who-opts-scroll">
                    {(AVATAR_CATEGORIES[category] || []).map((file) => {
                      const url = avatarPath(category, file);
                      const selected = editor.avatarUrl === url;
                      return (
                        <button
                          type="button"
                          key={file}
                          className={`who-opt${selected ? ' on' : ''}`}
                          onClick={() => setEditor({ ...editor, avatarUrl: url })}
                        >
                          <img src={encodeURI(url)} alt="" draggable={false} />
                          {selected && <span className="who-opt-check">✓</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
