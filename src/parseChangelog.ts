export type ChangeKind = 'nouveau' | 'ameliore' | 'corrige';

export type ChangelogItem = {
  kind: ChangeKind | null;
  text: string;
};

export type ChangelogSection = {
  kind: ChangeKind | null;
  title?: string;
  items: ChangelogItem[];
};

const KIND_ALIASES: Record<ChangeKind, string[]> = {
  nouveau: ['nouveau', 'nouveaux', 'nouvelle', 'nouvelles', 'new', 'added', 'add', 'feature'],
  ameliore: [
    'améliore',
    'amelioré',
    'amélioré',
    'ameliore',
    'amélioration',
    'amelioration',
    'improved',
    'improve',
    'polish',
    'update',
    'updated',
    'perf',
    'performance',
  ],
  corrige: ['corrigé', 'corrige', 'fix', 'fixed', 'bugfix', 'bug', 'hotfix', 'patch'],
};

const KIND_LABEL: Record<ChangeKind, string> = {
  nouveau: 'Nouveau',
  ameliore: 'Amélioré',
  corrige: 'Corrigé',
};

export function changeKindLabel(kind: ChangeKind): string {
  return KIND_LABEL[kind];
}

function normalizeToken(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function matchKind(token: string): ChangeKind | null {
  const n = normalizeToken(token);
  if (!n) return null;
  for (const [kind, aliases] of Object.entries(KIND_ALIASES) as [ChangeKind, string[]][]) {
    if (aliases.some((a) => normalizeToken(a) === n)) return kind;
  }
  return null;
}

function stripInlineMd(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1')
    .trim();
}

/** Pull leading kind marker from a bullet/paragraph. */
function splitKindPrefix(raw: string): { kind: ChangeKind | null; text: string } {
  const cleaned = stripInlineMd(raw.trim().replace(/^[-*•]\s+/, ''));

  // Nouveau — text / Amélioré: text / [Corrigé] text
  const bracket = /^\[([^\]]+)\]\s*[-–—:]?\s*(.+)$/i.exec(cleaned);
  if (bracket) {
    const kind = matchKind(bracket[1]);
    if (kind) return { kind, text: bracket[2].trim() };
  }

  const labeled =
    /^(nouveau(?:x|elle|elles)?|new|added|am[eé]lior[eée]s?|am[eé]lioration|improved?|polish|update(?:d)?|corrig[eée]s?|fix(?:ed)?|bugfix|bug)\s*[-–—:·|]\s*(.+)$/i.exec(
      cleaned,
    );
  if (labeled) {
    const kind = matchKind(labeled[1]);
    if (kind) return { kind, text: labeled[2].trim() };
  }

  // Bold-only lead: **Nouveau** rest
  const boldLead = /^\*\*([^*]+)\*\*\s*[-–—:]?\s*(.+)$/.exec(raw.trim().replace(/^[-*•]\s+/, ''));
  if (boldLead) {
    const kind = matchKind(boldLead[1]);
    if (kind) return { kind, text: stripInlineMd(boldLead[2]) };
  }

  return { kind: null, text: cleaned };
}

function headingKind(title: string): ChangeKind | null {
  const t = stripInlineMd(title);
  const direct = matchKind(t);
  if (direct) return direct;
  // "Nouveautés", "Bug fixes", etc.
  const n = normalizeToken(t);
  if (n.startsWith('nouvea') || n.includes('feature')) return 'nouveau';
  if (n.includes('amelior') || n.includes('improv') || n.includes('polish')) return 'ameliore';
  if (n.includes('corrig') || n.includes('fix') || n.includes('bug')) return 'corrige';
  return null;
}

/**
 * Parse GitHub / latest.json release notes into typed changelog sections.
 * Supports:
 * - ## Nouveau / ## Amélioré / ## Corrigé headings + bullets
 * - Prefixed bullets: - Nouveau — … / - Corrigé: …
 * - Plain prose / lists (kind null → fallback render)
 */
export function parseChangelog(source: string): {
  sections: ChangelogSection[];
  /** True when at least one item has an explicit/heuristic kind. */
  hasKinds: boolean;
} {
  const text = source.replace(/\r\n/g, '\n').trim();
  if (!text) return { sections: [], hasKinds: false };

  const sections: ChangelogSection[] = [];
  let current: ChangelogSection = { kind: null, items: [] };
  let sawHeading = false;

  const pushCurrent = () => {
    if (current.items.length || current.title) sections.push(current);
    current = { kind: null, items: [] };
  };

  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      pushCurrent();
      sawHeading = true;
      const title = stripInlineMd(heading[2]);
      current = { kind: headingKind(title), title, items: [] };
      continue;
    }

    const bullet = /^[-*•]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      const split = splitKindPrefix(bullet[1]);
      // Inherit section kind when bullet has no own prefix
      const kind = split.kind ?? (sawHeading ? current.kind : split.kind);
      if (!sawHeading && split.kind) {
        // Flat typed list without headings — keep one mixed section
        current.items.push({ kind: split.kind, text: split.text });
      } else {
        current.items.push({ kind, text: split.text });
      }
      continue;
    }

    // Non-bullet line: treat as item (or kind-prefixed prose)
    const split = splitKindPrefix(trimmed);
    if (split.kind || !/^#{1,4}\s/.test(trimmed)) {
      current.items.push({
        kind: split.kind ?? (sawHeading ? current.kind : null),
        text: split.text,
      });
    }
  }
  pushCurrent();

  // Drop empty title-only shells
  const cleaned = sections.filter((s) => s.items.length > 0);
  const hasKinds = cleaned.some((s) => s.kind != null || s.items.some((i) => i.kind != null));

  // If everything is one untyped blob of short lines, still OK
  if (!cleaned.length && text) {
    return {
      sections: [{ kind: null, items: [{ kind: null, text: stripInlineMd(text) }] }],
      hasKinds: false,
    };
  }

  return { sections: cleaned, hasKinds };
}

/** Flatten to ordered typed rows (section kind fills gaps). */
export function flattenChangelogItems(sections: ChangelogSection[]): ChangelogItem[] {
  const out: ChangelogItem[] = [];
  for (const section of sections) {
    for (const item of section.items) {
      out.push({
        kind: item.kind ?? section.kind,
        text: item.text,
      });
    }
  }
  return out;
}
