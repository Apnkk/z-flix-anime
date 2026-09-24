import { useMemo, useRef } from 'react';
import {
  getImageUrl,
  type AnimeLang,
  type TitleCard,
  type TitleDetails,
} from '@zflix/desktop-core';
import { TitleLangFlags, TitleLangSwitch } from './LangFlags';
import { useDragScroll } from '../dragScroll';

type Props = {
  details: TitleDetails;
  lang: AnimeLang;
  inList: boolean;
  canResume: boolean;
  progressPct: number;
  onBack: () => void;
  onLang: (lang: AnimeLang) => void;
  onPlay: () => void;
  onToggleList: () => void;
  onOpenRelated: (card: TitleCard) => void;
};

export function MovieFiche({
  details,
  lang,
  inList,
  canResume,
  progressPct,
  onBack,
  onLang,
  onPlay,
  onToggleList,
  onOpenRelated,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  useDragScroll(trackRef);

  const year = details.releaseDate?.slice(0, 4) || '';
  const score = details.voteAverage > 0
    ? Math.min(99, Math.round(details.voteAverage * 10))
    : 0;
  const backdrop = getImageUrl(details.backdropPath || details.posterPath, 'original');
  const genres = useMemo(() => {
    const named = details.genres.filter((g) => g.name);
    const withoutAnim = named.filter((g) => g.name.toLowerCase() !== 'animation');
    return (withoutAnim.length ? withoutAnim : named).slice(0, 4);
  }, [details.genres]);
  const related = details.recommendations.filter((r) => r.posterPath).slice(0, 18);

  return (
    <section className="film-fiche">
      <div className="film-stage">
        <div
          className="film-backdrop"
          style={backdrop ? { backgroundImage: `url(${backdrop})` } : undefined}
        />
        <div className="film-shade" aria-hidden />
        <button type="button" className="film-back" onClick={onBack}>
          ← Retour
        </button>
        <div className="film-inner">
          {details.posterPath ? (
            <div className="film-poster-wrap">
              <img
                className="film-poster"
                src={getImageUrl(details.posterPath, 'w500')}
                alt=""
                draggable={false}
              />
            </div>
          ) : null}
          <div className="film-copy">
            <span className="film-kicker">Film</span>
            {details.logoPath ? (
              <img
                className="film-logo"
                src={getImageUrl(details.logoPath, 'w500')}
                alt={details.title}
                draggable={false}
              />
            ) : (
              <h1>{details.title}</h1>
            )}
            <div className="film-meta">
              {score > 0 ? <span className="film-match">{score}%</span> : null}
              {year ? <span>{year}</span> : null}
              {details.runtime ? <span>{details.runtime} min</span> : null}
              <span className="film-badge">HD</span>
            </div>
            {genres.length > 0 ? (
              <div className="film-genres">
                {genres.map((g) => (
                  <span key={g.id}>{g.name}</span>
                ))}
              </div>
            ) : null}
            {details.tagline ? <p className="film-tagline">« {details.tagline} »</p> : null}
            {details.overview ? <p className="film-overview">{details.overview}</p> : null}
            <TitleLangSwitch item={details} lang={lang} onLang={onLang} className="lang-switch film-lang" />
            <div className="film-actions">
              <button type="button" className="btn cta film-cta" onClick={onPlay}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                  <path d="M8.2 5.05v13.9a1.1 1.1 0 0 0 1.68.93l11.2-6.95a1.1 1.1 0 0 0 0-1.86L9.88 4.12A1.1 1.1 0 0 0 8.2 5.05Z" />
                </svg>
                {canResume ? 'Reprendre' : 'Lancer le film'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={onToggleList}>
                {inList ? 'Retirer' : '+ Liste'}
              </button>
            </div>
            {canResume && progressPct > 0 ? (
              <div className="film-resume">
                <div className="film-resume-bar" aria-hidden>
                  <span style={{ width: `${progressPct}%` }} />
                </div>
                <em>Reprise à {progressPct}%</em>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {related.length > 0 ? (
        <div className="film-related">
          <div className="section-head">
            <h2>Films similaires</h2>
          </div>
          <div className="magazine-track" ref={trackRef}>
            {related.map((item) => (
              <button
                type="button"
                key={item.id}
                className="mag-card"
                onClick={() => onOpenRelated(item)}
              >
                <div className="mag-card-frame">
                  <img src={getImageUrl(item.posterPath, 'w342')} alt={item.title} loading="lazy" draggable={false} />
                  <TitleLangFlags item={item} />
                </div>
                <span>{item.title}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
