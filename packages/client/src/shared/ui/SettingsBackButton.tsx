import { ArrowLeft } from 'lucide-react';
import type { ButtonProps } from './Button.tsx';
import { Button } from './Button.tsx';
import './settings-back-button.css';

export function SettingsBackButton({
  className,
  label,
  ...props
}: Omit<ButtonProps, 'children' | 'size' | 'variant'> & { label: string }) {
  return (
    <Button
      {...props}
      className={['vampire-settings-back-button', className].filter(Boolean).join(' ')}
      variant="ghost"
      size="sm"
    >
      <ArrowLeft size={15} strokeWidth={1.9} aria-hidden="true" />
      {label}
    </Button>
  );
}
