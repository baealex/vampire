import { type ButtonHTMLAttributes, forwardRef } from 'react';
import './primitives.css';

export type ToolbarButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  compact?: boolean;
  label: string;
  text?: string;
};

export const ToolbarButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(function ToolbarButton(
  { active = false, children, className, compact = false, label, text, title = label, type = 'button', ...props },
  ref,
) {
  const classes = [
    'vampire-toolbar-button',
    compact ? 'vampire-toolbar-button--compact' : '',
    text ? 'vampire-toolbar-button--has-text' : '',
    active ? 'vampire-toolbar-button--active' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button ref={ref} className={classes} type={type} aria-label={label} title={title} {...props}>
      {children}
      {text ? <span className="vampire-toolbar-button__text">{text}</span> : null}
    </button>
  );
});
