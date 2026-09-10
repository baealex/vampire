import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { Observer } from 'mobx-react-lite';
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './repository-virtual-list.css';

export function RepositoryVirtualList<T>({
  items,
  itemKey,
  renderItem,
  estimateSize,
  label,
  pinnedKey,
}: {
  items: readonly T[];
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  estimateSize: number;
  label: string;
  pinnedKey?: string;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [focusedKey, setFocusedKey] = useState<string>();
  const pendingFocus = useRef<string | undefined>(undefined);
  const keys = useMemo(() => items.map(itemKey), [items, itemKey]);
  const focusedIndex = focusedKey === undefined ? -1 : keys.indexOf(focusedKey);
  const pinnedIndex = pinnedKey === undefined ? -1 : keys.indexOf(pinnedKey);
  const getItemKey = useCallback((index: number) => keys[index]!, [keys]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroll.current,
    getItemKey,
    estimateSize: () => estimateSize,
    overscan: 8,
    rangeExtractor: useCallback(
      (range: Parameters<typeof defaultRangeExtractor>[0]) => {
        const indices = new Set(defaultRangeExtractor(range));
        // Keep focused controls, their Tab neighbours, and open menu anchors mounted.
        if (focusedIndex >= 0)
          for (const index of [focusedIndex - 1, focusedIndex, focusedIndex + 1]) {
            if (index >= 0 && index < range.count) indices.add(index);
          }
        if (pinnedIndex >= 0) indices.add(pinnedIndex);
        return [...indices].sort((a, b) => a - b);
      },
      [focusedIndex, pinnedIndex],
    ),
  });
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const row = Array.from(scroll.current?.querySelectorAll<HTMLElement>('[data-virtual-key]') ?? []).find(
      (element) => element.dataset.virtualKey === pendingFocus.current,
    );
    const target = row?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? row;
    if (target) {
      target.focus({ preventScroll: true });
      pendingFocus.current = undefined;
    }
  });
  return (
    <div
      ref={scroll}
      className="repository-virtual-list"
      role="region"
      aria-label={label}
      tabIndex={0}
      onFocusCapture={(event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>('[data-virtual-key]');
        if (row) setFocusedKey(row.dataset.virtualKey);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedKey(undefined);
      }}
      onKeyDown={(event) => {
        if (
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
        )
          return;
        const target = event.target as HTMLElement;
        if (target !== event.currentTarget && target.tagName !== 'BUTTON' && !target.dataset.virtualKey) return;
        const index = Number(target.closest<HTMLElement>('[data-index]')?.dataset.index ?? -1);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
        const key = keys[next];
        if (key === undefined) return;
        event.preventDefault();
        pendingFocus.current = key;
        setFocusedKey(key);
        virtualizer.scrollToIndex(next, { align: 'auto' });
      }}
    >
      <div className="repository-virtual-space" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            data-virtual-key={row.key}
            tabIndex={-1}
            ref={virtualizer.measureElement}
            className="repository-virtual-row"
            style={{ transform: `translateY(${row.start}px)` }}
          >
            <Observer>{() => <>{renderItem(items[row.index]!)}</>}</Observer>
          </div>
        ))}
      </div>
    </div>
  );
}
