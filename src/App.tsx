import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  animeRowMediaType,
  animeRows,
  animeAiringBrowseUrl,
  airingBadge,
  airingSubtitle,
  asListItem,
  browseUrl,
  clearHistory,
  clearMyList,
  fetchAnimeSagaCollections,
  HOME_SAGA_LIMIT,
  fetchAnimeTrending,
  fetchDetails,
  fetchList,
  fetchListPage,
  fetchNewEpisodeCards,
  fetchSeason,
  fetchTvAiringPulse,
  formatTitleLangs,
  genreLabels,
  getContinueWatching,
  getHistory,
  getImageUrl,
  getMyList,
  inferTitleLangs,
  clampAnimeLang,
  inMyList,
  isBlockedAnimeId,
  isEpisodeAired,
  formatEpisodeAirDate,
  setResolveAuthToken,
  loadSession,
  pushHistory,
  saveSession,
  searchTitles,
  toggleMyList,
  getActiveProfile,
  syncAccountProfile,
  TMDB_PROXY_BASE,
  type AnimeLang,
  type AiringPulse,
  type AuthSession,
  type EpisodeInfo,
  type HistoryItem,
  type MediaType,
  type SagaCollection,
  type TitleCard,
  type TitleDetails,
  type WatchProfile,
} from '@zflix/desktop-core';
import { WindowControls } from './components/TitleBar';
import { AnimePlayer } from './components/AnimePlayer';
import { AuthSplash, LoginGate, hydrateSession } from './components/LoginGate';
import { WhoIsWatching } from './components/WhoIsWatching';
import { ProfileMenu } from './components/ProfileMenu';
import { SettingsModal } from './components/SettingsModal';
import { EpisodeLangFlags, TitleLangFlags, TitleLangSwitch, useEpisodeLangResolver, useTitleLangIndexTick } from './components/LangFlags';
import { MovieFiche } from './components/MovieFiche';
import { loadAnimePrefs, type AnimePrefs } from './animePrefs';
import { useDragScroll } from './dragScroll';

type View = 'home' | 'catalog' | 'films' | 'sagas' | 'airing' | 'top' | 'history' | 'list';
type CatalogFilter = { label: string; url: string };

const HOME_BATCH = 3;
const HOME_DEFS = animeRows();

const ANIME_TV_DISCOVER =
  'with_original_language=ja&language=fr-FR&include_adult=false&without_keywords=198385|155477|378816|256466';

function animeGenreBrowseUrl(...extraGenreIds: number[]): string {
  const genres = ['16', ...extraGenreIds.map(String)].join(',');
  return `${TMDB_PROXY_BASE}/discover/tv?with_genres=${genres}&${ANIME_TV_DISCOVER}&sort_by=popularity.desc&vote_count.gte=40`;
}

/** TV has no Romance genre (10749 is movies-only) — use TMDB keyword. */
function animeKeywordBrowseUrl(...keywordIds: number[]): string {
  return `${TMDB_PROXY_BASE}/discover/tv?with_genres=16&with_keywords=${keywordIds.join('|')}&${ANIME_TV_DISCOVER}&sort_by=popularity.desc&vote_count.gte=20`;
}

const RAIL_GENRES: CatalogFilter[] = [
  { label: 'Action', url: animeGenreBrowseUrl(10759) },
  { label: 'Drame', url: animeGenreBrowseUrl(18) },
  { label: 'Comédie', url: animeGenreBrowseUrl(35) },
  { label: 'Sci-fi', url: animeGenreBrowseUrl(10765) },
  { label: 'Romance', url: animeKeywordBrowseUrl(9840) },
  { label: 'Mystère', url: animeGenreBrowseUrl(9648) },
];

const RAIL_COLLAPSED_KEY = 'zflix.anime.railCollapsed';

function loadRailCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function persistRailCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    /* private mode / quota */
  }
}

function currentAnimeSeason(): { label: string; year: number } {
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();
  if (month <= 2) return { label: 'Hiver', year };
  if (month <= 5) return { label: 'Printemps', year };
  if (month <= 8) return { label: 'Été', year };
  return { label: 'Automne', year };
}

