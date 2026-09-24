import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { Markdown } from '../markdown';
import {
  changeKindLabel,
  flattenChangelogItems,
  parseChangelog,
  type ChangeKind,
  type ChangelogItem,
} from '../parseChangelog';

export type AnimeReleaseNote = {
  version: string;
  notes: string;
  publishedAt: string;
};

const GH_RELEASES =
  'https://api.github.com/repos/Apnkk/z-flix-anime/releases?per_page=30';
const LATEST_JSON =
  'https://github.com/Apnkk/z-flix-anime/releases/latest/download/latest.json';

let cache: AnimeReleaseNote[] | null = null;
let inflight: Promise<AnimeReleaseNote[]> | null = null;

function formatDate(iso: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function stripV(tag: string): string {
  return tag.replace(/^v/i, '').trim();
}

async function fetchReleaseHistory(): Promise<AnimeReleaseNote[]> {
  if (cache) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    const out: AnimeReleaseNote[] = [];

    try {
      const res = await fetch(GH_RELEASES, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (res.ok) {
        const data = (await res.json()) as Array<{
          tag_name?: string;
          body?: string | null;
          published_at?: string | null;
          created_at?: string | null;
          draft?: boolean;
          prerelease?: boolean;
        }>;
        for (const r of data) {
          if (r.draft) continue;
          const version = stripV(r.tag_name || '');
          if (!version) continue;
          out.push({
            version,
            notes: (r.body || '').trim(),
            publishedAt: r.published_at || r.created_at || '',
          });
        }
      }
    } catch {
      /* fall through to latest.json */
    }

    if (out.length === 0) {
      const res = await fetch(LATEST_JSON);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { version?: string; notes?: string; pub_date?: string };
      if (j.version) {
        out.push({
          version: stripV(j.version),
          notes: (j.notes || '').trim(),
          publishedAt: j.pub_date || '',
        });
      }
    }

    cache = out;
    return out;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

function IconSparkle() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 2.5l1.35 6.15L19.5 10 13.35 11.35 12 17.5l-1.35-6.15L4.5 10l6.15-1.35L12 2.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconWrench() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14.7 6.3a4.2 4.2 0 0 0-5.6 5.6l-5.3 5.3a1.5 1.5 0 0 0 2.12 2.12l5.3-5.3a4.2 4.2 0 0 0 5.6-5.6l-2.1 2.1a1.3 1.3 0 1 1-1.84-1.84l2.12-2.12Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconBug() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 8.5V8a3 3 0 1 1 6 0v.5M8 12h8M8 15.5h8M6.5 10.5 4 9m16 1.5L17.5 9M6.5 17 4 18.5M17.5 17 20 18.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <rect x="8" y="9.5" width="8" height="9" rx="4" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function KindIcon({ kind }: { kind: ChangeKind }) {
  if (kind === 'nouveau') return <IconSparkle />;
  if (kind === 'ameliore') return <IconWrench />;
  return <IconBug />;
}

function TypedChanges({ items }: { items: ChangelogItem[] }) {
  return (
    <ul className="an-notes-typed">
      {items.map((item, i) => {
        const kind = item.kind;
        return (
          <li
            key={`${kind ?? 'plain'}-${i}`}
            className={kind ? `an-notes-typed-row an-notes-typed-${kind}` : 'an-notes-typed-row an-notes-typed-plain'}
          >
            {kind ? (
              <span className="an-notes-typed-mark" aria-hidden>
                <KindIcon kind={kind} />
              </span>
            ) : (
              <span className="an-notes-typed-bullet" aria-hidden />
            )}
            <p className="an-notes-typed-line">
              {kind ? <span className="an-notes-typed-label">{changeKindLabel(kind)}</span> : null}
              <span className="an-notes-typed-text">{item.text}</span>
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function NotesBody({ source }: { source: string }) {
  const parsed = parseChangelog(source);
  const items = flattenChangelogItems(parsed.sections);
  if (parsed.hasKinds && items.length > 0) {
    return <TypedChanges items={items} />;
  }
  return (
    <div className="an-notes-body">
      <Markdown source={source} />
    </div>
  );
}

interface Props {
  onBack?: () => void;
}

export function ReleaseNotesPanel({ onBack }: Props) {
  const [entries, setEntries] = useState<AnimeReleaseNote[]>(cache ?? []);
  const [installed, setInstalled] = useState<string>('');
  const [loading, setLoading] = useState(!cache?.length);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getVersion()
      .then(setInstalled)
      .catch(() => setInstalled(''));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(!cache?.length);
    void fetchReleaseHistory()
      .then((list) => {
        if (cancelled) return;
        setEntries(list);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        if (!cache?.length) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const latestVersion = entries[0]?.version;

  return (
    <section className="an-notes-page" aria-label="Notes de version">
      <div className="an-notes-art" aria-hidden style={{ backgroundImage: 'url(/hero.png)' }} />
      <div className="an-notes-shade" aria-hidden />

      {onBack ? (
        <button type="button" className="an-notes-back" onClick={onBack}>
          ← Retour
        </button>
      ) : null}

      <div className="an-notes-scroll">
        <header className="an-notes-summary">
          <p className="an-notes-kicker">CHANGELOG</p>
          <h2>Notes de version</h2>
          <p className="an-notes-sub">
            {entries.length > 1
              ? `${entries.length} versions · Z-Animes`
              : 'Dernière version · Z-Animes'}
          </p>
        </header>

        {loading && entries.length === 0 ? (
          <div className="an-notes-loading">
            <span className="an-notes-spinner" />
            Chargement des notes…
          </div>
        ) : null}

        {error && entries.length === 0 ? (
          <p className="an-notes-empty">Impossible de charger les notes : {error}</p>
        ) : null}

        {!loading && !error && entries.length === 0 ? (
          <p className="an-notes-empty">Aucune release trouvée.</p>
        ) : null}

        <div className="an-notes-timeline">
          {entries.map((entry, index) => {
            const isLatest = entry.version === latestVersion || index === 0;
            const isInstalled = installed === entry.version;
            const body = entry.notes.trim();
            return (
              <article
                key={`${entry.version}-${entry.publishedAt}-${index}`}
                className={`an-notes-entry${isLatest ? ' an-notes-entry-latest' : ''}${
                  isInstalled ? ' an-notes-entry-installed' : ''
                }`}
              >
                <div className="an-notes-rail" aria-hidden>
                  <span className="an-notes-dot" />
                  {index < entries.length - 1 ? <span className="an-notes-line" /> : null}
                </div>
                <div className="an-notes-card">
                  <div className="an-notes-head">
                    <div className="an-notes-title">
                      <span className="an-notes-version">v{entry.version}</span>
                      {isLatest ? <span className="an-notes-badge an-notes-badge-latest">Dernière</span> : null}
                      {isInstalled ? (
                        <span className="an-notes-badge an-notes-badge-installed">Installée</span>
                      ) : null}
                    </div>
                    {entry.publishedAt ? (
                      <time dateTime={entry.publishedAt}>{formatDate(entry.publishedAt)}</time>
                    ) : null}
                  </div>
                  {body ? <NotesBody source={body} /> : <p className="an-notes-muted">Pas de notes pour cette version.</p>}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
