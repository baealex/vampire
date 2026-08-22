const BRACKETED_SUBMIT_SETTLE_MS = 20;
const UNBRACKETED_SUBMIT_SETTLE_MS = 140;

export function terminalSubmissionData(data: string, bracketedPaste: boolean): string {
  const normalized = data.replace(/\r?\n/g, '\r');
  return bracketedPaste ? `\u001b[200~${normalized}\u001b[201~` : normalized;
}

export function terminalSubmissionSettleMs(bracketedPaste: boolean): number {
  return bracketedPaste ? BRACKETED_SUBMIT_SETTLE_MS : UNBRACKETED_SUBMIT_SETTLE_MS;
}
