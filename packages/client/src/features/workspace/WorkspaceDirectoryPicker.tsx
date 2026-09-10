import { ArrowUp, ChevronRight, Folder } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { requestJson } from '~/shared/api/request.ts';
import { Button, Dialog, Input, Spinner } from '~/shared/ui/index.ts';
import type { WorkspaceState } from './model/workspace-state.ts';
import './workspace-directory-picker.css';

type Listing = {
  roots: Array<{ id: string; label: string; path: string }>;
  current: { rootId: string; label: string; path: string } | null;
  parentPath: string | null;
  directories: Array<{ name: string; path: string }>;
  truncated: boolean;
};
export function WorkspaceDirectoryPicker({ state }: { state: WorkspaceState }) {
  const [path, setPath] = useState(state.cwd);
  const [listing, setListing] = useState<Listing>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const load = async (target?: string) => {
    setLoading(true);
    setError('');
    setFilter('');
    try {
      const value = await requestJson<Listing>(
        `/api/workspace-directories${target ? `?path=${encodeURIComponent(target)}` : ''}`,
        { cache: 'no-store' },
        'Unable to read workspace directories.'
      );
      if (!target && !value.current && value.roots.length === 1) {
        await load(value.roots[0]!.path);
        return;
      }
      setListing(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to read workspace directories.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load(path || undefined);
  }, []);
  const directories = useMemo(
    () =>
      listing?.directories.filter(
        (directory) =>
          (showHidden || !directory.name.startsWith('.')) &&
          directory.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())
      ) ?? [],
    [filter, listing, showHidden]
  );
  const open = async (target: string) => {
    state.cwd = target.trim();
    setPath(target.trim());
    await state.createWorkspace();
  };
  return (
    <Dialog
      open
      title="Open a project"
      onClose={() => {
        if (!state.starting) state.newWorkspaceOpen = false;
      }}
    >
      <div className="directory-picker">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void open(path);
          }}
        >
          <label>
            Project path<span>Paste an absolute path from an allowed workspace root.</span>
          </label>
          <div>
            <Input
              autoFocus
              mono
              value={path}
              onChange={(event) => setPath(event.currentTarget.value)}
              placeholder="/Users/you/project"
              aria-label="Project path"
            />
            <Button type="submit" variant="primary" disabled={state.starting || !path.trim()}>
              {state.starting ? 'Opening…' : 'Open'}
            </Button>
          </div>
          {state.startError ? <p role="alert">{state.startError}</p> : null}
        </form>
        <section>
          <header>
            <h3>Browse folders</h3>
            <p>Only folders allowed by the server are shown.</p>
          </header>
          {loading ? (
            <div className="directory-state">
              <Spinner />
              Loading folders…
            </div>
          ) : error ? (
            <div className="directory-state" role="alert">
              {error}
              <Button size="sm" onClick={() => void load(listing?.current?.path)}>
                Try again
              </Button>
            </div>
          ) : listing?.current ? (
            <>
              <div className="directory-current">
                <Button
                  variant="icon"
                  aria-label="Go to parent folder"
                  disabled={!listing.parentPath}
                  onClick={() => void load(listing.parentPath ?? undefined)}
                >
                  <ArrowUp size={17} />
                </Button>
                <span>
                  <strong>{listing.current.label}</strong>
                  <small>{listing.current.path}</small>
                </span>
                <Button size="sm" onClick={() => void open(listing.current!.path)}>
                  Open this folder
                </Button>
              </div>
              {listing.directories.length > 8 ? (
                <Input
                  size="sm"
                  type="search"
                  value={filter}
                  onChange={(event) => setFilter(event.currentTarget.value)}
                  placeholder="Filter folders"
                  aria-label="Filter folders"
                />
              ) : null}
              <div className="directory-list">
                {directories.map((directory) => (
                  <button type="button" key={directory.path} onClick={() => void load(directory.path)}>
                    <Folder size={17} />
                    <span>
                      <strong>{directory.name}</strong>
                      <small>{directory.path}</small>
                    </span>
                    <ChevronRight size={16} />
                  </button>
                ))}
              </div>
              {listing.directories.some((directory) => directory.name.startsWith('.')) ? (
                <button className="hidden-toggle" type="button" onClick={() => setShowHidden((value) => !value)}>
                  {showHidden ? 'Hide' : 'Show'}{' '}
                  {listing.directories.filter((directory) => directory.name.startsWith('.')).length} hidden folder
                  {listing.directories.filter((directory) => directory.name.startsWith('.')).length === 1 ? '' : 's'}
                </button>
              ) : null}
              {listing.truncated ? <p>Only the first 512 folders are shown.</p> : null}
            </>
          ) : (
            <div className="directory-list">
              {listing?.roots.map((root) => (
                <button type="button" key={root.id} onClick={() => void load(root.path)}>
                  <Folder size={17} />
                  <span>
                    <strong>{root.label}</strong>
                    <small>{root.path}</small>
                  </span>
                  <ChevronRight size={16} />
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </Dialog>
  );
}
