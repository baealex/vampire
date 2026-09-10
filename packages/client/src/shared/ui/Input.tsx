import { forwardRef, type InputHTMLAttributes } from 'react';
import './primitives.css';

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  mono?: boolean;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'default' | 'embedded';
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { autoFocus, className, mono = false, size = 'md', variant = 'default', ...props },
  ref
) {
  const classes = [
    'vampire-input',
    `vampire-input--${size}`,
    variant === 'embedded' ? 'vampire-input--embedded' : '',
    mono ? 'vampire-input--mono' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <input ref={ref} className={classes} autoFocus={autoFocus} data-autofocus={autoFocus || undefined} {...props} />
  );
});
