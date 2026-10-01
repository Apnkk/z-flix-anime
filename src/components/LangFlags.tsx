/** Compact SVG flags for VF / VOSTFR stream availability (not country of origin). */

import { useEffect, useRef, useState } from 'react';
import {
  clampAnimeLang,
  ensureTitleLangIndex,
  fetchEpisodeLangMap,
  formatTitleLangs,
  inferTitleLangs,
  resolveEpisodeLangs,
  subscribeTitleLangIndex,
  titleLangButtons,
  type AnimeLang,
  type TitleCard,
  type TitleLangAvail,
} from '@zflix/desktop-core';

export function FlagFR({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 16" width="18" height="12" aria-hidden focusable="false">
      <rect width="24" height="16" rx="2" fill="#fff" />
      <rect width="8" height="16" fill="#002395" />
      <rect x="16" width="8" height="16" fill="#ED2939" />
      <rect x="0.4" y="0.4" width="23.2" height="15.2" rx="1.7" fill="none" stroke="rgba(0,0,0,0.25)" strokeWidth="0.8" />
    </svg>
  );
}

export function FlagJP({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 16" width="18" height="12" aria-hidden focusable="false">
      <rect width="24" height="16" rx="2" fill="#fff" />
      <circle cx="12" cy="8" r="4.2" fill="#BC002D" />
      <rect x="0.4" y="0.4" width="23.2" height="15.2" rx="1.7" fill="none" stroke="rgba(0,0,0,0.25)" strokeWidth="0.8" />
    </svg>
  );
}

export function useTitleLangIndexTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const unsub = subscribeTitleLangIndex(() => setTick((n) => n + 1));
    void ensureTitleLangIndex();
    return unsub;
  }, []);
  return tick;
}

export function TitleLangFlags({
  item,
  className = 'mag-card-langs',
}: {
  item: Pick<TitleCard, 'title' | 'langs'>;
  className?: string;
}) {
  useTitleLangIndexTick();
  const avail = inferTitleLangs(item);
  if (!avail.vf && !avail.vostfr) return null;
  const label = formatTitleLangs(avail);
  return (
    <span className={className} title={label} aria-label={label}>
      {avail.vf ? <FlagFR /> : null}
      {avail.vostfr ? <FlagJP /> : null}
    </span>
  );
}

/** Fiche + player: hide VF/VOSTFR only when flags are sure. Unknown → both. */
export function TitleLangSwitch({
  item,
  lang,
  onLang,
  className = 'lang-switch',
  episodeAvail,
}: {
  item: Pick<TitleCard, 'title' | 'langs'>;
  lang: AnimeLang;
  onLang: (l: AnimeLang) => void;
  className?: string;
  episodeAvail?: TitleLangAvail | null;
}) {
  const tick = useTitleLangIndexTick();
  const buttons = titleLangButtons(item);
  const onLangRef = useRef(onLang);
  onLangRef.current = onLang;

  const vfUnavailable = episodeAvail ? (!episodeAvail.vf && episodeAvail.vostfr) : false;
  const voUnavailable = episodeAvail ? (!episodeAvail.vostfr && episodeAvail.vf) : false;

  useEffect(() => {
    if (episodeAvail) {
      if (lang === 'vf' && vfUnavailable) {
        onLangRef.current('vostfr');
        return;
      }
      if (lang === 'vostfr' && voUnavailable) {
        onLangRef.current('vf');
        return;
      }
    }
    const next = clampAnimeLang(lang, item);
    if (next !== lang) onLangRef.current(next);
  }, [lang, item, tick, buttons.vf, buttons.vostfr, vfUnavailable, voUnavailable]);

  return (
    <div className={className}>
      {buttons.vf ? (
        <button
          type="button"
          className={`${lang === 'vf' ? 'on' : ''}${vfUnavailable ? ' cr-lang-btn-disabled' : ''}`}
          disabled={vfUnavailable}
          title={vfUnavailable ? 'Cet épisode est disponible uniquement en VOSTFR' : 'Version française'}
          onClick={() => {
            if (!vfUnavailable) onLang('vf');
          }}
        >
          <FlagFR /> VF{vfUnavailable ? ' (indispo)' : ''}
        </button>
      ) : null}
      {buttons.vostfr ? (
        <button
          type="button"
          className={`${lang === 'vostfr' ? 'on' : ''}${voUnavailable ? ' cr-lang-btn-disabled' : ''}`}
          disabled={voUnavailable}
          title={voUnavailable ? 'Cet épisode est disponible uniquement en VF' : 'Version originale sous-titrée'}
          onClick={() => {
            if (!voUnavailable) onLang('vostfr');
          }}
        >
          <FlagJP /> VOSTFR{voUnavailable ? ' (indispo)' : ''}
        </button>
      ) : null}
    </div>
  );
}

/** Tiny flags on episode thumbs. Null/empty → render nothing. */
export function EpisodeLangFlags({
  avail,
  className = 'ep-card-langs',
}: {
  avail: TitleLangAvail | null | undefined;
  className?: string;
}) {
  if (!avail || (!avail.vf && !avail.vostfr)) return null;
  const label = formatTitleLangs(avail);
  return (
    <span className={className} title={label} aria-label={label}>
      {avail.vf ? <FlagFR /> : null}
      {avail.vostfr ? <FlagJP /> : null}
    </span>
  );
}

/**
 * Per-episode flags for the current season. Coming-soon eps must pass aired=false.
 * Title both + no per-ep map → no flags (don't fake VF+VOSTFR on every card).
 */
export function useEpisodeLangResolver(
  item: Pick<TitleCard, 'id' | 'title' | 'langs' | 'mediaType'> | null | undefined,
  season: number,
): (epNum: number, aired: boolean) => TitleLangAvail | null {
  const tick = useTitleLangIndexTick();
  const [perEp, setPerEp] = useState<Record<string, TitleLangAvail> | null>(null);

  useEffect(() => {
    if (!item?.id || item.mediaType === 'movie') {
      setPerEp(null);
      return;
    }
    let cancelled = false;
    setPerEp(null);
    void fetchEpisodeLangMap(item.id, season, item.title).then((map) => {
      if (!cancelled) setPerEp(map);
    });
    return () => {
      cancelled = true;
    };
  }, [item?.id, item?.title, item?.mediaType, season]);

  return (epNum: number, aired: boolean) => {
    if (!item || !aired) return null;
    void tick;
    return resolveEpisodeLangs(epNum, perEp, inferTitleLangs(item));
  };
}
