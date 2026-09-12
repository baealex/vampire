import { Button } from './Button.tsx';
import './settings-navigation.css';

export function SettingsNavigation<T extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <nav className="settings-navigation" aria-label={label}>
      {items.map((item) => (
        <Button
          key={item.id}
          variant={value === item.id ? 'secondary' : 'ghost'}
          aria-current={value === item.id ? 'page' : undefined}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </Button>
      ))}
    </nav>
  );
}
