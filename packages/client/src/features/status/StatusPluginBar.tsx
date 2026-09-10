import * as Popover from '@radix-ui/react-popover';
import { AlertTriangle, ExternalLink, LayoutDashboard } from 'lucide-react';
import { useState } from 'react';
import type { StatusPluginMenuEntry, StatusPluginSnapshot } from '@vampire/lib/shared/contracts/status-plugin.ts';
import './status-plugin-bar.css';

function timestamp(at: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(at);
}
function MenuEntry({ entry }: { entry: StatusPluginMenuEntry }) {
  if (entry.type === 'separator') return <hr />;
  if (entry.type === 'heading')
    return (
      <div className="status-menu-heading">
        <strong>{entry.text}</strong>
        {entry.badge ? <span>{entry.badge}</span> : null}
      </div>
    );
  const content = (
    <>
      <div>
        <strong>
          {entry.checked ? '✓ ' : ''}
          {entry.text}
        </strong>
        {entry.detail ? <small>{entry.detail}</small> : null}
        {entry.time ? (
          <small>
            {entry.time.label ?? 'At'} {timestamp(entry.time.at)}
          </small>
        ) : null}
      </div>
      {entry.value ? <output>{entry.value}</output> : null}
      {entry.href ? <ExternalLink size={12} aria-hidden="true" /> : null}
      {entry.progress !== undefined ? (
        <span className="status-progress">
          <i style={{ width: `${entry.progress}%` }} />
        </span>
      ) : null}
    </>
  );
  return entry.href ? (
    <a className="status-menu-item" href={entry.href} target="_blank" rel="noreferrer">
      {content}
    </a>
  ) : (
    <div className="status-menu-item">{content}</div>
  );
}

export function StatusPluginBar({ onManage, plugins }: { onManage: () => void; plugins: StatusPluginSnapshot[] }) {
  const [openId, setOpenId] = useState<string>();
  const openPlugin = plugins.find((plugin) => plugin.id === openId);
  return (
    <Popover.Root open={Boolean(openPlugin)} onOpenChange={(open) => !open && setOpenId(undefined)}>
      <section className="status-plugin-bar" aria-label="Server status plugins">
        <div>
          {plugins.map((plugin) => {
            const button = (
              <button
                type="button"
                aria-expanded={openId === plugin.id}
                aria-label={`${plugin.name}${plugin.text ? `: ${plugin.text}` : ''}`}
                title={plugin.tooltip}
                onPointerDown={(event) => {
                  if (event.button === 0) setOpenId((current) => (current === plugin.id ? undefined : plugin.id));
                }}
                onClick={(event) => {
                  if (event.detail === 0) setOpenId((current) => (current === plugin.id ? undefined : plugin.id));
                }}
              >
                <span>{plugin.name}</span>
                <output>{plugin.state === 'loading' ? '…' : (plugin.text ?? '—')}</output>
                {plugin.state === 'error' || plugin.state === 'stale' ? (
                  <AlertTriangle size={12} aria-hidden="true" />
                ) : null}
              </button>
            );
            return (
              <div key={plugin.id} className="status-plugin">
                {openId === plugin.id ? <Popover.Anchor asChild>{button}</Popover.Anchor> : button}
              </div>
            );
          })}
          <button
            type="button"
            className="status-manage"
            aria-label="Manage status widgets"
            title="Manage status widgets"
            onClick={onManage}
          >
            <LayoutDashboard size={14} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </div>
      </section>
      {openPlugin ? (
        <Popover.Portal>
          <Popover.Content
            className="status-plugin-popover"
            sideOffset={8}
            collisionPadding={8}
            align="start"
            sticky="always"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onPointerDownOutside={(event) => {
              const target = event.detail.originalEvent.target;
              if (target instanceof Element && target.closest('.status-plugin > button')) event.preventDefault();
            }}
          >
            <header>
              <strong>{openPlugin.name}</strong>
              <output>{openPlugin.state === 'loading' ? 'Loading…' : (openPlugin.text ?? '—')}</output>
            </header>
            {openPlugin.progress !== undefined ? (
              <span className="status-progress">
                <i style={{ width: `${openPlugin.progress}%` }} />
              </span>
            ) : null}
            {openPlugin.menu?.map((entry, index) => (
              <MenuEntry key={`${entry.type}-${index}`} entry={entry} />
            ))}
            {openPlugin.error ? <p role="status">{openPlugin.error}</p> : null}
            {openPlugin.updatedAt ? (
              <time dateTime={new Date(openPlugin.updatedAt).toISOString()}>
                Updated {timestamp(openPlugin.updatedAt)}
              </time>
            ) : null}
          </Popover.Content>
        </Popover.Portal>
      ) : null}
    </Popover.Root>
  );
}
