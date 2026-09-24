import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
  asRaceHit,
  buildSources,
  classifyBetter,
  clearStickyAnimePlayer,
  cancelPrefetch,
  fetchSeason,
  getActiveProfile,
  getImageUrl,
  getStickyAnimePlayer,
  isAnimeVoCapable,
  isAttachableStreamUrl,
  isDecoyStreamDuration,
  isDecoyStreamUrl,
  isEpisodeAired,
  formatEpisodeAirDate,
  isHls,
  isSamePlayer,
  isWrongRuntimeDuration,
  readWatchProgress,
  consumePrefetch,
  episodePrefetchKey,
  resolveRace,
  resolveStickyFirst,
  resolveSource,
  resumeSeconds,
  sanitizePlayerError,
  setStickyAnimePlayer,
  startPrefetch,
  writeWatchProgress,
  type AnimeLang,
  type BetterReason,
  type EpisodeInfo,
  type StreamReader,
  type StreamSource,
  type TitleDetails,
} from '@zflix/desktop-core';
import { loadAnimePrefs, saveAnimePrefs, type AnimeQuality } from '../animePrefs';
import { EpisodeLangFlags, TitleLangSwitch, useEpisodeLangResolver } from './LangFlags';
import { useDragScroll } from '../dragScroll';

interface Props {
  details: TitleDetails;
  season: number;
  episode: number;
  lang: AnimeLang;
  autoplayNext: boolean;
  rememberServer?: boolean;
  showAirDates?: boolean;
  onLang: (l: AnimeLang) => void;
  onClose: () => void;
  onEpisode: (season: number, episode: number) => void;
  onProgressSaved?: () => void;
}

type ProbeState = 'idle' | 'checking' | 'ok' | 'fail';

interface ProbeInfo {
  state: ProbeState;
  ms?: number;
  url?: string;
  /** Extra lecteurs from same source (Anime-Sama LECTEUR 2/3…). */
  alternates?: string[];
  /** Detailed multi-lecteur entries (Lecteur 1, Lecteur 2...). */
  readers?: StreamReader[];
  activeReaderIndex?: number;
  hoster?: string;
  /** Hosters already tried on Anime-Sama (skipHost re-resolve). */
  skipHosts?: string[];
  error?: string;
  quality?: number;
}

const QUALITY_OPTS: AnimeQuality[] = ['auto', '1080', '720', '480'];
const VOSTFR_MISS = 'Aucun flux VOSTFR (audio japonais) trouvé. Les serveurs VF ne sont pas utilisés.';
const EP_SWITCH_DEBOUNCE_MS = 220;

function fmt(t: number) {
  if (!isFinite(t) || t < 0) return '0:00';
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return h > 0
    ? `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`
    : `${m}:${s < 10 ? '0' : ''}${s}`;
}

function qualityBtnLabel(q: AnimeQuality): string {
  return q === 'auto' ? 'Auto' : `${q}p`;
}

function canPlayEarly(source: StreamSource, lang: AnimeLang): boolean {
  if (lang === 'vostfr') {
    if (source.audioLang) return source.audioLang === 'vostfr';
    return isAnimeVoCapable(source.playerId);
  }
  return true;
}

function sourceLangBadge(source: StreamSource, lang: AnimeLang): 'vf' | 'vostfr' {
  if (source.audioLang) return source.audioLang;
  return lang === 'vostfr' && isAnimeVoCapable(source.playerId) ? 'vostfr' : 'vf';
}

function switchOfferCopy(label: string, reason: BetterReason): string {
  if (reason === 'quality') return `${label} — meilleure qualité`;
  if (reason === 'both') return `${label} plus rapide / meilleure qualité`;
  return `${label} plus rapide`;
}

type SwitchOffer = {
  source: StreamSource;
  url: string;
  quality?: number;
  ms?: number;
  reason: BetterReason;
};

function levelHeight(level: { height?: number; bitrate?: number }): number {
  if (level.height && level.height > 0) return level.height;
  const br = level.bitrate || 0;
  if (br >= 4_500_000) return 1080;
  if (br >= 2_000_000) return 720;
  if (br >= 800_000) return 480;
  if (br > 0) return 360;
  return 0;
}

function codecBlob(level: { videoCodec?: string; codecSet?: string }): string {
  return `${level.videoCodec || ''} ${level.codecSet || ''}`.toLowerCase();
}

function isHevcOrAv1Codec(blob: string): boolean {
  return /hvc1|hev1|hevc|\bhvc\b|av01|\bav1\b/.test(blob);
}

function isAvcCodec(blob: string): boolean {
  return /avc1|avc3|\bavc\b/.test(blob) && !isHevcOrAv1Codec(blob);
}

/** Prefer H.264 when a master lists HEVC/AV1 too (WebView2 often has no HEVC decoder). */
function pickAvcHlsLevel(hls: Hls, pref: AnimeQuality): number {
  const avc = hls.levels
    .map((l, i) => ({ i, h: levelHeight(l), ok: isAvcCodec(codecBlob(l)) }))
    .filter((x) => x.ok);
  if (!avc.length) return -1;
  if (pref === 'auto') return avc.sort((a, b) => b.h - a.h)[0].i;
  const target = Number(pref);
  const under = avc.filter((x) => x.h > 0 && x.h <= target + 40);
  if (under.length) return under.sort((a, b) => b.h - a.h)[0].i;
  return avc.sort((a, b) => a.h - b.h)[0].i;
}

/** Pick HLS level index for preferred max height (-1 = auto). */
function pickHlsLevel(hls: Hls, pref: AnimeQuality): number {
  if (pref === 'auto' || !hls.levels?.length) return -1;
  const target = Number(pref);
  let best = -1;
  let bestH = -1;
  for (let i = 0; i < hls.levels.length; i++) {
    const h = levelHeight(hls.levels[i]);
    if (h > 0 && h <= target && h >= bestH) {
      bestH = h;
      best = i;
    }
  }
  if (best >= 0) return best;
  // All levels above target — pick lowest
  let minH = Infinity;
  let minI = 0;
  for (let i = 0; i < hls.levels.length; i++) {
    const h = levelHeight(hls.levels[i]) || Infinity;
    if (h < minH) {
      minH = h;
      minI = i;
    }
  }
  return minI;
}

function applyHlsQuality(hls: Hls, pref: AnimeQuality) {
  const hasHardCodec = hls.levels.some((l) => isHevcOrAv1Codec(codecBlob(l)));
  const avcIdx = pickAvcHlsLevel(hls, pref);
  // Mixed HEVC+AVC: lock AVC so ABR cannot hop back to a black HEVC rendition.
  if (hasHardCodec && avcIdx >= 0) {
    const cap = pref === 'auto' ? (levelHeight(hls.levels[avcIdx]) || -1) : Number(pref);
    hls.autoLevelCapping = cap;
    hls.currentLevel = avcIdx;
    hls.nextLevel = avcIdx;
    hls.loadLevel = avcIdx;
    return;
  }
  if (pref === 'auto') {
    hls.autoLevelCapping = -1;
    hls.currentLevel = -1;
    hls.nextLevel = -1;
    hls.loadLevel = -1;
    return;
  }
  const idx = pickHlsLevel(hls, pref);
  hls.autoLevelCapping = Number(pref);
  hls.currentLevel = idx;
  hls.nextLevel = idx;
  hls.loadLevel = idx;
}

function hlsHasSelectableLevels(hls: Hls, pref: AnimeQuality): boolean {
  if (!hls.levels?.length) return false;
  if (pref === 'auto') return true;
  if (hls.levels.length <= 1) {
    const only = levelHeight(hls.levels[0]);
    // Single rendition — only "works" if it already matches the pick.
    return only > 0 && only <= Number(pref) + 40;
  }
  return true;
}

