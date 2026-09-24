import { Fragment, type ReactNode } from 'react';

/** Minimal markdown renderer for GitHub release notes (headings, lists, bold, code, links). */

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  // bold, inline code, links
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2]) out.push(<strong key={`${keyPrefix}-b${i}`}>{m[2]}</strong>);
    else if (m[4]) out.push(<code key={`${keyPrefix}-c${i}`}>{m[4]}</code>);
    else if (m[6]) {
      out.push(
        <a key={`${keyPrefix}-a${i}`} href={m[7]} target="_blank" rel="noreferrer">
          {m[6]}
        </a>
      );
    }
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let listItems: ReactNode[] = [];
  let key = 0;

  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push(<ul key={`ul-${key++}`}>{listItems}</ul>);
      listItems = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (trimmed === '') {
      flushList();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushList();
      const level = heading[1].length;
      const content = renderInline(heading[2], `h-${key}`);
      blocks.push(
        level <= 2 ? <h3 key={`h-${key++}`}>{content}</h3> : <h4 key={`h-${key++}`}>{content}</h4>
      );
      continue;
    }
    const li = /^[-*]\s+(.*)$/.exec(trimmed);
    if (li) {
      listItems.push(<li key={`li-${key++}`}>{renderInline(li[1], `li-${key}`)}</li>);
      continue;
    }
    flushList();
    blocks.push(<p key={`p-${key++}`}>{renderInline(trimmed, `p-${key}`)}</p>);
  }
  flushList();

  return <Fragment>{blocks}</Fragment>;
}
