// The preview window is the model's HTML file. Its response sandbox keeps scripts off this origin.
import {apiFetch} from './api';

export const PREVIEW_CHANNEL_PREFIX = 'spark-html-preview:';
export const MAX_PREVIEW_LENGTH = 500_000;

export function openHTMLPreview(source: string) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const popup = window.open('about:blank', '_blank', 'popup,width=1000,height=760');
  if (popup) {
    popup.document.open();
    popup.document.write('<!doctype html><title>HTML preview</title><p>Loading preview…</p>');
    popup.document.close();
    popup.opener = null;
  }
  void publishPreview(id, previewDocument(source), popup);
}

async function publishPreview(id: string, source: string, popup: Window | null) {
  const url = '/api/playground/html-preview/' + id;
  try {
    const response = await apiFetch('/api/playground/html-preview', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id, source}),
    });
    if (!response.ok) throw new Error(String(response.status));
    if (popup && !popup.closed) popup.location.replace(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    if (popup && !popup.closed) {
      popup.document.open();
      popup.document.write('<!doctype html><title>HTML preview</title><p>Could not open the HTML preview.</p>');
      popup.document.close();
    }
  }
}

const FULL_DOCUMENT = /^(?:<!doctype\b|<html[\s>])/i;

/** Keep the model's markup, including scripts. A fragment gets a doctype so the browser parses it as a document. */
export function previewDocument(source: string): string {
  if (FULL_DOCUMENT.test(source.trimStart())) return source;
  return '<!doctype html><meta charset="utf-8">' + source;
}
