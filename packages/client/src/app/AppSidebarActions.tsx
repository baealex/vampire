import { Network, Settings } from 'lucide-react';
import { ThemeToggle } from '~/shared/ui/index.ts';
import styles from './app-sidebar-actions.module.css';

export function AppSidebarActions({ onPorts, onSettings }: { onPorts: () => void; onSettings: () => void }) {
  return (
    <nav className={styles.rail} aria-label="Application">
      <img className={styles.logo} src="/icon.svg" alt="Vampire" />
      <div className={styles.actions}>
        <button type="button" aria-label="Inspect listening ports" title="Listening ports" onClick={onPorts}>
          <Network size={17} aria-hidden="true" />
        </button>
        <div className={styles.theme}>
          <ThemeToggle compact />
        </div>
        <button type="button" aria-label="Open settings" title="Settings" onClick={onSettings}>
          <Settings size={17} aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
