import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../theme/theme.ts';
import { ToolbarButton } from './ToolbarButton.tsx';

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const current = useTheme((state) => state.current);
  const toggle = useTheme((state) => state.toggle);
  const nextTheme = current === 'dark' ? 'light' : 'dark';
  return (
    <ToolbarButton
      compact={compact}
      onClick={toggle}
      label={`Switch to ${nextTheme} theme`}
      title={`Switch to ${nextTheme} theme`}
    >
      {current === 'dark' ? (
        <Sun size={18} strokeWidth={1.8} aria-hidden="true" />
      ) : (
        <Moon size={18} strokeWidth={1.8} aria-hidden="true" />
      )}
    </ToolbarButton>
  );
}
