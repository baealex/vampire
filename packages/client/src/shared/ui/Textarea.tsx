import { forwardRef, type TextareaHTMLAttributes } from 'react';
import './primitives.css';

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  mono?: boolean;
  size?: 'sm' | 'md' | 'fill' | 'code';
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { autoFocus, className, mono = false, size = 'md', ...props },
  ref
) {
  const classes = ['vampire-textarea', `vampire-textarea--${size}`, mono ? 'vampire-textarea--mono' : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <textarea ref={ref} className={classes} autoFocus={autoFocus} data-autofocus={autoFocus || undefined} {...props} />
  );
});
