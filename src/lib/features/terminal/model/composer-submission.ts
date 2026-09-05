export type RecoverableComposerSubmission = {
  requestId: string;
  draft: string;
  status: 'pending' | 'failed' | 'uncertain';
  message?: string;
};
