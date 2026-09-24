import type { AnimeLang } from '@zflix/desktop-core';

const KEY = 'zflix.anime.prefs';

export type AnimeQuality = 'auto' | '1080' | '720' | '480';

export interface AnimePrefs {
  lang: AnimeLang;
  autoplayNext: boolean;
  preferredQuality: AnimeQuality;
  /** Keep last working server across episodes. */
  rememberServer: boolean;
  /** Soften UI motion (rails / hovers). */
  reduceMotion: boolean;
  /** Slightly denser poster rails. */
  compactCards: boolean;
  /** Show air date on unaired episodes when known. */
  showAirDates: boolean;
}

const DEFAULTS: AnimePrefs = {
  lang: 'vf',
  autoplayNext: true,
  preferredQuality: 'auto',
  rememberServer: true,
  reduceMotion: false,
  compactCards: false,
  showAirDates: true,
};

const QUALITIES: AnimeQuality[] = ['auto', '1080', '720', '480'];

export function loadAnimePrefs(): AnimePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<AnimePrefs> & { preferredPlayer?: string };
    const q = parsed.preferredQuality;
    return {
      lang: parsed.lang === 'vostfr' ? 'vostfr' : 'vf',
      autoplayNext: parsed.autoplayNext !== false,
      preferredQuality: QUALITIES.includes(q as AnimeQuality) ? (q as AnimeQuality) : 'auto',
      rememberServer: parsed.rememberServer !== false,
      reduceMotion: parsed.reduceMotion === true,
      compactCards: parsed.compactCards === true,
      showAirDates: parsed.showAirDates !== false,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAnimePrefs(prefs: AnimePrefs): void {
  localStorage.setItem(KEY, JSON.stringify(prefs));
}

export function qualityLabel(q: AnimeQuality): string {
  if (q === 'auto') return 'Auto (meilleure dispo)';
  return `${q}p`;
}
