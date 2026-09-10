import { Network, Settings2 } from 'lucide-react';
import './app-sidebar-actions.css';

export function AppSidebarActions({ onPorts, onSettings }: { onPorts: () => void; onSettings: () => void }) {
  return (
    <nav className="app-sidebar-actions" aria-label="Application">
      <img src="/icon.svg" alt="Vampire" />
      <button type="button" aria-label="Inspect listening ports" title="Listening ports" onClick={onPorts}>
        <Network size={17} aria-hidden="true" />
      </button>
      <button type="button" aria-label="Open settings" title="Settings" onClick={onSettings}>
        <Settings2 size={17} aria-hidden="true" />
      </button>
    </nav>
  );
}
