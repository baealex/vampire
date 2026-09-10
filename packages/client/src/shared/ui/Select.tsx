import { forwardRef, type SelectHTMLAttributes } from 'react';
import './primitives.css';

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & { size?: 'sm' | 'md' | 'lg' };

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, size = 'md', ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      className={['vampire-select', `vampire-select--${size}`, className].filter(Boolean).join(' ')}
      {...props}
    />
  );
});