export default function App() {
  const [view, setView] = useState<View>('home');
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilter | null>(null);
  const [session, setSession] = useState<AuthSession | null>(() => loadSession());
  const [authReady, setAuthReady] = useState(false);
  const [activeProfile, setActiveProfile] = useState<WatchProfile | null>(() => getActiveProfile());
  useTitleLangIndexTick();
  const [rows, setRows] = useState<{ id: string; title: string; items: TitleCard[] }[]>([]);
  const [homeDefIndex, setHomeDefIndex] = useState(0);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeLoadingMore, setHomeLoadingMore] = useState(false);
  const [trending, setTrending] = useState<TitleCard[]>([]);
  const [newEpisodes, setNewEpisodes] = useState<TitleCard[]>([]);
  const [catalog, setCatalog] = useState<TitleCard[]>([]);
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalogTotalPages, setCatalogTotalPages] = useState(1);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogLoadingMore, setCatalogLoadingMore] = useState(false);
  const [airingPulses, setAiringPulses] = useState<Record<number, AiringPulse>>({});
  const airingPulseCache = useRef<Map<number, AiringPulse | null>>(new Map());
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<TitleCard[]>([]);
  const [list, setList] = useState<HistoryItem[]>(() => getMyList());
  const [history, setHistory] = useState<HistoryItem[]>(() => getHistory());
  const [details, setDetails] = useState<TitleDetails | null>(null);
  const [seasonPick, setSeasonPick] = useState(1);
  const [episodes, setEpisodes] = useState<EpisodeInfo[]>([]);
  const [prefs, setPrefs] = useState<AnimePrefs>(() => loadAnimePrefs());
  const [lang, setLang] = useState<AnimeLang>(() => loadAnimePrefs().lang);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [watch, setWatch] = useState<{ details: TitleDetails; season: number; episode: number } | null>(null);
  const [saga, setSaga] = useState<SagaCollection | null>(null);
  const [sagas, setSagas] = useState<SagaCollection[]>([]);
  const epLangOf = useEpisodeLangResolver(details, seasonPick);
  const mainRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const railPeekTimer = useRef<number | null>(null);
  const railHovering = useRef(false);
  const [railCollapsed, setRailCollapsed] = useState(loadRailCollapsed);
  const [railPeek, setRailPeek] = useState(false);
  const [railFoldLock, setRailFoldLock] = useState(false);

  const clearRailPeekTimer = useCallback(() => {
    if (railPeekTimer.current != null) {
      window.clearTimeout(railPeekTimer.current);
      railPeekTimer.current = null;
    }
  }, []);

  const setRailCollapsedPersist = useCallback((collapsed: boolean) => {
    clearRailPeekTimer();
    setRailCollapsed(collapsed);
    setRailPeek(false);
    setRailFoldLock(collapsed);
    persistRailCollapsed(collapsed);
  }, [clearRailPeekTimer]);

  useEffect(() => () => clearRailPeekTimer(), [clearRailPeekTimer]);

  const homeHasMore = homeDefIndex < HOME_DEFS.length;
  const catalogHasMore = catalogPage < Math.min(catalogTotalPages, 40);
  const searching = query.trim().length > 0;

  const browseConfig = useCallback((v: View): { url: string; media: MediaType } | null => {
    if (v === 'catalog') {
      if (catalogFilter) return { url: catalogFilter.url, media: 'tv' };
      return { url: browseUrl('anime', 'tv'), media: 'tv' };
    }
    if (v === 'films') return { url: browseUrl('anime', 'movie'), media: 'movie' };
    if (v === 'airing') {
      return { url: animeAiringBrowseUrl(), media: 'tv' };
    }
    if (v === 'top') {
      const row = HOME_DEFS.find((r) => r.id === 'top');
      return row ? { url: row.fetchUrl, media: 'tv' } : null;
    }
    return null;
  }, [catalogFilter]);

  const loadCatalog = useCallback(async (page: number, append: boolean) => {
    const cfg = browseConfig(view);
    if (!cfg) return;
    if (page === 1 && !append) setCatalogLoading(true);
    else setCatalogLoadingMore(true);
    try {
      const result = await fetchListPage(cfg.url, 'anime', cfg.media, page);
      setCatalogTotalPages(result.totalPages);
      setCatalogPage(result.page);
      setCatalog((prev) => {
        if (!append) return result.items;
        const ids = new Set(prev.map((i) => i.id));
        return [...prev, ...result.items.filter((i) => !ids.has(i.id))];
      });
    } finally {
      setCatalogLoading(false);
      setCatalogLoadingMore(false);
    }
  }, [view, browseConfig]);

  const loadMoreCatalog = useCallback(() => {
    if (catalogLoading || catalogLoadingMore || !catalogHasMore) return;
    void loadCatalog(catalogPage + 1, true);
  }, [catalogLoading, catalogLoadingMore, catalogHasMore, catalogPage, loadCatalog]);

  // Enrich "En cours" cards with last/next episode (TMDB TV details).
  useEffect(() => {
    if (view !== 'airing') return;
    const missing = catalog.filter((c) => !airingPulseCache.current.has(c.id));
    if (!missing.length) return;
    let cancelled = false;
    void (async () => {
      for (let i = 0; i < missing.length; i += 6) {
        if (cancelled) return;
        const chunk = missing.slice(i, i + 6);
        const settled = await Promise.all(
          chunk.map(async (c) => {
            try {
              const pulse = await fetchTvAiringPulse(c.id);
              return [c.id, pulse] as const;
            } catch {
              return [c.id, null] as const;
            }
          }),
        );
        if (cancelled) return;
        const patch: Record<number, AiringPulse> = {};
        for (const [id, pulse] of settled) {
          airingPulseCache.current.set(id, pulse);
          if (pulse) patch[id] = pulse;
        }
        if (Object.keys(patch).length) {
          setAiringPulses((prev) => ({ ...prev, ...patch }));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [view, catalog]);

  useEffect(() => {
    void hydrateSession(setSession, setAuthReady);
    const un = listen<AuthSession | null>('auth-session', (e) => {
      saveSession(e.payload);
      setSession(e.payload);
      setResolveAuthToken(e.payload?.token);
      if (e.payload) syncAccountProfile(e.payload);
      else setActiveProfile(null);
    });
    return () => { void un.then((f) => f()); };
  }, []);

  useEffect(() => {
    setResolveAuthToken(session?.token);
  }, [session?.token]);

  useEffect(() => {
    if (!session) {
      setActiveProfile(null);
      return;
    }
    syncAccountProfile(session);
    const current = getActiveProfile();
    if (current) setActiveProfile(current);
  }, [session]);

  const loadHomeBatch = useCallback(async (from: number, count: number, append: boolean) => {
    const batch = HOME_DEFS.slice(from, from + count);
    if (!batch.length) return;

    if (!append) setHomeLoading(true);
    else setHomeLoadingMore(true);

    try {
      const loaded = await Promise.all(batch.map(async (row) => ({
        id: row.id,
        title: row.title,
        items: await fetchList(row.fetchUrl, 'anime', animeRowMediaType(row.id)),
      })));
      const ready = loaded.filter((r) => r.items.length > 0);
      setRows((prev) => {
        if (!append) return ready;
        const ids = new Set(prev.map((r) => r.id));
        return [...prev, ...ready.filter((r) => !ids.has(r.id))];
      });
      setHomeDefIndex(from + batch.length);
    } finally {
      setHomeLoading(false);
      setHomeLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    setHomeDefIndex(0);
    setRows([]);
    void loadHomeBatch(0, HOME_BATCH, false);
  }, [loadHomeBatch]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [trend, fresh] = await Promise.all([
          fetchAnimeTrending(10),
          fetchNewEpisodeCards(18),
        ]);
        if (cancelled) return;
        setTrending(trend);
        setNewEpisodes(fresh);
      } catch {
        if (!cancelled) {
          setTrending([]);
          setNewEpisodes([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchAnimeSagaCollections({
      onBatch: (list) => {
        if (!cancelled) setSagas(list);
      },
    });
    return () => { cancelled = true; };
  }, []);

  const loadMoreHome = useCallback(() => {
    if (homeLoading || homeLoadingMore || !homeHasMore) return;
    void loadHomeBatch(homeDefIndex, HOME_BATCH, true);
  }, [homeLoading, homeLoadingMore, homeHasMore, homeDefIndex, loadHomeBatch]);

  useEffect(() => {
    if (view === 'history') setHistory(getHistory());
    if (view === 'list') setList(getMyList());
    if (view === 'airing') setHistory(getHistory());
    if (view === 'catalog' || view === 'films' || view === 'airing' || view === 'top') {
      setCatalog([]);
      setCatalogPage(1);
      setCatalogTotalPages(1);
      void loadCatalog(1, false);
    }
  }, [view, loadCatalog, catalogFilter]);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setHits([]); return; }
    const t = setTimeout(() => { void searchTitles(q, 'anime').then(setHits); }, 220);
    return () => clearTimeout(t);
  }, [query]);

  async function openTitle(card: TitleCard) {
    if (isBlockedAnimeId(card.id)) return;
    setQuery('');
    setLang(clampAnimeLang(prefs.lang, card));
    try {
      const d = await fetchDetails(card.id, card.mediaType, 'anime');
      setDetails(d);
      setLang((prev) => clampAnimeLang(prev, d));
      if (d.mediaType === 'tv' && d.seasons[0]) {
        setSeasonPick(d.seasons[0].seasonNumber);
        setEpisodes(await fetchSeason(d.id, d.seasons[0].seasonNumber, d.posterPath || d.backdropPath));
      } else {
        setEpisodes([]);
      }
    } catch {
      /* hentai / missing */
    }
  }

  /** Reprendre row → fiche (not autoplay). Prefer history season on fiche. */
  async function openContinueItem(h: HistoryItem) {
    if (isBlockedAnimeId(h.tmdbId)) return;
    setQuery('');
    setLang(clampAnimeLang(prefs.lang, { title: h.title }));
    try {
      const d = await fetchDetails(h.tmdbId, h.mediaType, 'anime');
      setDetails(d);
      setLang((prev) => clampAnimeLang(prev, d));
      if (d.mediaType === 'tv') {
        const season =
          (h.season && d.seasons.some((s) => s.seasonNumber === h.season) ? h.season : null)
          ?? d.seasons[0]?.seasonNumber
          ?? 1;
        setSeasonPick(season);
        setEpisodes(await fetchSeason(d.id, season, d.posterPath || d.backdropPath));
      } else {
        setEpisodes([]);
      }
    } catch {
      /* hentai / missing */
    }
  }

  function play(d: TitleDetails, season = 1, episode = 1) {
    const s = d.mediaType === 'tv' ? season : 0;
    const e = d.mediaType === 'tv' ? episode : 0;
    if (d.id === details?.id && e) {
      const avail = epLangOf(e, true);
      if (avail && avail.vostfr && !avail.vf) {
        setLang('vostfr');
      } else {
        setLang((prev) => clampAnimeLang(prev, d));
      }
    } else {
      setLang((prev) => clampAnimeLang(prev, d));
    }
    setHistory(pushHistory({
      tmdbId: d.id,
      mediaType: d.mediaType,
      title: d.title,
      posterPath: d.posterPath,
      season: s || undefined,
      episode: e || undefined,
    }));
    setWatch({ details: d, season: s, episode: e });
  }

  async function resumeItem(h: HistoryItem) {
    if (isBlockedAnimeId(h.tmdbId)) return;
    setLang(clampAnimeLang(prefs.lang, { title: h.title }));
    try {
      const d = await fetchDetails(h.tmdbId, h.mediaType, 'anime');
      setLang((prev) => clampAnimeLang(prev, d));
      const season = h.mediaType === 'tv' ? (h.season || d.seasons[0]?.seasonNumber || 1) : 0;
      const episode = h.mediaType === 'tv' ? (h.episode || 1) : 0;
      play(d, season || 1, episode || 1);
    } catch {
      /* hentai / missing */
    }
  }

  const continueItems = useMemo(
    () => getContinueWatching(16).filter((h) => !isBlockedAnimeId(h.tmdbId)),
    [history],
  );

  const heroPool = useMemo(() => {
    const seen = new Set<number>();
    const out: TitleCard[] = [];
    for (const row of rows) {
      for (const item of row.items) {
        if (!item.backdropPath && !item.posterPath) continue;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
        if (out.length >= 10) return out;
      }
    }
    return out;
  }, [rows]);

  const [heroIdx, setHeroIdx] = useState(0);
  const heroPoolKey = heroPool.map((h) => h.id).join(',');

  useEffect(() => {
    setHeroIdx(0);
  }, [heroPoolKey]);

  useEffect(() => {
    if (view !== 'home' || heroPool.length < 2) return;
    const t = window.setInterval(() => {
      setHeroIdx((i) => (i + 1) % heroPool.length);
    }, 10_000);
    return () => window.clearInterval(t);
  }, [view, heroPool.length, heroPoolKey]);

  const hero = heroPool.length ? heroPool[heroIdx % heroPool.length] : null;
  const [heroLogo, setHeroLogo] = useState<string | null>(null);
  const heroLogoCache = useRef<Map<number, string | null>>(new Map());

  // Même logo TMDB stylé que la fiche (fetch details / images).
  useEffect(() => {
    if (!hero) {
      setHeroLogo(null);
      return;
    }
    const cached = heroLogoCache.current.get(hero.id);
    if (cached !== undefined) {
      setHeroLogo(cached);
      return;
    }
    let cancelled = false;
    setHeroLogo(null);
    void fetchDetails(hero.id, hero.mediaType, 'anime')
      .then((d) => {
        const path = d.logoPath || null;
        heroLogoCache.current.set(hero.id, path);
        if (!cancelled) setHeroLogo(path);
      })
      .catch(() => {
        heroLogoCache.current.set(hero.id, null);
        if (!cancelled) setHeroLogo(null);
      });
    return () => { cancelled = true; };
  }, [hero?.id, hero?.mediaType]);

  function go(id: View) {
    setDetails(null);
    setSaga(null);
    setQuery('');
    setSettingsOpen(false);
    if (id === 'catalog') setCatalogFilter(null);
    setView(id);
    mainRef.current?.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }

  function goCatalogFilter(filter: CatalogFilter) {
    setDetails(null);
    setSaga(null);
    setQuery('');
    setSettingsOpen(false);
    setCatalogFilter(filter);
    setView('catalog');
    mainRef.current?.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }

  // Fiche / liste: même <main className="stage"> — sans reset, scroll home reste.
  useEffect(() => {
    if (!details) return;
    mainRef.current?.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [details?.id]);

  if (!authReady) return <AuthSplash />;

  if (!session) {
    return (
      <LoginGate
        productName="Z-Animes"
        tagline="Anime VF / VOSTFR — connecte-toi pour continuer"
        iconSrc="/icon.png"
        accent="#e11d48"
      />
    );
  }

  if (!activeProfile) {
    return (
      <WhoIsWatching
        session={session}
        productName="Z-Animes"
        accent="#e11d48"
        onSelect={setActiveProfile}
        onLogout={() => {
          void invoke('logout_auth');
          saveSession(null);
          setSession(null);
          setActiveProfile(null);
        }}
      />
    );
  }

  if (watch) {
    return (
      <div className="app">
        <div className="title-strip">
          <div className="title-strip-drag" data-tauri-drag-region />
          <WindowControls />
        </div>
        <AnimePlayer
          details={watch.details}
          season={watch.season}
          episode={watch.episode}
          lang={lang}
          autoplayNext={prefs.autoplayNext}
          rememberServer={prefs.rememberServer}
          showAirDates={prefs.showAirDates}
          onLang={(l) => {
            setLang(l);
          }}
          onClose={() => {
            setHistory(getHistory());
            setWatch(null);
            setLang(prefs.lang);
          }}
          onEpisode={(s, e) => setWatch({ ...watch, season: s, episode: e })}
          onProgressSaved={() => setHistory(getHistory())}
        />
      </div>
    );
  }

  return (
    <div className={`app${prefs.reduceMotion ? ' reduce-motion' : ''}${prefs.compactCards ? ' compact-cards' : ''}`}>
      <div className="title-strip">
        <div className="title-strip-drag" data-tauri-drag-region />
        <WindowControls />
      </div>
      <div className="layout">
        <div className={`rail-slot${railCollapsed ? ' is-collapsed' : ''}`}>
        <aside
          className={`rail${railCollapsed ? ' is-collapsed' : ''}${railCollapsed && railPeek ? ' is-peek' : ''}${railFoldLock ? ' is-fold-lock' : ''}`}
          aria-expanded={!railCollapsed || railPeek}
          onMouseEnter={() => {
            if (!railCollapsed) return;
            railHovering.current = true;
            if (railFoldLock) return;
            clearRailPeekTimer();
            setRailPeek(true);
          }}
          onMouseLeave={() => {
            railHovering.current = false;
            setRailFoldLock(false);
            if (!railCollapsed) return;
            clearRailPeekTimer();
            const tick = () => {
              if (railHovering.current) return;
              if (document.activeElement === searchRef.current) return;
              if (document.querySelector('.profile-dropdown')) {
                railPeekTimer.current = window.setTimeout(tick, 200);
                return;
              }
              setRailPeek(false);
            };
            railPeekTimer.current = window.setTimeout(tick, 400);
          }}
        >
          <div className="brand">
            <img src="/icon.png" alt="" />
            <div className="brand-text">
              <strong>Z-ANIMES</strong>
              <em>アニメ</em>
            </div>
            <button
              type="button"
              className="rail-toggle"
              aria-label={railCollapsed ? 'Déplier le menu' : 'Replier le menu'}
              title={railCollapsed ? 'Déplier' : 'Replier'}
              onClick={() => setRailCollapsedPersist(!railCollapsed)}
            >
              <IconRailToggle collapsed={railCollapsed} />
            </button>
          </div>

          <label
            className={`rail-search${searching ? ' on' : ''}`}
            title="Rechercher"
            onClick={() => {
              if (railCollapsed && !railPeek) {
                setRailPeek(true);
                requestAnimationFrame(() => searchRef.current?.focus());
              }
            }}
          >
            <IconSearch />
            <input
              ref={searchRef}
              type="search"
              placeholder="Rechercher…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setDetails(null);
                setSettingsOpen(false);
              }}
              onFocus={() => {
                setDetails(null);
                setSettingsOpen(false);
                if (railCollapsed) setRailPeek(true);
              }}
              onBlur={() => {
                if (!railCollapsed) return;
                window.setTimeout(() => {
                  if (railHovering.current) return;
                  if (document.querySelector('.profile-dropdown')) return;
                  setRailPeek(false);
                }, 400);
              }}
            />
            {searching && (
              <button
                type="button"
                className="rail-search-clear"
                aria-label="Effacer"
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus();
                }}
              >
                ✕
              </button>
            )}
          </label>

          <nav className="rail-nav" aria-label="Principal">
            <NavBtn id="home" view={view} details={!!details} searching={searching} label="Accueil" icon={<IconHome />} onClick={go} />
            <NavBtn id="catalog" view={view} details={!!details} searching={searching} label="Catalogue" icon={<IconGrid />} onClick={go} />
            <NavBtn id="films" view={view} details={!!details} searching={searching} label="Films" icon={<IconFilm />} onClick={go} />
            <NavBtn id="sagas" view={view} details={!!details} searching={searching} label="Sagas" icon={<IconLayers />} onClick={go} />
            <NavBtn id="airing" view={view} details={!!details} searching={searching} label="En cours" icon={<IconLive />} onClick={go} />
            <NavBtn id="top" view={view} details={!!details} searching={searching} label="Top notés" icon={<IconStar />} onClick={go} />
          </nav>
          <div className="nav-sep" />
          <nav className="rail-nav" aria-label="Bibliothèque">
            <NavBtn id="history" view={view} details={!!details} searching={searching} label="Historique" icon={<IconClock />} onClick={go} badge={continueItems.length} />
            <NavBtn id="list" view={view} details={!!details} searching={searching} label="Ma liste" icon={<IconHeart />} onClick={go} badge={list.length} />
          </nav>

          <RailWidgets
            continueItems={continueItems}
            season={currentAnimeSeason()}
            onResume={(h) => void resumeItem(h)}
            onGoAiring={() => go('airing')}
            onGenre={goCatalogFilter}
          />

          <div className="rail-bottom">
            <button
              type="button"
              className="rail-link"
              onClick={() => void openUrl('https://github.com/Apnkk/z-flix-anime/releases')}
            >
              Mises à jour
            </button>
            <div className="rail-footer">
            <div className="rail-user">
              <div className="rail-user-id">
                <ProfileMenu
                  session={session}
                  profile={activeProfile}
                  placement="rail"
                  onSwitchProfile={() => setActiveProfile(null)}
                  onLogout={() => {
                    setSession(null);
                    setActiveProfile(null);
                  }}
                />
                <div className="rail-user-meta">
                  <strong>{activeProfile.name}</strong>
                  <span>Profil</span>
                </div>
              </div>
              <button
                type="button"
                className={`rail-gear${settingsOpen ? ' on' : ''}`}
                aria-label="Paramètres"
                onClick={() => {
                  setDetails(null);
                  setSettingsOpen(true);
                }}
              >
                <IconGear />
              </button>
            </div>
            </div>
          </div>
        </aside>
        </div>

        <main className="stage" ref={mainRef}>
          {settingsOpen ? (
            <SettingsModal
              open
              onClose={() => setSettingsOpen(false)}
              prefs={prefs}
              onChange={(next) => {
                setPrefs(next);
                setLang(next.lang);
              }}
              onClearHistory={() => {
                clearHistory();
                setHistory([]);
              }}
              onClearList={() => {
                clearMyList();
                setList([]);
              }}
            />
          ) : details?.mediaType === 'movie' ? (
            <MovieFiche
              details={details}
              lang={lang}
              inList={inMyList(details.id)}
              canResume={history.some((x) => x.tmdbId === details.id && x.progressSeconds && x.progressSeconds > 15)}
              progressPct={(() => {
                const h = history.find((x) => x.tmdbId === details.id);
                if (!h?.durationSeconds || !h.progressSeconds) return 0;
                return Math.min(100, Math.round((h.progressSeconds / h.durationSeconds) * 100));
              })()}
              onBack={() => { setDetails(null); setLang(prefs.lang); }}
              onLang={setLang}
              onPlay={() => play(details, 0, 0)}
              onToggleList={() => setList(toggleMyList(asListItem(details.id, details.mediaType, details.title, details.posterPath)))}
              onOpenRelated={(c) => void openTitle(c)}
            />
          ) : details ? (
            <section className="fiche">
              <button type="button" className="ghost" onClick={() => { setDetails(null); setLang(prefs.lang); }}>← Retour</button>
              <div className="fiche-hero" style={details.backdropPath || details.posterPath ? { backgroundImage: `url(${getImageUrl(details.backdropPath || details.posterPath, 'w780')})` } : undefined}>
                {(details.posterPath || details.backdropPath) ? (
                  <img className="fiche-poster" src={getImageUrl(details.posterPath || details.backdropPath, 'w342')} alt="" />
                ) : (
                  <div className="fiche-poster fiche-poster-empty" aria-hidden />
                )}
                <div className="fiche-copy">
                  {details.logoPath ? (
                    <img
                      className="fiche-logo"
                      src={getImageUrl(details.logoPath, 'w500')}
                      alt={details.title}
                      draggable={false}
                    />
                  ) : (
                    <h1>{details.title}</h1>
                  )}
                  <div className="fiche-meta">
                    {details.voteAverage > 0 && (
                      <span className="fiche-match">{Math.min(99, Math.round(details.voteAverage * 10))}%</span>
                    )}
                    {details.releaseDate?.slice(0, 4) && <span>{details.releaseDate.slice(0, 4)}</span>}
                    {details.numberOfSeasons ? (
                      <span>
                        {details.numberOfSeasons} Saison{details.numberOfSeasons > 1 ? 's' : ''}
                      </span>
                    ) : null}
                    <span className="fiche-badge">HD</span>
                  </div>
                  {details.tagline ? <p className="fiche-tagline">« {details.tagline} »</p> : null}
                  {details.overview ? <p className="fiche-overview">{details.overview}</p> : null}
                  <TitleLangSwitch item={details} lang={lang} onLang={setLang} />
                  <div className="actions">
                    <button
                      type="button"
                      className="btn cta"
                      onClick={() => {
                        const h = history.find((x) => x.tmdbId === details.id);
                        if (h?.season && h?.episode) {
                          play(details, h.season, h.episode);
                          return;
                        }
                        const list = episodes.length ? episodes : null;
                        const firstAired = list?.find((e) => isEpisodeAired(e, list))?.episodeNumber;
                        if (firstAired != null) {
                          play(details, seasonPick, firstAired);
                          return;
                        }
                        void fetchSeason(details.id, seasonPick, details.posterPath || details.backdropPath).then((eps) => {
                          const n = eps.find((e) => isEpisodeAired(e, eps))?.episodeNumber ?? eps[0]?.episodeNumber ?? 1;
                          play(details, seasonPick, n);
                        });
                      }}
                    >
                      {history.some((x) => x.tmdbId === details.id && x.progressSeconds && x.progressSeconds > 15)
                        ? 'Reprendre'
                        : 'Regarder'}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => setList(toggleMyList(asListItem(details.id, details.mediaType, details.title, details.posterPath)))}>
                      {inMyList(details.id) ? 'Retirer' : '+ Liste'}
                    </button>
                  </div>
                </div>
              </div>
              <div className="season-bar">
                {details.seasons.map((s) => (
                  <button
                    type="button"
                    key={s.seasonNumber}
                    className={seasonPick === s.seasonNumber ? 'on' : ''}
                    onClick={() => { setSeasonPick(s.seasonNumber); void fetchSeason(details.id, s.seasonNumber, details.posterPath || details.backdropPath).then(setEpisodes); }}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
              <div className="ep-grid">
                {episodes.map((ep) => {
                  const aired = isEpisodeAired(ep, episodes);
                  const when = !aired && prefs.showAirDates !== false ? formatEpisodeAirDate(ep.airDate) : '';
                  return (
                    <button
                      type="button"
                      key={ep.episodeNumber}
                      className={`ep-card${aired ? '' : ' upcoming'}`}
                      disabled={!aired}
                      title={aired ? ep.name : (when ? `Diffuse le ${when}` : 'Épisode à venir')}
                      onClick={() => {
                        if (!aired) return;
                        play(details, seasonPick, ep.episodeNumber);
                      }}
                    >
                      <div className="ep-card-thumb">
                        {ep.stillPath ? (
                          <img src={getImageUrl(ep.stillPath, 'w500')} alt="" />
                        ) : (
                          <span className="ep-card-ph" aria-hidden />
                        )}
                        <EpisodeLangFlags avail={epLangOf(ep.episodeNumber, aired)} />
                      </div>
                      <span className="ep-card-num">E{ep.episodeNumber}</span>
                      <b>{aired ? ep.name : 'À venir'}</b>
                      {!aired && when ? <em className="ep-card-date">{when}</em> : null}
                    </button>
                  );
                })}
              </div>
            </section>
          ) : searching ? (
            <section className="magazine search-results">
              <div className="section-head">
                <h2>
                  {hits.length > 0
                    ? `${hits.length} résultat${hits.length > 1 ? 's' : ''}`
                    : 'Recherche'}
                </h2>
                <span className="search-q">« {query.trim()} »</span>
              </div>
              {hits.length > 0 ? (
                <div className="catalog-grid">
                  {hits.map((item) => (
                    <AnimeCard key={item.id} item={item} onOpen={(c) => void openTitle(c)} />
                  ))}
                </div>
              ) : (
                <div className="empty-state"><p>Aucun résultat pour « {query.trim()} »</p></div>
              )}
            </section>
          ) : (
            <>
              {(view === 'home' || view === 'sagas') && saga && (
                <SagaHub
                  saga={saga}
                  onBack={() => {
                    setSaga(null);
                    mainRef.current?.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
                  }}
                  onOpen={(c) => void openTitle(c)}
                />
              )}
              {view === 'home' && !saga && (
                <>
                  {hero && (
                    <section
                      key={hero.id}
                      className="anime-hero"
                      style={{ backgroundImage: `url(${getImageUrl(hero.backdropPath || hero.posterPath, 'original')})` }}
                    >
                      <div className="anime-hero-shade" aria-hidden />
                      <div className="anime-hero-inner">
                        <div className="anime-hero-copy">
                          <div className="anime-hero-kicker">
                            <span className="tag">À la une</span>
                            {hero.voteAverage > 0 && (
                              <span className="anime-hero-meta">★ {hero.voteAverage.toFixed(1)}</span>
                            )}
                            {hero.releaseDate?.slice(0, 4) && (
                              <span className="anime-hero-meta">{hero.releaseDate.slice(0, 4)}</span>
                            )}
                          </div>
                          {heroLogo ? (
                            <img
                              className="anime-hero-logo"
                              src={getImageUrl(heroLogo, 'w500')}
                              alt={hero.title}
                              draggable={false}
                            />
                          ) : (
                            <h1>{hero.title}</h1>
                          )}
                          {hero.overview && (
                            <p>{hero.overview.slice(0, 180)}{hero.overview.length > 180 ? '…' : ''}</p>
                          )}
                          <div className="anime-hero-actions">
                            <button type="button" className="btn cta" onClick={() => void openTitle(hero)}>
                              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                                <path d="M8.2 5.05v13.9a1.1 1.1 0 0 0 1.68.93l11.2-6.95a1.1 1.1 0 0 0 0-1.86L9.88 4.12A1.1 1.1 0 0 0 8.2 5.05Z" />
                              </svg>
                              Regarder
                            </button>
                            <button type="button" className="btn btn-ghost" onClick={() => setList(toggleMyList(asListItem(hero.id, hero.mediaType, hero.title, hero.posterPath)))}>
                              {inMyList(hero.id) ? 'Retirer' : '+ Ma liste'}
                            </button>
                          </div>
                        </div>
                        {hero.posterPath && (
                          <button
                            type="button"
                            className="anime-hero-poster"
                            onClick={() => void openTitle(hero)}
                            aria-label={`Ouvrir ${hero.title}`}
                          >
                            <img src={getImageUrl(hero.posterPath, 'w500')} alt="" draggable={false} />
                          </button>
                        )}
                      </div>
                      {heroPool.length > 1 && (
                        <div className="anime-hero-progress" aria-hidden>
                          <span key={hero.id} />
                        </div>
                      )}
                    </section>
                  )}
                  {continueItems.length > 0 && (
                    <RailTrack title="Reprendre">
                      {continueItems.map((h) => {
                        const pct = h.durationSeconds && h.progressSeconds
                          ? Math.min(100, Math.round((h.progressSeconds / h.durationSeconds) * 100))
                          : 0;
                        return (
                          <AnimeCard
                            key={`cw-${h.tmdbId}-${h.season || 0}-${h.episode || 0}`}
                            item={{
                              id: h.tmdbId,
                              title: h.title,
                              overview: '',
                              posterPath: h.posterPath,
                              backdropPath: null,
                              mediaType: h.mediaType,
                              releaseDate: '',
                              voteAverage: 0,
                              genreIds: [],
                              originCountry: [],
                            }}
                            progressPct={pct}
                            subtitle={
                              h.mediaType === 'tv' && h.season && h.episode
                                ? `S${h.season} · E${h.episode}`
                                : undefined
                            }
                            onOpen={() => void openContinueItem(h)}
                          />
                        );
                      })}
                    </RailTrack>
                  )}
                  {trending.length > 0 && (
                    <RailTrack title="Tendances" kicker="人気" trackClass="trend-track">
                      {trending.map((item, i) => (
                        <AnimeCard
                          key={`tr-${item.id}`}
                          item={item}
                          rank={i + 1}
                          showRating
                          showGenres
                          onOpen={(c) => void openTitle(c)}
                        />
                      ))}
                    </RailTrack>
                  )}
                  {sagas.length > 0 && (
                    <SagasShelf
                      sagas={sagas.slice(0, HOME_SAGA_LIMIT)}
                      onOpen={(s) => {
                        setSaga(s);
                        mainRef.current?.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
                      }}
                    />
                  )}
                  {newEpisodes.length > 0 && (
                    <RailTrack title="Nouveaux épisodes" kicker="新着">
                      {newEpisodes.map((item) => {
                        const langs = inferTitleLangs(item);
                        return (
                          <AnimeCard
                            key={`ne-${item.id}`}
                            item={item}
                            badge={item.lastEpisode ? `Ép. ${item.lastEpisode}` : 'Nouveau'}
                            badgeTone="ep"
                            showPlay
                            hotTitle
                            langLine={formatTitleLangs(langs)}
                            onOpen={(c) => void openTitle(c)}
                          />
                        );
                      })}
                    </RailTrack>
                  )}
                  {rows.filter((row) => !(row.id === 'popular' && trending.length > 0)).map((row) => (
                    <RailTrack key={row.id} title={row.title}>
                      {row.items.slice(0, 18).map((item) => (
                        <AnimeCard key={item.id} item={item} onOpen={(c) => void openTitle(c)} />
                      ))}
                    </RailTrack>
                  ))}
                  <HomeSentinel
                    scrollRoot={mainRef}
                    hasMore={homeHasMore}
                    loadingMore={homeLoadingMore}
                    rowsLen={rows.length}
                    onLoadMore={loadMoreHome}
                  />
                  {homeLoadingMore && (
                    <div className="home-loading-more">
                      <span className="home-spinner" />
                      Chargement…
                    </div>
                  )}
                  {!homeHasMore && rows.length > 0 && (
                    <p className="home-end">Fin des rayons</p>
                  )}
                </>
              )}

              {view === 'sagas' && !saga && (
                <section className="magazine sagas-page">
                  <div className="section-head">
                    <h2>Sagas</h2>
                    {sagas.length > 0 && (
                      <span className="section-count">{sagas.length} franchises</span>
                    )}
                  </div>
                  {sagas.length === 0 ? (
                    <div className="home-loading-more">
                      <span className="home-spinner" />
                      Chargement…
                    </div>
                  ) : (
                    <div className="sagas-page-grid">
                      {sagas.map((s, i) => (
                        <button
                          type="button"
                          key={s.id}
                          className="saga-tile saga-tile-page"
                          aria-label={`${s.title}, ${s.parts.length} titre${s.parts.length > 1 ? 's' : ''}`}
                          onClick={() => {
                            setSaga(s);
                            mainRef.current?.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
                          }}
                        >
                          <span className="saga-num" aria-hidden>{String(i + 1).padStart(2, '0')}</span>
                          <span className="saga-art">
                            {s.backdropPath || s.posterPath ? (
                              <img src={getImageUrl(s.backdropPath || s.posterPath, 'w780')} alt="" loading="lazy" />
                            ) : (
                              <span className="saga-fallback">{s.title}</span>
                            )}
                          </span>
                          <span className="saga-copy">
                            <b>{s.title}</b>
                            <em>{s.parts.length} titre{s.parts.length > 1 ? 's' : ''}</em>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              )}

              {(view === 'catalog' || view === 'films' || view === 'airing' || view === 'top') && (
                <section className="magazine">
                  <div className="section-head">
                    <h2>
                      {view === 'catalog' && (catalogFilter ? catalogFilter.label : 'Catalogue')}
                      {view === 'films' && 'Films animés'}
                      {view === 'airing' && 'En cours'}
                      {view === 'top' && 'Mieux notés'}
                    </h2>
                    {catalog.length > 0 && (
                      <span className="section-count">{catalog.length} titres</span>
                    )}
                  </div>
                  {view === 'airing' && (
                    <p className="section-hint">
                      Séries avec un épisode récent ou à venir — badge + prochain / dernier épisode.
                    </p>
                  )}
                  {catalogLoading && catalog.length === 0 ? (
                    <div className="home-loading-more">
                      <span className="home-spinner" />
                      Chargement…
                    </div>
                  ) : catalog.length === 0 ? (
                    <div className="empty-state">
                      <p>Aucun titre pour {catalogFilter?.label || 'cette catégorie'}.</p>
                    </div>
                  ) : (
                    <>
                      <div className="catalog-grid">
                        {catalog.map((item) => {
                          if (view !== 'airing') {
                            return (
                              <AnimeCard key={item.id} item={item} onOpen={(c) => void openTitle(c)} />
                            );
                          }
                          const pulse = airingPulses[item.id];
                          const badge = pulse ? airingBadge(pulse) : null;
                          const watched = history.find((h) => h.tmdbId === item.id && h.mediaType === 'tv');
                          const resume = watched?.season && watched?.episode
                            ? `Tu: S${watched.season} E${watched.episode}`
                            : '';
                          const airLine = pulse ? airingSubtitle(pulse) : '…';
                          const subtitle = resume ? `${airLine} · ${resume}` : airLine;
                          return (
                            <AnimeCard
                              key={item.id}
                              item={item}
                              onOpen={(c) => void openTitle(c)}
                              badge={badge?.label}
                              badgeTone={badge?.tone}
                              subtitle={subtitle}
                            />
                          );
                        })}
                      </div>
                      <HomeSentinel
                        scrollRoot={mainRef}
                        hasMore={catalogHasMore}
                        loadingMore={catalogLoadingMore}
                        rowsLen={catalog.length}
                        onLoadMore={loadMoreCatalog}
                      />
                      {catalogLoadingMore && (
                        <div className="home-loading-more">
                          <span className="home-spinner" />
                          Chargement…
                        </div>
                      )}
                      {!catalogHasMore && catalog.length > 0 && (
                        <p className="home-end">Fin du catalogue</p>
                      )}
                    </>
                  )}
                </section>
              )}

              {view === 'history' && (
                <section className="magazine">
                  <div className="section-head">
                    <h2>Historique</h2>
                  </div>
                  {history.length > 0 ? (
                    <div className="catalog-grid">
                      {history.filter((h) => !isBlockedAnimeId(h.tmdbId)).map((h) => {
                        const pct = h.durationSeconds && h.progressSeconds
                          ? Math.min(100, Math.round((h.progressSeconds / h.durationSeconds) * 100))
                          : 0;
                        return (
                          <AnimeCard
                            key={`${h.tmdbId}-${h.updatedAt}`}
                            item={{
                              id: h.tmdbId,
                              title: h.title,
                              overview: '',
                              posterPath: h.posterPath,
                              backdropPath: null,
                              mediaType: h.mediaType,
                              releaseDate: '',
                              voteAverage: 0,
                              genreIds: [],
                              originCountry: [],
                            }}
                            progressPct={pct}
                            subtitle={
                              h.mediaType === 'tv' && h.season && h.episode
                                ? `S${h.season} · E${h.episode}`
                                : undefined
                            }
                            onOpen={() => void resumeItem(h)}
                          />
                        );
                      })}
                    </div>
                  ) : (
                    <div className="empty-state"><p>Rien vu récemment.</p></div>
                  )}
                </section>
              )}

              {view === 'list' && (
                <section className="magazine">
                  <div className="section-head">
                    <h2>Ma liste</h2>
                  </div>
                  {list.length > 0 ? (
                    <div className="catalog-grid">
                      {list.filter((h) => !isBlockedAnimeId(h.tmdbId)).map((h) => (
                        <AnimeCard
                          key={h.tmdbId}
                          item={{
                            id: h.tmdbId, title: h.title, overview: '', posterPath: h.posterPath, backdropPath: null,
                            mediaType: h.mediaType, releaseDate: '', voteAverage: 0, genreIds: [], originCountry: [],
                          }}
                          onOpen={(c) => void openTitle(c)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="empty-state"><p>Liste vide — ajoutez des anime depuis une fiche.</p></div>
                  )}
                </section>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function RailWidgets({
  continueItems,
  season,
  onResume,
  onGoAiring,
  onGenre,
}: {
  continueItems: HistoryItem[];
  season: { label: string; year: number };
  onResume: (h: HistoryItem) => void;
  onGoAiring: () => void;
  onGenre: (filter: CatalogFilter) => void;
}) {
  const miniContinue = continueItems.slice(0, 2);

  return (
    <div className="rail-widgets">
      {miniContinue.length > 0 && (
        <section className="rail-block">
          <p className="rail-kicker">Reprendre</p>
          <div className="rail-resume-list">
            {miniContinue.map((h) => {
              const pct = h.durationSeconds && h.progressSeconds
                ? Math.min(100, Math.round((h.progressSeconds / h.durationSeconds) * 100))
                : 0;
              const ep = h.mediaType === 'tv' && h.season && h.episode
                ? `S${h.season} · E${h.episode}`
                : 'Film';
              const poster = getImageUrl(h.posterPath, 'w185');
              return (
                <button
                  key={`rail-cw-${h.tmdbId}-${h.season || 0}-${h.episode || 0}`}
                  type="button"
                  className="rail-resume"
                  aria-label={`Reprendre ${h.title}`}
                  onClick={() => onResume(h)}
                >
                  <span className="rail-resume-poster">
                    {poster ? (
                      <img src={poster} alt="" loading="lazy" />
                    ) : (
                      <span className="rail-resume-fallback" aria-hidden />
                    )}
                    {pct > 0 && (
                      <span className="rail-resume-bar" aria-hidden>
                        <i style={{ width: `${pct}%` }} />
                      </span>
                    )}
                  </span>
                  <span className="rail-resume-copy">
                    <em>{h.title}</em>
                    <small>{ep}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className="rail-block">
        <p className="rail-kicker">Genres</p>
        <div className="rail-genre-grid">
          {RAIL_GENRES.map((g) => (
            <button key={g.label} type="button" className="rail-genre" onClick={() => onGenre(g)}>
              {g.label}
            </button>
          ))}
        </div>
        <button type="button" className="rail-season" onClick={onGoAiring}>
          {season.label} {season.year}
          <span aria-hidden>→</span>
        </button>
      </section>
    </div>
  );
}

function NavBtn({
  id,
  view,
  details,
  searching,
  label,
  icon,
  badge,
  onClick,
}: {
  id: View;
  view: View;
  details: boolean;
  searching: boolean;
  label: string;
  icon: ReactNode;
  badge?: number;
  onClick: (id: View) => void;
}) {
  return (
    <button
      type="button"
      className={`nav-item${view === id && !details && !searching ? ' on' : ''}`}
      title={label}
      aria-label={label}
      onClick={() => onClick(id)}
    >
      {icon}
      <span className="nav-item-label">{label}</span>
      {badge != null && badge > 0 && (
        <span className="nav-badge">{badge > 99 ? '99+' : badge}</span>
      )}
    </button>
  );
}

function RailTrack({
  title,
  kicker,
  trackClass,
  children,
}: {
  title?: string;
  kicker?: string;
  trackClass?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDragScroll(ref, 'x');
  const scroll = (dir: -1 | 1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.min(el.clientWidth * 0.85, 640), behavior: 'smooth' });
  };
  return (
    <section className="magazine">
      {(title || kicker) && (
        <div className="section-head rail-head">
          {kicker ? <span className="section-kicker">{kicker}</span> : null}
          {title ? <h2>{title}</h2> : null}
          <i className="section-line" aria-hidden />
          <div className="section-arrows">
            <button type="button" aria-label="Précédent" onClick={() => scroll(-1)}>
              ‹
            </button>
            <button type="button" aria-label="Suivant" onClick={() => scroll(1)}>
              ›
            </button>
          </div>
        </div>
      )}
      <div className={`magazine-track${trackClass ? ` ${trackClass}` : ''}`} ref={ref}>
        {children}
      </div>
    </section>
  );
}

function SagasShelf({ sagas, onOpen }: { sagas: SagaCollection[]; onOpen: (s: SagaCollection) => void }) {
  if (!sagas.length) return null;
  return (
    <RailTrack title="Sagas" kicker="シリーズ" trackClass="saga-track">
      {sagas.map((s, i) => (
        <button
          type="button"
          key={s.id}
          className="saga-tile"
          aria-label={`${s.title}, ${s.parts.length} titre${s.parts.length > 1 ? 's' : ''}`}
          onClick={() => onOpen(s)}
        >
          <span className="saga-num" aria-hidden>{String(i + 1).padStart(2, '0')}</span>
          <span className="saga-art">
            {s.backdropPath || s.posterPath ? (
              <img
                src={getImageUrl(s.backdropPath || s.posterPath, 'w780')}
                alt=""
                loading="lazy"
                draggable={false}
              />
            ) : (
              <span className="saga-fallback">{s.title}</span>
            )}
          </span>
          <span className="saga-copy">
            <b>{s.title}</b>
            <em>{s.parts.length} titre{s.parts.length > 1 ? 's' : ''}</em>
          </span>
        </button>
      ))}
    </RailTrack>
  );
}

function SagaHub({
  saga,
  onBack,
  onOpen,
}: {
  saga: SagaCollection;
  onBack: () => void;
  onOpen: (c: TitleCard) => void;
}) {
  const art = saga.backdropPath || saga.posterPath;
  const blurb = saga.overview.trim();
  const n = saga.parts.length;

  return (
    <section className="saga-hub">
      <button type="button" className="ghost saga-hub-back" onClick={onBack}>← Retour</button>
      <div
        className="saga-hub-hero"
        style={art ? { backgroundImage: `url(${getImageUrl(art, 'original')})` } : undefined}
      >
        <div className="saga-hub-fade" aria-hidden />
        <div className="saga-hub-copy">
          <p className="saga-hub-kicker">Saga</p>
          <h1>{saga.title}</h1>
          <p className="saga-hub-count">
            {n} titre{n > 1 ? 's' : ''} · ordre de visionnage
          </p>
          {blurb ? (
            <p className="saga-hub-blurb">{blurb.length > 280 ? `${blurb.slice(0, 280)}…` : blurb}</p>
          ) : null}
        </div>
      </div>
      <ol className="saga-parts">
        {saga.parts.map((part, i) => {
          const year = part.releaseDate?.slice(0, 4);
          const kind = part.mediaType === 'movie' ? 'Film' : 'Série';
          return (
            <li key={`${part.mediaType}-${part.id}`}>
              <button type="button" className="saga-part" onClick={() => onOpen(part)}>
                <span className="saga-part-num" aria-hidden>{String(i + 1).padStart(2, '0')}</span>
                <span className="saga-part-poster">
                  {part.posterPath ? (
                    <img src={getImageUrl(part.posterPath, 'w342')} alt="" loading="lazy" draggable={false} />
                  ) : (
                    <span className="saga-fallback">{part.title}</span>
                  )}
                </span>
                <span className="saga-part-copy">
                  <b>{part.title}</b>
                  <em>{[year, kind].filter(Boolean).join(' · ')}</em>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function HomeSentinel({
  scrollRoot,
  hasMore,
  loadingMore,
  rowsLen,
  onLoadMore,
}: {
  scrollRoot: RefObject<HTMLElement | null>;
  hasMore: boolean;
  loadingMore: boolean;
  rowsLen: number;
  onLoadMore: () => void;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = scrollRoot.current;
    const target = sentinelRef.current;
    if (!root || !target || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingMore) onLoadMore();
      },
      { root, rootMargin: '420px', threshold: 0 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [scrollRoot, onLoadMore, rowsLen, hasMore, loadingMore]);

  return <div ref={sentinelRef} className="home-sentinel" aria-hidden />;
}

function AnimeCard({
  item,
  onOpen,
  progressPct,
  subtitle,
  badge,
  badgeTone = 'neutral',
  rank,
  showRating,
  showGenres,
  showPlay,
  hotTitle,
  langLine,
}: {
  item: TitleCard;
  onOpen: (c: TitleCard) => void;
  progressPct?: number;
  subtitle?: string;
  badge?: string;
  badgeTone?: 'new' | 'soon' | 'live' | 'neutral' | 'ep';
  rank?: number;
  showRating?: boolean;
  showGenres?: boolean;
  showPlay?: boolean;
  hotTitle?: boolean;
  langLine?: string;
}) {
  const genres = showGenres ? genreLabels(item.genreIds) : [];
  const rated = showRating && item.voteAverage > 0;
  const sub = langLine || subtitle;
  return (
    <button
      type="button"
      className={`mag-card${rank ? ' trend-card' : ''}${hotTitle ? ' hot-title' : ''}`}
      onClick={() => onOpen(item)}
    >
      <div className="mag-card-stage">
        {rank != null && (
          <span
            className={`trend-rank${rank <= 3 ? ' trend-rank-top' : ''}${rank >= 10 ? ' trend-rank-wide' : ''}`}
            aria-hidden
          >
            {rank}
          </span>
        )}
        <div className="mag-card-frame">
          {item.posterPath && <img src={getImageUrl(item.posterPath, 'w342')} alt={item.title} loading="lazy" draggable={false} />}
          {rated && (
            <span className="mag-card-rating">★ {item.voteAverage.toFixed(1)}</span>
          )}
          {badge && (
            <span className={`mag-card-badge ${badgeTone}`}>{badge}</span>
          )}
          <TitleLangFlags item={item} />
          {showPlay && (
            <span className="mag-card-play" aria-hidden>
              <span className="mag-card-play-corner">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                  <path d="M8.2 5.05v13.9a1.1 1.1 0 0 0 1.68.93l11.2-6.95a1.1 1.1 0 0 0 0-1.86L9.88 4.12A1.1 1.1 0 0 0 8.2 5.05Z" />
                </svg>
              </span>
              <span className="mag-card-play-cta">Lire</span>
            </span>
          )}
          {typeof progressPct === 'number' && progressPct > 0 && (
            <div className="mag-card-progress" aria-hidden>
              <span style={{ width: `${progressPct}%` }} />
            </div>
          )}
        </div>
      </div>
      <span>{item.title}</span>
      {sub && <em className="mag-card-sub">{sub}</em>}
      {genres.length > 0 && (
        <em className="mag-card-genres">{genres.join(' · ')}</em>
      )}
    </button>
  );
}

function IconRailToggle({ collapsed }: { collapsed: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {collapsed ? <path d="M9 6l6 6-6 6" /> : <path d="M15 6l-6 6 6 6" />}
    </svg>
  );
}

function IconHome() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20h14V9.5" />
    </svg>
  );
}

function IconGrid() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function IconFilm() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
    </svg>
  );
}

function IconLayers() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2 3 7l9 5 9-5-9-5Z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </svg>
  );
}

function IconLive() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  );
}

function IconStar() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m12 3 2.6 5.6 6.2.7-4.6 4.2 1.3 6.1L12 16.8 6.5 19.6l1.3-6.1L3.2 9.3l6.2-.7L12 3z" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function IconClock() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
    </svg>
  );
}

function IconHeart() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.6.9 1 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}