export function AnimePlayer({
  details,
  season,
  episode,
  lang,
  autoplayNext,
  rememberServer = true,
  showAirDates = true,
  onLang,
  onClose,
  onEpisode,
  onProgressSaved,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const seekRef = useRef<HTMLDivElement>(null);
  const seekDragRef = useRef(false);
  const hlsRef = useRef<Hls | null>(null);
  const hideTimer = useRef<number | null>(null);
  const epStripRef = useRef<HTMLDivElement>(null);
  const probeCache = useRef<Record<string, ProbeInfo>>({});
  const loadGen = useRef(0);
  const resolveAbortRef = useRef<AbortController | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const attachGen = useRef(0);
  const sourcesRef = useRef<StreamSource[]>([]);
  const langRef = useRef<AnimeLang>(lang);
  const expectRuntimeRef = useRef<number | undefined>(undefined);
  /** True while first stream died and we wait for other servers still resolving. */
  const waitingFailoverRef = useRef(false);
  const resumeAppliedRef = useRef<string | null>(null);
  const lastSaveAtRef = useRef(0);
  /** Apply this quality once HLS manifest is ready (after variant switch). */
  const pendingQualityRef = useRef<AnimeQuality | null>(null);
  const qualitySeekRef = useRef(0);
  const qualityPrefRef = useRef<AnimeQuality>(loadAnimePrefs().preferredQuality);
  const epKeyRef = useRef(`${details.id}:${season}:${episode}`);
  epKeyRef.current = `${details.id}:${season}:${episode}`;
  const detailsRef = useRef(details);
  detailsRef.current = details;

  useDragScroll(epStripRef, 'x');

  const [sources, setSources] = useState<StreamSource[]>([]);
  const [active, setActive] = useState<StreamSource | null>(null);
  const [status, setStatus] = useState('Recherche source…');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [showUi, setShowUi] = useState(true);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [serversOpen, setServersOpen] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probes, setProbes] = useState<Record<string, ProbeInfo>>({});
  const [episodes, setEpisodes] = useState<EpisodeInfo[]>([]);
  const [epsLoading, setEpsLoading] = useState(false);
  /** Season shown in the strip — browse only, does not start playback. */
  const [browseSeason, setBrowseSeason] = useState(season);
  const epLangOf = useEpisodeLangResolver(details, browseSeason);
  const [hoverPct, setHoverPct] = useState<number | null>(null);
  const [seekDragging, setSeekDragging] = useState(false);
  const [scanHint, setScanHint] = useState('Recherche du meilleur flux…');
  const [qualityPref, setQualityPref] = useState<AnimeQuality>(() => loadAnimePrefs().preferredQuality);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [readersOpen, setReadersOpen] = useState(false);
  const [hlsHeights, setHlsHeights] = useState<number[]>([]);
  /** Quality menu only after race finished + stream playing. */
  const [raceDone, setRaceDone] = useState(false);
  const [switchOffer, setSwitchOffer] = useState<SwitchOffer | null>(null);
  const playedIdRef = useRef<string | null>(null);
  const playStartedAtRef = useRef(0);

  const minEp = episodes.length
    ? Math.min(...episodes.map((e) => e.episodeNumber))
    : 1;
  const progress = duration > 0 ? (current / duration) * 100 : 0;
  const isTv = details.mediaType === 'tv';
  const currentEp = episodes.find((e) => e.episodeNumber === episode);
  const qualityUnlocked = raceDone && !!active && !loading && !error;

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = volume;
    v.muted = muted;
  }, [volume, muted]);

  sourcesRef.current = sources;
  langRef.current = lang;
  qualityPrefRef.current = qualityPref;
  expectRuntimeRef.current = details.mediaType === 'movie'
    ? details.runtime
    : currentEp?.runtime;

  const bumpUi = useCallback(() => {
    setShowUi(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) setShowUi(false);
    }, 3000);
  }, []);

  const attach = useCallback((url: string) => {
    const video = videoRef.current;
    if (!video) return;
    const gen = ++attachGen.current;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
    setCurrent(0);
    setDuration(0);
    setBuffered(0);
    setHlsHeights([]);
    setPlaying(false);
    setLoading(true);
    setError(null);

    const silentSwitch = (reason: string) => {
      if (gen !== attachGen.current) return;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      const failedId = activeIdRef.current;

      // Same source first: Anime-Sama / FR-Anime may expose several LECTEUR — try next before leaving provider.
      if (failedId) {
        const cur = probeCache.current[failedId];
        const readers = cur?.readers || [];
        const curReaderIdx = cur?.activeReaderIndex ?? 0;
        if (readers.length > curReaderIdx + 1) {
          const nextReader = readers[curReaderIdx + 1];
          probeCache.current[failedId] = {
            ...cur,
            state: 'ok',
            url: nextReader.url,
            activeReaderIndex: curReaderIdx + 1,
            hoster: nextReader.hoster || cur?.hoster,
            quality: nextReader.quality || cur?.quality,
            error: undefined,
          };
          setProbes({ ...probeCache.current });
          setScanHint('');
          setLoading(true);
          setError(null);
          const srcLabel = sourcesRef.current.find((s) => s.playerId === failedId)?.label || '';
          setStatus(`${srcLabel} · ${nextReader.label}`);
          attach(nextReader.url);
          return;
        }

        const alts = cur?.alternates?.filter(Boolean) || [];
        if (alts.length) {
          const [nextUrl, ...rest] = alts;
          probeCache.current[failedId] = {
            ...cur,
            state: 'ok',
            url: nextUrl,
            alternates: rest,
            error: undefined,
          };
          setProbes({ ...probeCache.current });
          setScanHint('');
          setLoading(true);
          setError(null);
          attach(nextUrl);
          return;
        }

        // No more pre-extracted alts — for Tango, re-resolve skipping failed hoster(s).
        if (failedId === 'animesama') {
          const src = sourcesRef.current.find((s) => s.playerId === 'animesama');
          const skip = [...(cur?.skipHosts || [])];
          if (cur?.hoster && !skip.includes(cur.hoster)) skip.push(cur.hoster);
          if (src && skip.length < 6) {
            const joiner = src.resolveUrl.includes('?') ? '&' : '?';
            const nextSrc = {
              ...src,
              resolveUrl: `${src.resolveUrl}${joiner}skipHost=${encodeURIComponent(skip.join(','))}`,
            };
            void resolveSource(nextSrc, 14000)
              .then((stream) => {
                if (gen !== attachGen.current) return;
                probeCache.current[failedId] = {
                  state: 'ok',
                  url: stream.url,
                  alternates: stream.alternates,
                  hoster: stream.hoster,
                  skipHosts: skip,
                  quality: stream.quality,
                };
                setProbes({ ...probeCache.current });
                setScanHint('');
                setLoading(true);
                setError(null);
                attach(stream.url);
              })
              .catch(() => {
                if (gen !== attachGen.current) return;
                probeCache.current[failedId] = {
                  ...(cur || { state: 'fail' }),
                  state: 'fail',
                  error: reason,
                  url: undefined,
                  alternates: undefined,
                  skipHosts: skip,
                };
                setProbes({ ...probeCache.current });
                const pickNext = () =>
                  sourcesRef.current.find((s) => {
                    if (s.playerId === failedId) return false;
                    if (!canPlayEarly(s, langRef.current)) return false;
                    const p = probeCache.current[s.playerId];
                    if (p?.state !== 'ok' || !p.url) return false;
                    if (isDecoyStreamUrl(p.url)) {
                      probeCache.current[s.playerId] = {
                        ...p,
                        state: 'fail',
                        error: 'FSTREAM intro',
                        url: undefined,
                      };
                      return false;
                    }
                    return true;
                  });
                const nxt = pickNext();
                if (nxt) {
                  const nextUrl = probeCache.current[nxt.playerId]?.url;
                  if (nextUrl) {
                    activeIdRef.current = nxt.playerId;
                    setActive(nxt);
                    setStatus(nxt.label);
                    setScanHint('');
                    setLoading(true);
                    setError(null);
                    attach(nextUrl);
                    return;
                  }
                }
                // Wait for other servers still resolving — don't abort race early.
                waitingFailoverRef.current = true;
                setScanHint('Autre serveur…');
                setLoading(true);
                setError(null);
                const deadline = Date.now() + 16000;
                const poll = () => {
                  if (gen !== attachGen.current) {
                    waitingFailoverRef.current = false;
                    return;
                  }
                  const later = pickNext();
                  if (later) {
                    const u = probeCache.current[later.playerId]?.url;
                    if (u) {
                      waitingFailoverRef.current = false;
                      activeIdRef.current = later.playerId;
                      setActive(later);
                      setStatus(later.label);
                      setScanHint('');
                      setLoading(true);
                      setError(null);
                      attach(u);
                      return;
                    }
                  }
                  const still = sourcesRef.current.some(
                    (s) => s.playerId !== failedId
                      && canPlayEarly(s, langRef.current)
                      && probeCache.current[s.playerId]?.state === 'checking',
                  );
                  if (still && Date.now() < deadline) {
                    window.setTimeout(poll, 350);
                    return;
                  }
                  waitingFailoverRef.current = false;
                  setError(reason);
                  setLoading(false);
                  setScanHint('');
                };
                window.setTimeout(poll, 350);
              });
            return;
          }
        }

        probeCache.current[failedId] = {
          ...(cur || { state: 'fail' }),
          state: 'fail',
          error: reason,
          url: undefined,
          alternates: undefined,
        };
        setProbes({ ...probeCache.current });
      }

      const pickNext = () =>
        sourcesRef.current.find((s) => {
          if (s.playerId === failedId) return false;
          if (!canPlayEarly(s, langRef.current)) return false;
          const p = probeCache.current[s.playerId];
          if (p?.state !== 'ok' || !p.url) return false;
          // Skip cached FSTREAM troll URLs
          if (isDecoyStreamUrl(p.url)) {
            probeCache.current[s.playerId] = { ...p, state: 'fail', error: 'FSTREAM intro', url: undefined };
            return false;
          }
          return true;
        });

      const go = (s: StreamSource) => {
        const nextUrl = probeCache.current[s.playerId]?.url;
        if (!nextUrl) return false;
        activeIdRef.current = s.playerId;
        setStickyAnimePlayer(s.playerId);
        setActive(s);
        setStatus(s.label);
        // Keep UI quiet — just a normal spinner, no "intro" text
        setScanHint('');
        setLoading(true);
        setError(null);
        attach(nextUrl);
        return true;
      };

      const next = pickNext();
      if (next && go(next)) return;

      // Still probing other servers — keep spinner and poll until one OK or all done.
      const deadline = Date.now() + 16000;
      waitingFailoverRef.current = true;
      setScanHint('Autre serveur…');
      setLoading(true);
      setError(null);

      const poll = () => {
        if (gen !== attachGen.current) {
          waitingFailoverRef.current = false;
          return;
        }
        const later = pickNext();
        if (later && go(later)) {
          waitingFailoverRef.current = false;
          return;
        }
        const stillChecking = sourcesRef.current.some((s) => {
          if (s.playerId === failedId) return false;
          if (!canPlayEarly(s, langRef.current)) return false;
          return probeCache.current[s.playerId]?.state === 'checking';
        });
        if (stillChecking && Date.now() < deadline) {
          window.setTimeout(poll, 350);
          return;
        }
        waitingFailoverRef.current = false;
        setError(langRef.current === 'vostfr' ? VOSTFR_MISS : sanitizePlayerError('Aucun flux valide'));
        setLoading(false);
        setScanHint('');
        if (failedId === 'frenchanime') clearStickyAnimePlayer();
      };
      window.setTimeout(poll, 350);
    };

    const failover = (msg: string) => {
      // Hard failures (network / unreadable) — still silent switch when possible
      silentSwitch(msg);
    };

    let pictureTimer: number | null = null;
    const stopPictureWatch = () => {
      if (pictureTimer != null) {
        window.clearInterval(pictureTimer);
        pictureTimer = null;
      }
    };
    /** Audio plays, video stays 0×0 → HEVC/AV1 not decoded (no HEVC Video Extensions). */
    const startPictureWatch = () => {
      stopPictureWatch();
      let ticks = 0;
      pictureTimer = window.setInterval(() => {
        if (gen !== attachGen.current) {
          stopPictureWatch();
          return;
        }
        const v = videoRef.current;
        if (!v || v.paused) return;
        if (v.videoWidth > 0 && v.videoHeight > 0) {
          stopPictureWatch();
          return;
        }
        if (!Number.isFinite(v.currentTime) || v.currentTime < 1.25) return;
        ticks += 1;
        if (ticks < 3) return;
        stopPictureWatch();
        const hls = hlsRef.current;
        if (hls?.levels?.length) {
          const avcIdx = pickAvcHlsLevel(hls, 'auto');
          if (avcIdx >= 0 && hls.currentLevel !== avcIdx) {
            hls.currentLevel = avcIdx;
            hls.nextLevel = avcIdx;
            hls.loadLevel = avcIdx;
            setStatus('Piste H.264');
            startPictureWatch();
            return;
          }
        }
        silentSwitch('vidéo noire (codec)');
      }, 700);
    };

    let skipArmed = false;
    const trySkipOrSwitch = (reportedDur?: number) => {
      if (gen !== attachGen.current || skipArmed) return;
      const dur = Number.isFinite(reportedDur) ? (reportedDur as number) : video.duration;
      const wrongRuntime = isWrongRuntimeDuration(dur, expectRuntimeRef.current);
      const shortDecoy = isDecoyStreamDuration(dur, expectRuntimeRef.current);
      if (!wrongRuntime && !shortDecoy) return;
      skipArmed = true;
      video.removeEventListener('loadedmetadata', onMeta);

      // Wrong content (movie instead of episode) — switch server immediately.
      if (wrongRuntime) {
        silentSwitch('mauvais contenu');
        return;
      }

      // Skip bumper first — if real content sits behind / duration grows, keep it.
      try {
        if (Number.isFinite(dur) && dur > 1) {
          video.currentTime = Math.max(0, dur - 0.35);
        }
      } catch { /* ignore */ }
      void video.play().catch(() => undefined);

      window.setTimeout(() => {
        if (gen !== attachGen.current) return;
        const now = video.duration;
        if (isWrongRuntimeDuration(now, expectRuntimeRef.current)) {
          silentSwitch('mauvais contenu');
          return;
        }
        if (isDecoyStreamDuration(now, expectRuntimeRef.current)) {
          silentSwitch('short');
        }
      }, 500);
    };

    const onMeta = () => {
      if (gen !== attachGen.current) return;
      trySkipOrSwitch(video.duration);
      if (skipArmed) return;
      const seekQ = qualitySeekRef.current;
      if (seekQ > 1 && Number.isFinite(video.duration) && seekQ < video.duration - 1) {
        qualitySeekRef.current = 0;
        try {
          video.currentTime = seekQ;
        } catch { /* ignore */ }
        return;
      }
      const key = epKeyRef.current;
      if (resumeAppliedRef.current === key) return;
      resumeAppliedRef.current = key;
      const profile = getActiveProfile();
      if (!profile) return;
      const parts = key.split(':');
      const tmdb = Number(parts[0]);
      const sa = Number(parts[1]) || 0;
      const ep = Number(parts[2]) || 0;
      const saved = readWatchProgress(profile.id, tmdb, sa, ep);
      const at = resumeSeconds(saved?.progressSeconds || 0, saved?.durationSeconds || video.duration);
      if (at > 0 && Number.isFinite(video.duration) && at < video.duration - 20) {
        try {
          video.currentTime = at;
        } catch { /* ignore */ }
      }
    };
    video.addEventListener('loadedmetadata', onMeta);

    const stallWatch = window.setTimeout(() => {
      if (gen !== attachGen.current) return;
      const v = videoRef.current;
      if (!v) return;
      if ((v.currentTime || 0) >= 0.45) return;
      silentSwitch('flux bloqué (buffer)');
    }, 9500);
    const clearStall = () => window.clearTimeout(stallWatch);
    const onUnstall = () => {
      if (gen !== attachGen.current) return;
      if ((video.currentTime || 0) >= 0.35) {
        clearStall();
        video.removeEventListener('playing', onUnstall);
        video.removeEventListener('timeupdate', onUnstall);
      }
    };
    video.addEventListener('playing', onUnstall);
    video.addEventListener('timeupdate', onUnstall);

    if (isHls(url) && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        maxBufferLength: 30,
        fragLoadingTimeOut: 8000,
        manifestLoadingTimeOut: 6000,
        videoPreference: { videoCodec: 'avc1' },
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (gen !== attachGen.current) return;
        const dur = video.duration;
        if (
          Number.isFinite(dur) &&
          dur > 0 &&
          (isWrongRuntimeDuration(dur, expectRuntimeRef.current) ||
            isDecoyStreamDuration(dur, expectRuntimeRef.current))
        ) {
          trySkipOrSwitch(dur);
          return;
        }
        const heights = hls.levels
          .map((l) => levelHeight(l))
          .filter((h) => h > 0)
          .sort((a, b) => b - a);
        setHlsHeights([...new Set(heights)]);
        const pending = pendingQualityRef.current;
        pendingQualityRef.current = null;
        if (pending && pending !== 'auto' && !hlsHasSelectableLevels(hls, pending)) {
          setQualityPref('auto');
          saveAnimePrefs({ ...loadAnimePrefs(), preferredQuality: 'auto' });
          applyHlsQuality(hls, 'auto');
          setStatus(`${pending}p indisponible — retour Auto`);
        } else {
          applyHlsQuality(hls, pending || qualityPrefRef.current || 'auto');
        }
        setLoading(false);
        const seekAt = qualitySeekRef.current;
        qualitySeekRef.current = 0;
        if (seekAt > 1 && Number.isFinite(video.duration) && seekAt < video.duration - 1) {
          try {
            video.currentTime = seekAt;
          } catch { /* ignore */ }
        }
        void video.play().catch(() => undefined);
        startPictureWatch();
      });
      hls.on(Hls.Events.LEVEL_LOADED, (_, data) => {
        if (gen !== attachGen.current) return;
        const total = data.details?.totalduration;
        if (typeof total === 'number') trySkipOrSwitch(total);
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (gen !== attachGen.current) return;
        if (data.fatal && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          try {
            hls.recoverMediaError();
            return;
          } catch { /* fall through to failover */ }
        }
        if (!data.fatal) return;
        video.removeEventListener('loadedmetadata', onMeta);
        failover(data.type === 'networkError' ? 'Erreur réseau du flux' : 'Flux HLS illisible');
      });
      hlsRef.current = hls;
    } else {
      video.src = url;
      const onErr = () => {
        video.removeEventListener('error', onErr);
        video.removeEventListener('loadedmetadata', onMeta);
        failover('Flux illisible');
      };
      video.addEventListener('error', onErr, { once: true });
      void video.play().catch(() => undefined);
      startPictureWatch();
    }
  }, []);

  const runResolve = useCallback((signal: AbortSignal) => {
    const gen = ++loadGen.current;
    const aborted = () => gen !== loadGen.current || signal.aborted;
    probeCache.current = {};
    setProbes({});
    // Hard reset UI when changing episode — don't keep previous timecode.
    hlsRef.current?.destroy();
    hlsRef.current = null;
    const vid = videoRef.current;
    if (vid) {
      try {
        vid.pause();
        vid.removeAttribute('src');
        vid.load();
      } catch { /* ignore */ }
    }
    setCurrent(0);
    setDuration(0);
    setBuffered(0);
    setHlsHeights([]);
    setQualityOpen(false);
    setRaceDone(false);
    setPlaying(false);
    resumeAppliedRef.current = null;

    const list = buildSources({
      kind: 'anime',
      tmdbId: details.id,
      mediaType: details.mediaType,
      title: details.title,
      season: details.mediaType === 'tv' ? season : undefined,
      episode: details.mediaType === 'tv' ? episode : undefined,
      lang,
      preferPlayerId:
        details.mediaType === 'movie' || !rememberServer
          ? undefined
          : (getStickyAnimePlayer() || undefined),
    });
    setSources(list);
    setError(null);
    setStatus('Recherche sources…');
    setScanHint('Test des sources…');
    setLoading(true);
    setActive(null);
    setSwitchOffer(null);
    activeIdRef.current = null;
    playedIdRef.current = null;
    playStartedAtRef.current = 0;

    for (const s of list) {
      probeCache.current[s.playerId] = { state: 'checking' };
    }
    setProbes({ ...probeCache.current });

    let playedId: string | null = null;

    const beginPlayback = (source: StreamSource, url: string, quality?: number, seek = false) => {
      playedId = source.playerId;
      playedIdRef.current = source.playerId;
      activeIdRef.current = source.playerId;
      waitingFailoverRef.current = false;
      playStartedAtRef.current = Date.now();
      if (rememberServer) setStickyAnimePlayer(source.playerId);
      if (seek) {
        const v = videoRef.current;
        qualitySeekRef.current = v?.currentTime || 0;
      }
      setActive(source);
      setSwitchOffer((o) => (o && isSamePlayer(o.source, source) ? null : o));
      const q = quality ? ` · ${quality}p` : '';
      setStatus(`${source.label}${q}`);
      setScanHint('');
      setError(null);
      setLoading(true);
      attach(url);
    };

    const isPlayableProbe = (s: StreamSource) => {
      if (!canPlayEarly(s, lang)) return false;
      const pr = probeCache.current[s.playerId];
      return !!(pr?.state === 'ok' && pr.url && isAttachableStreamUrl(pr.url));
    };

    const tryStartReady = () => {
      if (playedIdRef.current || aborted()) return false;
      const ready = list.find(isPlayableProbe);
      if (!ready) return false;
      const pr = probeCache.current[ready.playerId];
      if (!pr?.url) return false;
      beginPlayback(ready, pr.url, pr.quality);
      return true;
    };

    const handleProgress = (p: {
      ok: boolean;
      source: StreamSource;
      url?: string;
      alternates?: string[];
      readers?: StreamReader[];
      hoster?: string;
      ms?: number;
      quality?: number;
      error?: string;
      done: number;
      total: number;
    }) => {
      if (aborted()) return;
      if (p.ok && p.url && isAttachableStreamUrl(p.url)) {
        probeCache.current[p.source.playerId] = {
          state: 'ok',
          url: p.url,
          alternates: p.alternates,
          readers: p.readers,
          activeReaderIndex: 0,
          hoster: p.hoster,
          ms: p.ms,
          quality: p.quality,
        };
      } else {
        probeCache.current[p.source.playerId] = {
          state: 'fail',
          ms: p.ms,
          error: p.ok ? 'flux non lisible' : p.error,
        };
      }
      setProbes({ ...probeCache.current });
      if (tryStartReady()) return;
      if (!playedIdRef.current) {
        setScanHint(`${p.done}/${p.total} testés`);
      }
    };

    const cacheHit = (
      source: StreamSource,
      stream: { url?: string; alternates?: string[]; readers?: StreamReader[]; hoster?: string },
      quality?: number,
      ms?: number,
    ) => {
      if (!stream.url || !isAttachableStreamUrl(stream.url)) {
        probeCache.current[source.playerId] = {
          state: 'fail',
          error: 'flux non lisible',
          ms,
        };
        setProbes({ ...probeCache.current });
        return;
      }
      probeCache.current[source.playerId] = {
        state: 'ok',
        url: stream.url,
        alternates: stream.alternates,
        readers: stream.readers,
        activeReaderIndex: 0,
        hoster: stream.hoster,
        ms,
        quality,
      };
      setProbes({ ...probeCache.current });
    };

    const justStarted = () => {
      const v = videoRef.current;
      const t = v?.currentTime ?? 0;
      return Date.now() - playStartedAtRef.current < 15000 && t < 15;
    };

    const shouldAutoSwapForPref = (quality?: number) => {
      const qPref = qualityPrefRef.current;
      if (!justStarted()) return false;
      const curQ = probeCache.current[playedId || '']?.quality || 0;
      if (qPref === 'auto') {
        // Fast progressive upgrade: if playing <1080p or unrated, auto-swap to 1080p stream
        return curQ < 1080 && (quality || 0) >= 1080;
      }
      const want = Number(qPref);
      return (!curQ || curQ < want - 40) && (quality || 0) >= want - 40;
    };

    const offerOrSwap = (
      source: StreamSource,
      url: string,
      quality: number | undefined,
      reason: BetterReason,
    ) => {
      if (!canPlayEarly(source, lang) || isDecoyStreamUrl(url)) return;
      const playing = list.find((s) => s.playerId === playedIdRef.current) || null;
      if (isSamePlayer(playing, source)) return;
      if (shouldAutoSwapForPref(quality)) {
        setSwitchOffer(null);
        setStatus(`Passage auto en ${quality || 1080}p (${source.label})`);
        beginPlayback(source, url, quality, true);
        return;
      }
      setSwitchOffer({ source, url, quality, reason });
    };

    const qNow = qualityPrefRef.current;
    const preferQ: 'auto' | number = qNow === 'auto' ? 'auto' : Number(qNow);
    const prefetchKey = episodePrefetchKey({
      tmdbId: details.id,
      season: details.mediaType === 'tv' ? season : undefined,
      episode: details.mediaType === 'tv' ? episode : undefined,
      lang,
    });
    const cached = consumePrefetch(prefetchKey);
    if (cached?.length) {
      for (const h of cached) {
        if (!h.stream.url || !isAttachableStreamUrl(h.stream.url)) continue;
        probeCache.current[h.source.playerId] = {
          state: 'ok',
          url: h.stream.url,
          alternates: h.stream.alternates,
          hoster: h.stream.hoster,
          ms: h.ms,
          quality: h.quality,
        };
      }
      setProbes({ ...probeCache.current });
      const pick =
        [...cached]
          .filter((h) => h.stream.url && isAttachableStreamUrl(h.stream.url) && canPlayEarly(h.source, lang))
          .sort((a, b) => {
            const rec = Number(!!b.source.recommended) - Number(!!a.source.recommended);
            if (rec) return rec;
            return (b.quality || 0) - (a.quality || 0);
          })[0];
      if (pick && !aborted()) beginPlayback(pick.source, pick.stream.url, pick.quality);
    }

    const remaining = cached?.length
      ? list.filter((s) => probeCache.current[s.playerId]?.state !== 'ok')
      : list;
    if (!remaining.length) {
      setRaceDone(true);
      return;
    }

    const raceOpts = {
      timeoutMs: details.mediaType === 'movie'
        ? (lang === 'vostfr' ? 16000 : 12000)
        : 16000,
      settleMs: 600,
      concurrency: 6,
      waveGapMs: 280,
      preferQuality: preferQ,
      preferRecommended: true,
      signal,
    } as const;

    const runBackgroundRace = (pool: StreamSource[]) => {
      if (!pool.length || aborted()) return;
      void resolveRace(pool, {
        ...raceOpts,
        onFirst: undefined,
        onBetter: ({ source, stream, quality, ms, reason }) => {
          if (aborted()) return;
          if (!isAttachableStreamUrl(stream.url)) return;
          cacheHit(source, stream, quality, ms);
          if (!playedIdRef.current) {
            tryStartReady();
            return;
          }
          offerOrSwap(source, stream.url, quality, reason);
        },
        onProgress: handleProgress,
      })
        .then(({ source, stream, quality, ms }) => {
          if (aborted()) return;
          if (!isAttachableStreamUrl(stream.url)) return;
          cacheHit(source, stream, quality, ms);
          const playingId = playedIdRef.current;
          if (playingId && !isSamePlayer({ playerId: playingId }, source) && stream.url) {
            const curSrc = list.find((s) => s.playerId === playingId);
            const curProbe = probeCache.current[playingId];
            if (curSrc && !isSamePlayer(curSrc, source)) {
              const reason = classifyBetter(
                asRaceHit(curSrc, { url: curProbe?.url || 'https://playing.invalid', quality: curProbe?.quality, ms: curProbe?.ms || 9999 }),
                asRaceHit(source, { url: stream.url, quality, ms }),
                preferQ,
              );
              if (reason) offerOrSwap(source, stream.url, quality, reason);
            }
          }
          setScanHint('');
        })
        .catch(() => undefined)
        .finally(() => {
          if (aborted()) return;
          setRaceDone(true);
        });
    };

    const stickyId = rememberServer ? getStickyAnimePlayer() : null;
    const stickyReady = stickyId && list[0]?.playerId === stickyId && !cached?.length;

    void (async () => {
      if (stickyReady && !aborted()) {
        const stickyHit = await resolveStickyFirst(list, { timeoutMs: 5200, signal });
        if (aborted()) return;
        if (stickyHit?.stream.url && isAttachableStreamUrl(stickyHit.stream.url) && canPlayEarly(stickyHit.source, lang)) {
          cacheHit(stickyHit.source, stickyHit.stream, stickyHit.quality, stickyHit.ms);
          beginPlayback(stickyHit.source, stickyHit.stream.url, stickyHit.quality);
          setRaceDone(true);
          const rest = remaining.filter((s) => s.playerId !== stickyHit.source.playerId);
          runBackgroundRace(rest);
          return;
        }
      }

      if (aborted()) return;

      void resolveRace(remaining, {
        ...raceOpts,
        onFirst: ({ source, stream, quality, ms }) => {
          if (aborted()) return;
          if (!isAttachableStreamUrl(stream.url)) {
            probeCache.current[source.playerId] = {
              state: 'fail',
              error: 'flux non lisible',
              ms,
            };
            setProbes({ ...probeCache.current });
            if (source.playerId === 'frenchanime') clearStickyAnimePlayer();
            tryStartReady();
            return;
          }
          cacheHit(source, stream, quality, ms);
          if (playedIdRef.current) return;
          if (canPlayEarly(source, lang)) beginPlayback(source, stream.url, quality);
          else tryStartReady();
        },
        onBetter: ({ source, stream, quality, ms, reason }) => {
          if (aborted()) return;
          if (!isAttachableStreamUrl(stream.url)) return;
          cacheHit(source, stream, quality, ms);
          if (!playedIdRef.current) {
            tryStartReady();
            return;
          }
          offerOrSwap(source, stream.url, quality, reason);
        },
        onProgress: handleProgress,
      })
        .then(({ source, stream, quality, ms }) => {
          if (aborted()) return;
          if (!isAttachableStreamUrl(stream.url)) {
            probeCache.current[source.playerId] = {
              state: 'fail',
              error: 'flux intro / decoy',
              ms,
            };
            setProbes({ ...probeCache.current });
            if (source.playerId === 'frenchanime') clearStickyAnimePlayer();
            if (!playedId) {
              const fallback = list.find((s) => {
                const p = probeCache.current[s.playerId];
                return canPlayEarly(s, lang) && p?.state === 'ok' && p.url && !isDecoyStreamUrl(p.url);
              });
              if (fallback) {
                const url = probeCache.current[fallback.playerId]?.url;
                if (url) beginPlayback(fallback, url, probeCache.current[fallback.playerId]?.quality);
              } else if (lang === 'vostfr') {
                const stillVo = list.some(
                  (s) => canPlayEarly(s, lang) && probeCache.current[s.playerId]?.state === 'checking',
                );
                if (!stillVo) {
                  setError(VOSTFR_MISS);
                  setStatus('Aucun serveur VOSTFR');
                  setLoading(false);
                }
              }
            }
            setScanHint('');
            return;
          }
          cacheHit(source, stream, quality, ms);
          const playingId = playedIdRef.current;
          if (!playingId) {
            if (canPlayEarly(source, lang)) {
              beginPlayback(source, stream.url, quality);
            } else {
              const vo = list.find((s) => {
                const p = probeCache.current[s.playerId];
                return canPlayEarly(s, lang) && p?.state === 'ok' && p.url;
              });
              if (vo) {
                const url = probeCache.current[vo.playerId]?.url;
                if (url) beginPlayback(vo, url, probeCache.current[vo.playerId]?.quality);
              } else if (lang === 'vostfr') {
                const stillVo = list.some(
                  (s) => canPlayEarly(s, lang) && probeCache.current[s.playerId]?.state === 'checking',
                );
                if (!stillVo) {
                  setError(VOSTFR_MISS);
                  setStatus('Aucun serveur VOSTFR');
                  setLoading(false);
                }
              }
            }
          } else if (isSamePlayer({ playerId: playingId }, source)) {
            probeCache.current[source.playerId] = {
              ...probeCache.current[source.playerId],
              alternates: stream.alternates,
              hoster: stream.hoster || probeCache.current[source.playerId]?.hoster,
              url: probeCache.current[source.playerId]?.url || stream.url,
            };
            setProbes({ ...probeCache.current });
          } else if (stream.url) {
            const curSrc = list.find((s) => s.playerId === playingId);
            const curProbe = probeCache.current[playingId];
            if (curSrc && !isSamePlayer(curSrc, source)) {
              const reason = classifyBetter(
                asRaceHit(curSrc, { url: curProbe?.url || 'https://playing.invalid', quality: curProbe?.quality, ms: curProbe?.ms || 9999 }),
                asRaceHit(source, { url: stream.url, quality, ms }),
                preferQ,
              );
              if (reason) offerOrSwap(source, stream.url, quality, reason);
            }
          }
          setScanHint('');
        })
        .catch((e) => {
          if (aborted()) return;
          if (e instanceof DOMException && e.name === 'AbortError') return;
          if (playedId) {
            setScanHint('');
            return;
          }
          const msg = lang === 'vostfr'
            ? VOSTFR_MISS
            : sanitizePlayerError(e instanceof Error ? e.message : String(e));
          setError(msg);
          setStatus(lang === 'vostfr' ? 'Aucun serveur VOSTFR' : 'Aucun serveur');
          setScanHint('');
          setLoading(false);
        })
        .finally(() => {
          if (aborted()) return;
          setRaceDone(true);
          if (playedIdRef.current || lang !== 'vostfr') return;
          const voReady = list.find((s) => {
            const p = probeCache.current[s.playerId];
            return canPlayEarly(s, lang) && p?.state === 'ok' && p.url && !isDecoyStreamUrl(p.url);
          });
          if (voReady) {
            const url = probeCache.current[voReady.playerId]?.url;
            if (url) beginPlayback(voReady, url, probeCache.current[voReady.playerId]?.quality);
            return;
          }
          const stillVo = list.some(
            (s) => canPlayEarly(s, lang) && probeCache.current[s.playerId]?.state === 'checking',
          );
          if (!stillVo) {
            setError(VOSTFR_MISS);
            setStatus('Aucun serveur VOSTFR');
            setLoading(false);
          }
        });
    })();
  }, [attach, details.id, details.mediaType, details.title, season, episode, lang, rememberServer]);

  useEffect(() => {
    const debounce = window.setTimeout(() => {
      resolveAbortRef.current?.abort();
      cancelPrefetch();
      const ctrl = new AbortController();
      resolveAbortRef.current = ctrl;
      runResolve(ctrl.signal);
    }, EP_SWITCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(debounce);
      resolveAbortRef.current?.abort();
      resolveAbortRef.current = null;
      cancelPrefetch();
      loadGen.current += 1;
      attachGen.current += 1;
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [runResolve]);

  useEffect(() => {
    if (!raceDone || details.mediaType !== 'tv') return;
    const next = episodes
      .filter((e) => e.episodeNumber > episode && isEpisodeAired(e, episodes))
      .sort((a, b) => a.episodeNumber - b.episodeNumber)[0];
    if (!next) return;
    const qNow = qualityPrefRef.current;
    const list = buildSources({
      kind: 'anime',
      tmdbId: details.id,
      mediaType: details.mediaType,
      title: details.title,
      season,
      episode: next.episodeNumber,
      lang,
      preferPlayerId: rememberServer ? (getStickyAnimePlayer() || undefined) : undefined,
    });
    startPrefetch(
      episodePrefetchKey({
        tmdbId: details.id,
        season,
        episode: next.episodeNumber,
        lang,
      }),
      list,
      {
        timeoutMs: 7000,
        settleMs: 400,
        concurrency: 3,
        preferQuality: qNow === 'auto' ? 'auto' : Number(qNow),
        preferRecommended: true,
      },
    );
  }, [raceDone, details.id, details.mediaType, details.title, season, episode, lang, episodes, rememberServer]);

  useEffect(() => {
    if (!loading || error || !active) return;
    const t = window.setTimeout(() => {
      const v = videoRef.current;
      if (v && v.readyState >= 2) {
        setLoading(false);
        setScanHint('');
        return;
      }
      if (v && Number.isFinite(v.currentTime) && v.currentTime > 8) {
        setLoading(false);
        return;
      }
      const failedId = activeIdRef.current;
      if (failedId) {
        const cur = probeCache.current[failedId];
        probeCache.current[failedId] = {
          ...(cur || { state: 'fail' }),
          state: 'fail',
          error: 'démarrage timeout',
          url: undefined,
        };
        setProbes({ ...probeCache.current });
      }
      const pickNext = () =>
        sourcesRef.current.find((s) => {
          if (s.playerId === failedId) return false;
          if (!canPlayEarly(s, langRef.current)) return false;
          const p = probeCache.current[s.playerId];
          if (p?.state !== 'ok' || !p.url) return false;
          if (isDecoyStreamUrl(p.url)) {
            probeCache.current[s.playerId] = { ...p, state: 'fail', error: 'FSTREAM intro', url: undefined };
            return false;
          }
          return true;
        });
      const next = pickNext();
      if (next) {
        const url = probeCache.current[next.playerId]?.url;
        if (url) {
          activeIdRef.current = next.playerId;
          setActive(next);
          setStatus(next.label);
          setScanHint('Autre serveur…');
          setError(null);
          attach(url);
          return;
        }
      }
      const stillChecking = sourcesRef.current.some(
        (s) => s.playerId !== failedId
          && canPlayEarly(s, langRef.current)
          && probeCache.current[s.playerId]?.state === 'checking',
      );
      if (stillChecking) {
        waitingFailoverRef.current = true;
        setScanHint('Autre serveur…');
        return;
      }
      setError(langRef.current === 'vostfr' ? VOSTFR_MISS : 'Le flux ne démarre pas. Choisis un autre serveur.');
      setLoading(false);
      setScanHint('');
      if (failedId === 'frenchanime') clearStickyAnimePlayer();
    }, 5500);
    return () => window.clearTimeout(t);
  }, [loading, error, active, attach]);

  useEffect(() => {
    setBrowseSeason(season);
  }, [season]);

  useEffect(() => {
    if (!isTv) return;
    setEpsLoading(true);
    void fetchSeason(details.id, browseSeason, details.posterPath || details.backdropPath)
      .then(setEpisodes)
      .catch(() => setEpisodes([]))
      .finally(() => setEpsLoading(false));
  }, [details.id, browseSeason, isTv]);

  useEffect(() => {
    const btn = epStripRef.current?.querySelector<HTMLElement>('.cr-ep.on');
    btn?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [episode, season, browseSeason, episodes.length]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !autoplayNext || !isTv) return;
    const onEnded = () => {
      const next = episodes
        .filter((e) => e.episodeNumber > episode && isEpisodeAired(e, episodes))
        .sort((a, b) => a.episodeNumber - b.episodeNumber)[0];
      if (next) onEpisode(season, next.episodeNumber);
    };
    video.addEventListener('ended', onEnded);
    return () => video.removeEventListener('ended', onEnded);
  }, [autoplayNext, isTv, season, episode, episodes, onEpisode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = videoRef.current;
      if (!v) return;
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        if (v.paused) void v.play();
        else v.pause();
      }
      if (e.key === 'ArrowRight') v.currentTime = Math.min(v.duration || 0, v.currentTime + 10);
      if (e.key === 'ArrowLeft') v.currentTime = Math.max(0, v.currentTime - 10);
      if (e.key === 'f') void toggleFs();
      if (e.key === 'm') {
        v.muted = !v.muted;
        setMuted(v.muted);
      }
      if (e.key === 'Escape' && !document.fullscreenElement) {
        if (serversOpen) setServersOpen(false);
        else onClose();
      }
      bumpUi();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bumpUi, onClose, serversOpen]);

  async function probeAll(force = false) {
    if (!sources.length) return;
    setProbing(true);
    const next: Record<string, ProbeInfo> = { ...probeCache.current };
    for (const s of sources) {
      if (!force && next[s.playerId]?.state === 'ok' && next[s.playerId].url) continue;
      next[s.playerId] = { state: 'checking' };
    }
    probeCache.current = next;
    setProbes({ ...next });

    await Promise.all(
      sources.map(async (s) => {
        if (!force && probeCache.current[s.playerId]?.state === 'ok' && probeCache.current[s.playerId].url) return;
        const started = performance.now();
        try {
          const stream = await resolveSource(s, 14000);
          probeCache.current[s.playerId] = {
            state: 'ok',
            url: stream.url,
            alternates: stream.alternates,
            readers: stream.readers,
            activeReaderIndex: 0,
            hoster: stream.hoster,
            ms: Math.round(performance.now() - started),
            quality: stream.quality,
          };
        } catch (e) {
          probeCache.current[s.playerId] = {
            state: 'fail',
            ms: Math.round(performance.now() - started),
            error: e instanceof Error ? e.message : String(e),
          };
        }
        setProbes({ ...probeCache.current });
      }),
    );
    setProbing(false);
  }

  async function openServers() {
    setQualityOpen(false);
    setServersOpen(true);
    bumpUi();
    await probeAll(false);
  }

  function pickReader(source: StreamSource, rIdx: number) {
    const p = probeCache.current[source.playerId];
    const r = p?.readers?.[rIdx];
    if (!r?.url) return;
    probeCache.current[source.playerId] = {
      ...p,
      activeReaderIndex: rIdx,
      url: r.url,
      quality: r.quality || p?.quality,
      hoster: r.hoster || p?.hoster,
    };
    setProbes({ ...probeCache.current });
    const at = videoRef.current?.currentTime || 0;
    qualitySeekRef.current = at;
    activeIdRef.current = source.playerId;
    playedIdRef.current = source.playerId;
    if (rememberServer) setStickyAnimePlayer(source.playerId);
    setActive(source);
    setSwitchOffer(null);
    setStatus(`${source.label} · ${r.label}`);
    setLoading(true);
    setReadersOpen(false);
    attach(r.url);
    bumpUi();
  }

  async function pick(source: StreamSource) {
    setError(null);
    setStatus(source.label);
    setLoading(true);
    const cached = probeCache.current[source.playerId];
    try {
      let url = cached?.state === 'ok' ? cached.url : undefined;
      if (!url) {
        const started = performance.now();
        const stream = await resolveSource(source, 14000);
        url = stream.url;
        probeCache.current[source.playerId] = {
          state: 'ok',
          url,
          alternates: stream.alternates,
          readers: stream.readers,
          activeReaderIndex: 0,
          hoster: stream.hoster,
          ms: Math.round(performance.now() - started),
          quality: stream.quality,
        };
        setProbes({ ...probeCache.current });
      }
      activeIdRef.current = source.playerId;
      playedIdRef.current = source.playerId;
      setActive(source);
      setSwitchOffer(null);
      attach(url!);
      setServersOpen(false);
      setScanHint('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      probeCache.current[source.playerId] = { state: 'fail', error: msg };
      setProbes({ ...probeCache.current });
      setError(sanitizePlayerError(msg));
      setLoading(false);
    }
  }

  function acceptSwitchOffer() {
    const offer = switchOffer;
    if (!offer?.url) return;
    const at = videoRef.current?.currentTime || 0;
    qualitySeekRef.current = at;
    playedIdRef.current = offer.source.playerId;
    activeIdRef.current = offer.source.playerId;
    if (rememberServer) setStickyAnimePlayer(offer.source.playerId);
    setActive(offer.source);
    const q = offer.quality ? ` · ${offer.quality}p` : '';
    setStatus(`${offer.source.label}${q}`);
    setSwitchOffer(null);
    setLoading(true);
    attach(offer.url);
    bumpUi();
  }

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
    bumpUi();
  }

  function setPreferredQuality(q: AnimeQuality) {
    setQualityOpen(false);
    const prefs = loadAnimePrefs();

    const commit = (next: AnimeQuality, note: string) => {
      setQualityPref(next);
      saveAnimePrefs({ ...prefs, preferredQuality: next });
      setStatus(note);
      setLoading(false);
      bumpUi();
    };

    const hls = hlsRef.current;

    if (q === 'auto') {
      if (hls?.levels?.length) applyHlsQuality(hls, 'auto');
      commit('auto', 'Qualité Auto');
      return;
    }

    // Current multi-bitrate HLS can serve this cap — stay on same stream.
    if (hls && hlsHasSelectableLevels(hls, q)) {
      applyHlsQuality(hls, q);
      commit(q, `Qualité ${q}p`);
      return;
    }

    // Fixed MP4 / single-rendition: pick another OK probe near the target height.
    const target = Number(q);
    let bestUrl: string | null = null;
    let bestDiff = Infinity;
    for (const p of Object.values(probeCache.current)) {
      if (p.state !== 'ok' || !p.url || !p.quality) continue;
      const diff = Math.abs(p.quality - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestUrl = p.url;
      }
    }
    if (bestUrl && bestDiff <= 200) {
      const video = videoRef.current;
      const at = video?.currentTime || 0;
      setQualityPref(q);
      saveAnimePrefs({ ...prefs, preferredQuality: q });
      pendingQualityRef.current = q;
      qualitySeekRef.current = at;
      setStatus(`Qualité ${q}p…`);
      setLoading(true);
      attach(bestUrl);
      // If that stream never starts, snap back to Auto after a few seconds.
      const gen = attachGen.current;
      window.setTimeout(() => {
        if (gen !== attachGen.current) return;
        const v = videoRef.current;
        const stuck = !v || !Number.isFinite(v.duration) || v.duration < 1 || v.readyState < 2;
        if (!stuck) return;
        pendingQualityRef.current = null;
        setQualityPref('auto');
        saveAnimePrefs({ ...loadAnimePrefs(), preferredQuality: 'auto' });
        setStatus(`${q}p indisponible — retour Auto`);
        setLoading(false);
        bumpUi();
      }, 8000);
      bumpUi();
      return;
    }

    // Nothing matches (e.g. only 720/1080 fixed) — keep playing, reset to Auto.
    if (hls?.levels?.length) applyHlsQuality(hls, 'auto');
    commit('auto', `${q}p indisponible — retour Auto`);
  }

  function seekAt(clientX: number) {
    const el = seekRef.current;
    const v = videoRef.current;
    if (!el || !v || !duration) return;
    const rect = el.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    v.currentTime = pct * duration;
    setCurrent(pct * duration);
  }

  function onSeekPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    seekDragRef.current = true;
    setSeekDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    seekAt(e.clientX);
    bumpUi();
  }

  function onSeekPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const el = seekRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    if (seekDragRef.current) {
      seekAt(e.clientX);
      return;
    }
    setHoverPct(pct);
  }

  function onSeekPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (seekDragRef.current) {
      seekDragRef.current = false;
      setSeekDragging(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch { /* ignore */ }
    }
  }

  async function toggleFs() {
    const stage = stageRef.current;
    if (!stage) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await stage.requestFullscreen();
  }

  const okCount = Object.values(probes).filter((p) => p.state === 'ok').length;
  const failCount = Object.values(probes).filter((p) => p.state === 'fail').length;

  return (
    <div
      ref={rootRef}
      className={`cr-player${!showUi ? ' cr-player-idle' : ''}`}
      onMouseMove={bumpUi}
      onPointerDown={bumpUi}
    >
      <div
        ref={stageRef}
        className="cr-stage"
        onClick={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest('button, a, input, .cr-dock, .cr-top, .cr-servers, .cr-fail, .cr-eps, .cr-q-menu, .cr-switch-offer')) return;
          if (error) return;
          e.preventDefault();
          togglePlay();
        }}
      >
        <video
          ref={videoRef}
          className="cr-video"
          playsInline
          autoPlay
          onClick={(e) => {
            e.stopPropagation();
            if (error) return;
            togglePlay();
          }}
          onPlay={() => { setPlaying(true); setLoading(false); setScanHint(''); }}
          onPause={() => {
            const v = videoRef.current;
            if (v && !v.paused) return;
            setPlaying(false);
            setShowUi(true);
          }}
          onWaiting={() => { if (!error) setLoading(true); }}
          onPlaying={() => { setPlaying(true); setLoading(false); setScanHint(''); }}
          onCanPlay={() => { setLoading(false); setScanHint(''); }}
          onTimeUpdate={() => {
            const v = videoRef.current;
            if (!v) return;
            setPlaying(!v.paused);
            setCurrent(v.currentTime);
            setDuration(v.duration || 0);
            if (v.buffered.length) {
              setBuffered((v.buffered.end(v.buffered.length - 1) / (v.duration || 1)) * 100);
            }
            const now = Date.now();
            if (now - lastSaveAtRef.current < 4000) return;
            if (v.paused || !Number.isFinite(v.currentTime) || v.currentTime < 8) return;
            if (!Number.isFinite(v.duration) || v.duration < 60) return;
            lastSaveAtRef.current = now;
            const profile = getActiveProfile();
            if (!profile) return;
            const d = detailsRef.current;
            writeWatchProgress({
              profileId: profile.id,
              tmdbId: d.id,
              mediaType: d.mediaType,
              title: d.title,
              posterPath: d.posterPath,
              season: d.mediaType === 'tv' ? season : 0,
              episode: d.mediaType === 'tv' ? episode : 0,
              progressSeconds: v.currentTime,
              durationSeconds: v.duration,
            });
            onProgressSaved?.();
          }}
          onLoadedMetadata={() => setDuration(videoRef.current?.duration || 0)}
        />

        {loading && !error && (
          <div className="cr-loader">
            <div className="cr-led" role="status" aria-label="Chargement">
              <span className="cr-led-halo" />
              <span className="cr-led-track" />
              <span className="cr-led-arc" />
              <span className="cr-led-core">Z</span>
            </div>
            {scanHint && <p className="cr-loader-hint">{scanHint}</p>}
          </div>
        )}

        {switchOffer && !error && !isSamePlayer(switchOffer.source, active) && (
          <div className="cr-switch-offer" role="status">
            <span>{switchOfferCopy(switchOffer.source.label, switchOffer.reason)}</span>
            <button type="button" className="cr-switch-offer-go" onClick={acceptSwitchOffer}>
              Changer
            </button>
            <button
              type="button"
              className="cr-switch-offer-x"
              onClick={() => setSwitchOffer(null)}
              aria-label="Ignorer"
            >
              ×
            </button>
          </div>
        )}

        {error && !playing && (
          <div className="cr-fail">
            <strong>Lecture impossible</strong>
            <p>{sanitizePlayerError(error)}</p>
            <p className="cr-fail-meta">{failCount ? `${failCount} serveur(s) indisponible(s)` : 'Aucun serveur disponible'}</p>
            <div className="cr-fail-actions">
              <button type="button" className="cr-fail-primary" onClick={() => {
                resolveAbortRef.current?.abort();
                const ctrl = new AbortController();
                resolveAbortRef.current = ctrl;
                runResolve(ctrl.signal);
              }}>
                Réessayer
              </button>
              <button type="button" className="cr-fail-ghost" onClick={() => void openServers()}>
                Choisir un serveur
              </button>
            </div>
          </div>
        )}

        <div className={`cr-hud${showUi ? ' on' : ''}`}>
          <div className="cr-top">
            <div className="cr-top-left">
              <button type="button" className="cr-back" onClick={onClose}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
                Catalogue
              </button>
              <div className="cr-title-block">
                <strong>{details.title}</strong>
                {isTv && <span>Saison {season} · Épisode {episode}{currentEp?.name ? ` — ${currentEp.name}` : ''}</span>}
              </div>
            </div>
            <div className="cr-top-right">
              <TitleLangSwitch
                item={details}
                lang={lang}
                className="cr-lang"
                onLang={(l) => {
                  if (l === lang) return;
                  clearStickyAnimePlayer();
                  onLang(l);
                }}
              />
              <button type="button" className="cr-chip" onClick={() => void openServers()}>
                Serveurs
              </button>
            </div>
          </div>

          <div className="cr-dock" onClick={(e) => e.stopPropagation()}>
            <div
              ref={seekRef}
              className={`cr-seek${seekDragging ? ' dragging' : ''}`}
              onPointerDown={onSeekPointerDown}
              onPointerMove={onSeekPointerMove}
              onPointerUp={onSeekPointerUp}
              onPointerCancel={onSeekPointerUp}
              onMouseLeave={() => { if (!seekDragRef.current) setHoverPct(null); }}
            >
              <div className="cr-seek-track" />
              <div className="cr-seek-buf" style={{ width: `${buffered}%` }} />
              <div className="cr-seek-fill" style={{ width: `${progress}%` }} />
              <div className="cr-seek-thumb" style={{ left: `${progress}%` }} />
              {hoverPct !== null && duration > 0 && (
                <div className="cr-seek-tip" style={{ left: `${hoverPct * 100}%` }}>{fmt(hoverPct * duration)}</div>
              )}
            </div>

            <div className="cr-bar">
              <div className="cr-bar-l">
                <button type="button" className={`cr-icon cr-play-btn${playing ? '' : ' is-play'}`} onClick={togglePlay} aria-label={playing ? 'Pause' : 'Lecture'}>
                  {playing ? (
                    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <rect x="7" y="5" width="3.6" height="14" rx="1" />
                      <rect x="13.4" y="5" width="3.6" height="14" rx="1" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M8.5 6v12l10.5-6z" />
                    </svg>
                  )}
                </button>
                {isTv && (
                  <>
                    <button type="button" className="cr-text-btn" disabled={episode <= minEp} onClick={() => onEpisode(season, episode - 1)}>◀ Préc.</button>
                    <button
                      type="button"
                      className="cr-text-btn primary"
                      disabled={!episodes.some((e) => e.episodeNumber > episode && isEpisodeAired(e, episodes))}
                      onClick={() => {
                        const next = episodes
                          .filter((e) => e.episodeNumber > episode && isEpisodeAired(e, episodes))
                          .sort((a, b) => a.episodeNumber - b.episodeNumber)[0];
                        if (next) onEpisode(season, next.episodeNumber);
                      }}
                    >
                      Suiv. ▶
                    </button>
                  </>
                )}
                <div className="cr-vol">
                  <button
                    type="button"
                    className="cr-icon sm"
                    onClick={() => {
                      const v = videoRef.current;
                      if (!v) return;
                      v.muted = !v.muted;
                      setMuted(v.muted);
                    }}
                    aria-label={muted || volume === 0 ? 'Son' : 'Muet'}
                  >
                    {muted || volume === 0 ? (
                      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a9 9 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"/></svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8.97v6.06A4.48 4.48 0 0 0 16.5 12zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
                    )}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={muted ? 0 : volume}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setVolume(val);
                      setMuted(val === 0);
                      if (videoRef.current) {
                        videoRef.current.volume = val;
                        videoRef.current.muted = val === 0;
                      }
                    }}
                  />
                </div>
                <span className="cr-time">{fmt(current)} / {fmt(duration)}</span>
              </div>
              <div className="cr-bar-r">
                <span className={`cr-status${error ? ' bad' : ''}`}>{error ? sanitizePlayerError(error) : status}</span>
                {active && (probes[active.playerId]?.readers?.length || 0) > 1 && (
                  <div className="cr-reader-select">
                    <button
                      type="button"
                      className={`cr-text-btn cr-reader-btn${readersOpen ? ' on' : ''}`}
                      aria-label="Changer de lecteur"
                      aria-expanded={readersOpen}
                      title="Changer de lecteur"
                      onClick={() => {
                        setReadersOpen((o) => !o);
                        setQualityOpen(false);
                        setServersOpen(false);
                        bumpUi();
                      }}
                    >
                      {probes[active.playerId]?.readers?.[probes[active.playerId]?.activeReaderIndex ?? 0]?.label || 'Lecteur 1'}
                    </button>
                    {readersOpen && (
                      <div className="cr-readers-menu" role="menu">
                        <p className="cr-readers-menu-label">Lecteurs</p>
                        {probes[active.playerId]?.readers?.map((r, idx) => {
                          const isCur = (probes[active.playerId]?.activeReaderIndex ?? 0) === idx;
                          return (
                            <button
                              type="button"
                              key={idx}
                              role="menuitemradio"
                              aria-checked={isCur}
                              className={isCur ? 'on' : ''}
                              onClick={() => pickReader(active, idx)}
                            >
                              <span>{r.label}</span>
                              {r.quality ? <em>{r.quality}p</em> : null}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
                <div className="cr-q">
                  <button
                    type="button"
                    className={`cr-text-btn cr-q-btn${qualityOpen ? ' on' : ''}`}
                    aria-label="Qualité"
                    aria-expanded={qualityOpen}
                    disabled={!qualityUnlocked}
                    title={
                      qualityUnlocked
                        ? 'Choisir la qualité'
                        : 'Disponible quand les sources sont testées et la lecture lancée'
                    }
                    onClick={() => {
                      if (!qualityUnlocked) return;
                      setQualityOpen((o) => !o);
                      setServersOpen(false);
                      setReadersOpen(false);
                      bumpUi();
                    }}
                  >
                    {qualityUnlocked ? qualityBtnLabel(qualityPref) : '…'}
                  </button>
                  {qualityOpen && qualityUnlocked && (
                    <div className="cr-q-menu" role="menu">
                      <p className="cr-q-menu-label">Qualité</p>
                      {QUALITY_OPTS.map((q) => (
                        <button
                          type="button"
                          key={q}
                          role="menuitemradio"
                          aria-checked={qualityPref === q}
                          className={qualityPref === q ? 'on' : ''}
                          onClick={() => setPreferredQuality(q)}
                        >
                          {q === 'auto' ? 'Auto (meilleure)' : `${q}p`}
                          {q === 'auto' && hlsHeights.length > 0 && (
                            <em>max {Math.max(...hlsHeights)}p</em>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button type="button" className="cr-icon" onClick={() => void toggleFs()} aria-label="Plein écran">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>

        {serversOpen && (
          <div className="cr-servers" onClick={() => setServersOpen(false)}>
            <div className="cr-servers-card" onClick={(e) => e.stopPropagation()}>
              <header className="cr-servers-head">
                <div className="cr-servers-head-copy">
                  <h3>Sources</h3>
                  <p className="cr-servers-sub">
                    {probing
                      ? 'Scan en cours…'
                      : `${okCount} dispo${failCount ? ` · ${failCount} hors ligne` : ''} · ${lang.toUpperCase()}`}
                  </p>
                </div>
                <div className="cr-servers-head-actions">
                  <button
                    type="button"
                    className="cr-servers-refresh"
                    disabled={probing}
                    onClick={() => void probeAll(true)}
                    title="Retester toutes les sources"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
                      <path d="M21 12a9 9 0 1 1-2.6-6.3" strokeLinecap="round" />
                      <path d="M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {probing ? 'Scan…' : 'Retester'}
                  </button>
                  <button type="button" className="cr-servers-x" onClick={() => setServersOpen(false)} aria-label="Fermer">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
                      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              </header>

              {probing && (
                <div className="cr-servers-scan" aria-hidden>
                  <span />
                </div>
              )}

              <div className="cr-servers-stats" aria-hidden={!probing && okCount + failCount > 0}>
                <span className="cr-servers-stat ok">{okCount} OK</span>
                <span className="cr-servers-stat fail">{failCount} off</span>
                <span className="cr-servers-stat lang">{lang.toUpperCase()}</span>
              </div>

              <div className="cr-servers-list">
                {sources.map((s) => {
                  const p = probes[s.playerId] || { state: 'idle' as ProbeState };
                  const isOn = active?.playerId === s.playerId;
                  const statusLabel =
                    p.state === 'checking' ? 'Test…'
                      : p.state === 'ok' ? (p.ms != null ? `${p.ms} ms` : 'Prêt')
                        : p.state === 'fail' ? 'Indispo'
                          : '—';
                  return (
                    <div
                      key={s.playerId}
                      role="button"
                      tabIndex={0}
                      className={`cr-srv${isOn ? ' on' : ''}${p.state === 'fail' ? ' fail' : ''}${p.state === 'ok' ? ' ok' : ''}${p.state === 'checking' ? ' checking' : ''}`}
                      title={p.state === 'fail' ? 'Serveur indisponible' : undefined}
                      onClick={() => {
                        if (p.state !== 'checking') void pick(s);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && p.state !== 'checking') void pick(s);
                      }}
                    >
                      <span className={`cr-srv-dot ${p.state}`} aria-hidden />
                      <div className="cr-srv-main">
                        <div className="cr-srv-title">
                          <b>{s.label}</b>
                          <em className={`cr-srv-lang ${sourceLangBadge(s, lang)}`}>
                            {sourceLangBadge(s, lang) === 'vostfr' ? 'VOSTFR' : 'VF'}
                          </em>
                          {isOn && <em className="cr-srv-live">En lecture</em>}
                          {!isOn && switchOffer?.source.playerId === s.playerId && (
                            <em className="cr-srv-live rec">Conseillé</em>
                          )}
                        </div>
                        <span className="cr-srv-meta">
                          {s.meta}
                          {p.quality ? ` · ${p.quality}p` : ''}
                          {p.state === 'fail' ? ' · Serveur indisponible' : ''}
                        </span>
                        {p.readers && p.readers.length > 1 && (
                          <div className="cr-srv-readers" onClick={(e) => e.stopPropagation()}>
                            {p.readers.map((r, rIdx) => {
                              const isCur = isOn && (p.activeReaderIndex ?? 0) === rIdx;
                              return (
                                <button
                                  type="button"
                                  key={rIdx}
                                  className={`cr-reader-pill${isCur ? ' on' : ''}`}
                                  onClick={() => pickReader(s, rIdx)}
                                >
                                  {r.label}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                      <div className={`cr-srv-status ${p.state}`}>
                        {p.state === 'checking' && <span className="cr-srv-spin" aria-hidden />}
                        <span>{statusLabel}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              {error && <p className="cr-servers-err">{sanitizePlayerError(error)}</p>}
            </div>
          </div>
        )}
      </div>

      {isTv && (
        <div className="cr-eps">
          <div className="cr-eps-head">
            <div className="cr-eps-title">
              <h3>Épisodes</h3>
              <span>{episodes.length ? `${episodes.length} ép.` : epsLoading ? '…' : ''}</span>
            </div>
            <div className="cr-season-pills">
              {details.seasons.map((s) => (
                <button
                  type="button"
                  key={s.seasonNumber}
                  className={s.seasonNumber === browseSeason ? 'on' : ''}
                  onClick={() => setBrowseSeason(s.seasonNumber)}
                >
                  S{s.seasonNumber}
                </button>
              ))}
            </div>
          </div>

          <div className="cr-eps-rail">
            <div className="cr-eps-strip" ref={epStripRef}>
              {episodes.map((ep) => {
                const on = browseSeason === season && ep.episodeNumber === episode;
                const aired = isEpisodeAired(ep, episodes);
                const when = !aired && showAirDates ? formatEpisodeAirDate(ep.airDate) : '';
                return (
                  <button
                    type="button"
                    key={ep.episodeNumber}
                    className={`cr-ep${on ? ' on' : ''}${aired ? '' : ' upcoming'}`}
                    disabled={!aired}
                    title={aired ? undefined : (when ? `Diffuse le ${when}` : 'Épisode à venir')}
                    onClick={() => {
                      if (!aired) return;
                      onEpisode(browseSeason, ep.episodeNumber);
                    }}
                  >
                    <div className="cr-ep-thumb">
                      {ep.stillPath ? (
                        <img src={getImageUrl(ep.stillPath, 'w500')} alt="" draggable={false} />
                      ) : (
                        <span className="cr-ep-fallback">{aired ? ep.episodeNumber : '…'}</span>
                      )}
                      <span className="cr-ep-num">{ep.episodeNumber}</span>
                      <EpisodeLangFlags avail={epLangOf(ep.episodeNumber, aired)} className="cr-ep-langs" />
                      {aired ? (
                        <span className="cr-ep-play" aria-hidden>
                          <span className="cr-ep-play-icon">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11.5-6.86a1 1 0 0 0 0-1.72L9.5 4.28A1 1 0 0 0 8 5.14Z"/></svg>
                          </span>
                        </span>
                      ) : (
                        <span className="cr-ep-soon">À VENIR</span>
                      )}
                      {on && (
                        <>
                          <span className="cr-ep-now-stripe" aria-hidden />
                          {duration > 0 && (
                            <span
                              className="cr-ep-now-bar"
                              style={{ transform: `scaleX(${(current / duration).toFixed(4)})` }}
                              aria-hidden
                            />
                          )}
                          <span className="cr-ep-now-label">En cours</span>
                        </>
                      )}
                    </div>
                    <div className="cr-ep-copy">
                      <b>Épisode {ep.episodeNumber}</b>
                      <span>{aired ? (ep.name || `Épisode ${ep.episodeNumber}`) : 'À venir'}</span>
                      {aired && ep.runtime ? <em>{ep.runtime} min</em> : null}
                      {!aired && when ? <em>{when}</em> : null}
                    </div>
                  </button>
                );
              })}
              {epsLoading && episodes.length === 0 && <p className="cr-eps-empty">Chargement des épisodes…</p>}
              {!epsLoading && episodes.length === 0 && <p className="cr-eps-empty">Aucun épisode pour cette saison.</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
