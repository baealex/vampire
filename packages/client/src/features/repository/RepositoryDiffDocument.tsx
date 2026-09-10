import { useVirtualizer } from '@tanstack/react-virtual';
import {
  type RepositoryViewerSection,
  repositoryViewerSectionLabel,
} from '@vampire/lib/features/repository/model/view.ts';
import type { DiffLine } from '@vampire/lib/shared/contracts/repository.ts';
import { memo, useMemo, useRef } from 'react';

type Row = { kind: 'header'; label: string } | { kind: 'line'; line: DiffLine };

export const RepositoryDiffDocument = memo(function RepositoryDiffDocument({
  sections,
}: {
  sections: RepositoryViewerSection[];
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const rows = useMemo(
    () =>
      sections.flatMap((section): Row[] => [
        { kind: 'header', label: repositoryViewerSectionLabel(section.kind) },
        ...section.lines.map((line): Row => ({ kind: 'line', line })),
      ]),
    [sections],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: (index) => (rows[index]?.kind === 'header' ? 36 : 22),
    overscan: 12,
  });
  return (
    <div ref={scroll} className="diff-document" role="region" aria-label="Changes" tabIndex={0}>
      <div className="diff-virtual-space" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]!;
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="diff-virtual-row"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row.kind === 'header' ? (
                <div className="diff-section-heading">{row.label}</div>
              ) : (
                <div className={`diff-line ${row.line.kind}`}>
                  <span className="line-number" aria-hidden="true">
                    {row.line.oldLine ?? ''}
                  </span>
                  <span className="line-number" aria-hidden="true">
                    {row.line.newLine ?? ''}
                  </span>
                  <code>{row.line.content || ' '}</code>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
