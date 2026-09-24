import { useEffect, useState } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { getVersion } from '@tauri-apps/api/app';
import { relaunch } from '@tauri-apps/plugin-process';
import { clearStickyAnimePlayer, type AnimeLang } from '@zflix/desktop-core';
import { saveAnimePrefs, qualityLabel, type AnimePrefs, type AnimeQuality } from '../animePrefs';
import { FlagFR, FlagJP } from './LangFlags';
import { ReleaseNotesPanel } from './ReleaseNotesPanel';

type Tab = 'lecture' | 'affichage' | 'donnees' | 'notes' | 'app';

interface Props {
  open: boolean;
  onClose: () => void;
  prefs: AnimePrefs;
  onChange: (next: AnimePrefs) => void;
  onClearHistory?: () => void;
  onClearList?: () => void;
}

const QUALITIES: AnimeQuality[] = ['auto', '1080', '720', '480'];

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'lecture', label: 'Lecture', hint: 'Langue, qualité, enchaînement' },
  { id: 'affichage', label: 'Affichage', hint: 'Densité, motion, dates' },
  { id: 'donnees', label: 'Données', hint: 'Historique, serveur sticky' },
  { id: 'notes', label: 'Notes', hint: 'Changelog & versions' },
  { id: 'app', label: 'Application', hint: 'Mises à jour & à propos' },
];

