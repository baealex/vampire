import { type ButtonHTMLAttributes, forwardRef } from 'react';
import './primitives.css';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  block?: boolean;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'primary' | 'secondary' | 'danger' | 'danger-outline' | 'ghost' | 'icon';
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { block = false, className, size = 'md', type = 'button', variant = 'secondary', ...props },
  ref,
) {
  const classes = [
    'vampire-button',
    `vampire-button--${variant}`,
    variant === 'icon' ? '' : `vampire-button--${size}`,
    block ? 'vampire-button--block' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return <button ref={ref} className={classes} type={type} {...props} />;
});
