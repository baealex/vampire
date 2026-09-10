import type { TmuxStatus } from '@vampire/lib/shared/contracts/tmux-status.ts';
import { RefreshCw } from 'lucide-react';
import { Button } from '~/shared/ui/index.ts';
import './tmux-setup-screen.css';

export function TmuxSetupScreen({ status }: { status: TmuxStatus }) {
  return (
    <main className="tmux-setup-screen">
      <section className="tmux-setup-content" aria-labelledby="tmux-setup-title">
        <div className="tmux-setup-intro">
          <p>Action required</p>
          <h1 id="tmux-setup-title">Install tmux to continue</h1>
          <span>Vampire uses tmux to keep workspace shells running on this server.</span>
        </div>
        <div className="tmux-install-panel">
          <header>
            <span>Run on the Vampire server</span>
            <strong>{status.install.platform}</strong>
          </header>
          <div className="tmux-command-panel" aria-label={`${status.install.platform} tmux installation commands`}>
            <div aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            {status.install.commands.map((command) => (
              <p key={command}>
                <span aria-hidden="true">$</span>
                <code>{command}</code>
              </p>
            ))}
          </div>
          <p>{status.install.note}</p>
          <Button variant="primary" size="lg" block onClick={() => location.reload()}>
            <RefreshCw size={16} aria-hidden="true" />
            Check installation
          </Button>
        </div>
      </section>
    </main>
  );
}
