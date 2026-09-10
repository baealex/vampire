import { Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  WORKSPACE_AGENT_ACTION_REQUEST_MAX_LENGTH,
  type WorkspaceAgentActionDescriptor,
  type WorkspaceAgentActionSubmission,
} from '@vampire/lib/shared/contracts/workspace-agent-actions.ts';
import { Button } from './Button.tsx';
import { Field } from './Field.tsx';
import { Textarea } from './Textarea.tsx';
import './ask-agent-panel.css';

export function AskAgentPanel({
  close,
  load,
  onSubmitted,
  showTarget = true,
  submit,
}: {
  close: () => void;
  load: () => Promise<WorkspaceAgentActionDescriptor>;
  onSubmitted?: (submission: WorkspaceAgentActionSubmission) => void;
  showTarget?: boolean;
  submit: (request: string) => Promise<WorkspaceAgentActionSubmission>;
}) {
  const [descriptor, setDescriptor] = useState<WorkspaceAgentActionDescriptor>();
  const [request, setRequest] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef<HTMLTextAreaElement>(null);
  const loadDescriptor = async () => {
    setLoading(true);
    setError('');
    try {
      const value = await load();
      setDescriptor(value);
      setRequest(value.defaultRequest);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The agent request could not be prepared.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void loadDescriptor();
  }, []);
  const send = async () => {
    if (!descriptor || !request.trim() || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const submission = await submit(request.trim());
      onSubmitted?.(submission);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The agent request could not be sent.');
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <section
      className="ask-agent-embedded"
      aria-busy={loading}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !submitting) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <header>
        <span>Ask agent</span>
        <h2>{descriptor?.title ?? 'Prepare agent request'}</h2>
      </header>
      <div className="ask-agent">
        {descriptor ? (
          <>
            {showTarget ? (
              <div className="ask-agent__target">
                <span>Send to</span>
                <strong>{descriptor.target.processLabel}</strong>
                <small>{descriptor.target.workspaceLabel}</small>
              </div>
            ) : null}
            <p className="ask-agent__description">{descriptor.description}</p>
            <dl className="ask-agent__context">
              {descriptor.context.map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>
                    <code>{item.value}</code>
                  </dd>
                  {item.description ? <small>{item.description}</small> : null}
                </div>
              ))}
            </dl>
            <Field
              label={descriptor.requestLabel}
              description="Vampire prepares the required context and sends the request to the visible main session."
            >
              <Textarea
                ref={requestRef}
                autoFocus
                value={request}
                rows={6}
                maxLength={WORKSPACE_AGENT_ACTION_REQUEST_MAX_LENGTH}
                placeholder={descriptor.requestPlaceholder}
                aria-label={descriptor.requestLabel}
                disabled={submitting}
                onChange={(event) => setRequest(event.currentTarget.value)}
              />
            </Field>
          </>
        ) : loading ? (
          <p className="ask-agent__loading" role="status">
            Preparing agent context…
          </p>
        ) : null}
        {error ? (
          <p className="ask-agent__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <footer>
        <Button variant="ghost" onClick={close} disabled={submitting}>
          Back
        </Button>
        {!descriptor && !loading ? (
          <Button onClick={() => void loadDescriptor()}>Retry</Button>
        ) : (
          <Button
            variant="primary"
            onClick={() => void send()}
            disabled={!descriptor || !request.trim() || loading || submitting}
          >
            <Send size={15} aria-hidden="true" />
            {submitting ? 'Sending…' : 'Send to agent'}
          </Button>
        )}
      </footer>
    </section>
  );
}
