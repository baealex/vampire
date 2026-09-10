import * as Popover from '@radix-ui/react-popover';
import type { StatusPluginMenuEntry, StatusPluginSnapshot } from '@vampire/lib/shared/contracts/status-plugin.ts';
import { AlertTriangle, ExternalLink, Settings2, X } from 'lucide-react';
import { useState } from 'react';
import './status-plugin-bar.css';

function timestamp(at: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(at);
}
function Progress({ value, label }: { value: number; label: string }) {
  const percent = Math.max(0, Math.min(100, value));
  return (
    <span
      className="status-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span style={{ width: `${percent}%` }} />
    </span>
  );
}
function MenuEntry({ entry }: { entry: StatusPluginMenuEntry }) {
  if (entry.type === 'separator') return <hr />;
  if (entry.type === 'heading')
    return (
      <div className="status-menu-heading">
        <strong>{entry.text}</strong>
        {entry.badge ? <span className="status-menu-badge">{entry.badge}</span> : null}
      </div>
    );
  const content = (
    <>
      <div className="status-menu-row">
        <strong>
          {entry.checked ? '✓ ' : ''}
          {entry.text}
        </strong>
        {entry.badge ? <span className="status-menu-badge">{entry.badge}</span> : null}
        {entry.value ? <output>{entry.value}</output> : null}
        {entry.href ? <ExternalLink size={13} aria-hidden="true" /> : null}
      </div>
      <div className="status-menu-description">
        {entry.detail ? <small>{entry.detail}</small> : null}
        {entry.time ? (
          <small>
            {entry.time.label ?? 'At'} {timestamp(entry.time.at)}
          </small>
        ) : null}
      </div>
      {entry.progress !== undefined ? <Progress value={entry.progress} label={entry.text} /> : null}
    </>
  );
  return entry.href ? (
    <a className="status-menu-item" data-tone={entry.tone} href={entry.href} target="_blank" rel="noreferrer">
      {content}
    </a>
  ) : (
    <div className="status-menu-item" data-tone={entry.tone}>
      {content}
    </div>
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
            <Settings2 size={14} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </div>
      </section>
      {openPlugin ? (
        <Popover.Portal>
          <Popover.Content
            className="status-plugin-popover"
            aria-label={`${openPlugin.name} details`}
            data-tone={openPlugin.tone}
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
              <div className="status-plugin-summary">
                <strong>{openPlugin.name}</strong>
                <output>{openPlugin.state === 'loading' ? 'Loading…' : (openPlugin.text ?? '—')}</output>
              </div>
              <Popover.Close className="status-plugin-close" aria-label={`Close ${openPlugin.name} details`}>
                <X size={16} aria-hidden="true" />
              </Popover.Close>
              {openPlugin.progress !== undefined ? (
                <Progress value={openPlugin.progress} label={openPlugin.name} />
              ) : null}
            </header>
            {openPlugin.menu?.length ? (
              <div className="status-plugin-menu">
                {openPlugin.menu.map((entry, index) => (
                  <MenuEntry key={`${entry.type}-${index}`} entry={entry} />
                ))}
              </div>
            ) : null}
            {openPlugin.error ? (
              <p className="status-plugin-error" role="status">
                <AlertTriangle size={14} aria-hidden="true" />
                <span>{openPlugin.error}</span>
              </p>
            ) : null}
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
