export type ImagePasteNoticeKind = 'uploading' | 'success' | 'error' | '';

export class TerminalImagePasteState {
  kind = $state<ImagePasteNoticeKind>('');
  message = $state('');

  #noticeTimer: ReturnType<typeof setTimeout> | undefined;
  #requestId = 0;
  readonly #workspaceId: string;
  readonly #terminalId: string | undefined;
  readonly #isConnected: () => boolean;

  constructor(workspaceId: string, terminalId: string | undefined, isConnected: () => boolean) {
    this.#workspaceId = workspaceId;
    this.#terminalId = terminalId;
    this.#isConnected = isConnected;
  }

  #setNotice(kind: ImagePasteNoticeKind, message: string, duration = 5_000) {
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    this.kind = kind;
    this.message = message;
    if (duration > 0) {
      this.#noticeTimer = setTimeout(() => {
        this.kind = '';
        this.message = '';
        this.#noticeTimer = undefined;
      }, duration);
    }
  }

  async paste(image: File) {
    const requestId = ++this.#requestId;
    if (!this.#isConnected()) {
      this.#setNotice('error', 'Connect to the terminal before sending an image.');
      return;
    }

    this.#setNotice('uploading', 'Sending image to the shell…', 0);
    const form = new FormData();
    form.append('image', image, image.name || 'pasted-image');
    try {
      const terminalQuery = this.#terminalId ? `?terminal=${encodeURIComponent(this.#terminalId)}` : '';
      const response = await fetch(`/api/workspaces/${encodeURIComponent(this.#workspaceId)}/image${terminalQuery}`, {
        method: 'POST',
        body: form,
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const message =
          body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
            ? body.message
            : 'The image could not be pasted into the terminal.';
        throw new Error(message);
      }
      if (requestId === this.#requestId) this.#setNotice('success', 'Image pasted into the shell.');
    } catch (error) {
      if (requestId === this.#requestId) {
        this.#setNotice('error', error instanceof Error ? error.message : 'Image paste failed.');
      }
    }
  }

  async handleClipboardPaste(event: ClipboardEvent) {
    const imageItem = Array.from(event.clipboardData?.items ?? []).find(
      (item) => item.kind === 'file' && item.type.startsWith('image/')
    );
    const image = imageItem?.getAsFile();
    if (!image) return;

    event.preventDefault();
    await this.paste(image);
  }

  dispose() {
    this.#requestId += 1;
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    this.#noticeTimer = undefined;
  }
}
