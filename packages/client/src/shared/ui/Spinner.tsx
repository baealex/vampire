import './primitives.css';

export function Spinner({ size = 'medium' }: { size?: 'small' | 'medium' }) {
  return <span className={`vampire-spinner${size === 'small' ? ' vampire-spinner--small' : ''}`} aria-hidden="true" />;
}