export function SettingsModal({ open, onClose, prefs, onChange, onClearHistory, onClearList }: Props) {
  const [version, setVersion] = useState('…');
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('lecture');
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void getVersion().then(setVersion).catch(() => setVersion('?'));
    setUpdateStatus(null);
    setToast(null);
    setTab('lecture');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  if (tab === 'notes') {
    return <ReleaseNotesPanel onBack={() => setTab('app')} />;
  }

  function patch(partial: Partial<AnimePrefs>) {
    const next = { ...prefs, ...partial };
    saveAnimePrefs(next);
    onChange(next);
  }

  function flash(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2200);
  }

  async function checkUpdates() {
    setBusy(true);
    setUpdateStatus('Recherche…');
    try {
      const update = await check();
      if (!update) {
        setUpdateStatus('Z-Animes est à jour.');
        return;
      }
      setUpdateStatus(`Mise à jour ${update.version} — téléchargement…`);
      await update.downloadAndInstall();
      setUpdateStatus('Installé. Redémarrage…');
      await relaunch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setUpdateStatus(
        msg.includes('valid release JSON') || msg.includes('fetch')
          ? 'Mise à jour indisponible pour le moment. Réessaie après la prochaine release.'
          : msg,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-page" role="dialog" aria-labelledby="anime-settings-title">
      <header className="settings-page-head">
        <div>
          <p className="settings-kicker">Z-Animes</p>
          <h1 id="anime-settings-title">Paramètres</h1>
          <p className="settings-page-sub">Lecture, affichage, données locales et mises à jour.</p>
        </div>
        <button type="button" className="settings-close" onClick={onClose} aria-label="Fermer">
          ← Retour
        </button>
      </header>

      <div className="settings-page-body">
        <nav className="settings-side" aria-label="Sections paramètres">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`settings-side-item${tab === t.id ? ' on' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <strong>{t.label}</strong>
              <span>{t.hint}</span>
            </button>
          ))}
        </nav>

        <div className="settings-main">
          {toast ? <p className="settings-toast" role="status">{toast}</p> : null}

          {tab === 'lecture' && (
            <section className="settings-block">
              <h3>Lecture</h3>
              <label className="settings-row">
                <span>
                  <strong>Langue par défaut</strong>
                  <em>Toujours utilisée — un changement sur un anime ne change pas ce réglage</em>
                </span>
                <div className="settings-seg">
                  {(['vf', 'vostfr'] as AnimeLang[]).map((l) => (
                    <button
                      type="button"
                      key={l}
                      className={prefs.lang === l ? 'on' : ''}
                      onClick={() => patch({ lang: l })}
                    >
                      {l === 'vf' ? <><FlagFR /> VF</> : <><FlagJP /> VOSTFR</>}
                    </button>
                  ))}
                </div>
              </label>

              <label className="settings-row">
                <span>
                  <strong>Épisode suivant auto</strong>
                  <em>Passe au suivant à la fin de l’épisode</em>
                </span>
                <button
                  type="button"
                  className={`settings-toggle${prefs.autoplayNext ? ' on' : ''}`}
                  aria-pressed={prefs.autoplayNext}
                  onClick={() => patch({ autoplayNext: !prefs.autoplayNext })}
                >
                  <i />
                </button>
              </label>

              <label className="settings-row">
                <span>
                  <strong>Mémoriser le serveur</strong>
                  <em>Reprend le dernier serveur qui a marché (VF). Désactive pour forcer une nouvelle race</em>
                </span>
                <button
                  type="button"
                  className={`settings-toggle${prefs.rememberServer ? ' on' : ''}`}
                  aria-pressed={prefs.rememberServer}
                  onClick={() => {
                    const next = !prefs.rememberServer;
                    if (!next) clearStickyAnimePlayer();
                    patch({ rememberServer: next });
                  }}
                >
                  <i />
                </button>
              </label>

              <div className="settings-row stack">
                <span>
                  <strong>Qualité préférée</strong>
                  <em>Appliquée dès le lancement — Auto = meilleure dispo, sinon cap 1080/720/480</em>
                </span>
                <div className="settings-quality-grid">
                  {QUALITIES.map((q) => (
                    <button
                      type="button"
                      key={q}
                      className={`settings-quality${prefs.preferredQuality === q ? ' on' : ''}`}
                      onClick={() => patch({ preferredQuality: q })}
                    >
                      {qualityLabel(q)}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          )}

          {tab === 'affichage' && (
            <section className="settings-block">
              <h3>Affichage</h3>
              <label className="settings-row">
                <span>
                  <strong>Cartes compactes</strong>
                  <em>Posters un peu plus petits sur les rails</em>
                </span>
                <button
                  type="button"
                  className={`settings-toggle${prefs.compactCards ? ' on' : ''}`}
                  aria-pressed={prefs.compactCards}
                  onClick={() => patch({ compactCards: !prefs.compactCards })}
                >
                  <i />
                </button>
              </label>

              <label className="settings-row">
                <span>
                  <strong>Réduire les animations</strong>
                  <em>Moins de transitions / glows</em>
                </span>
                <button
                  type="button"
                  className={`settings-toggle${prefs.reduceMotion ? ' on' : ''}`}
                  aria-pressed={prefs.reduceMotion}
                  onClick={() => patch({ reduceMotion: !prefs.reduceMotion })}
                >
                  <i />
                </button>
              </label>

              <label className="settings-row">
                <span>
                  <strong>Dates de diffusion</strong>
                  <em>Affiche la date prévue sur les épisodes pas encore sortis</em>
                </span>
                <button
                  type="button"
                  className={`settings-toggle${prefs.showAirDates ? ' on' : ''}`}
                  aria-pressed={prefs.showAirDates}
                  onClick={() => patch({ showAirDates: !prefs.showAirDates })}
                >
                  <i />
                </button>
              </label>

              <div className="settings-about">
                <strong>Thème</strong>
                <p>Fond OLED noir + accent rouge nuancé (fixe pour Z-Animes).</p>
              </div>
            </section>
          )}

          {tab === 'donnees' && (
            <section className="settings-block">
              <h3>Données locales</h3>
              <div className="settings-row">
                <span>
                  <strong>Serveur mémorisé</strong>
                  <em>Oublie le sticky serveur (utile si VOSTFR/VF se mélangent)</em>
                </span>
                <button
                  type="button"
                  className="settings-action"
                  onClick={() => {
                    clearStickyAnimePlayer();
                    flash('Serveur mémorisé effacé');
                  }}
                >
                  Effacer
                </button>
              </div>
              <div className="settings-row">
                <span>
                  <strong>Historique</strong>
                  <em>Titres récemment ouverts sur ce profil</em>
                </span>
                <button
                  type="button"
                  className="settings-action danger"
                  onClick={() => {
                    onClearHistory?.();
                    flash('Historique vidé');
                  }}
                >
                  Vider
                </button>
              </div>
              <div className="settings-row">
                <span>
                  <strong>Ma liste</strong>
                  <em>Retire tous les titres de la liste locale</em>
                </span>
                <button
                  type="button"
                  className="settings-action danger"
                  onClick={() => {
                    onClearList?.();
                    flash('Liste vidée');
                  }}
                >
                  Vider
                </button>
              </div>
              <div className="settings-about">
                <strong>Privé</strong>
                <p>Ces données restent sur cette machine / ce profil. Pas de sync cloud pour l’instant.</p>
              </div>
            </section>
          )}

          {tab === 'app' && (
            <section className="settings-block">
              <h3>Application</h3>
              <div className="settings-row">
                <span>
                  <strong>Mises à jour</strong>
                  <em>{updateStatus || `Version ${version}`}</em>
                </span>
                <button type="button" className="settings-action" disabled={busy} onClick={() => void checkUpdates()}>
                  Vérifier
                </button>
              </div>
              <div className="settings-row">
                <span>
                  <strong>Notes de version</strong>
                  <em>Changelog timeline · badges Dernière / Installée</em>
                </span>
                <button type="button" className="settings-action" onClick={() => setTab('notes')}>
                  Ouvrir
                </button>
              </div>
              <div className="settings-about">
                <strong>À propos</strong>
                <p>
                  Z-Animes {version} — catalogue anime VF / VOSTFR. Lecteur perso, serveurs code-name, paramètres
                  séparés de Z-Movies.
                </p>
              </div>
              <div className="settings-about">
                <strong>Raccourcis lecteur</strong>
                <p>Espace = play/pause · ←/→ = ±10s · F = plein écran · Échap = quitter le lecteur.</p>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
