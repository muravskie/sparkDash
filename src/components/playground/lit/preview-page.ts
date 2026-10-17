import {MAX_PREVIEW_LENGTH, PREVIEW_CHANNEL_PREFIX, previewDocument} from './html-preview';

const id = location.hash.slice(1);
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const frame = document.querySelector<HTMLIFrameElement>('iframe')!;
const storageKey = 'spark-html-preview';

function display(source: string) {
  const bytes = new TextEncoder().encode(previewDocument(source));
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  // The wrapper's frame-src data: blocks subsequent HTTP navigations as well as
  // external requests. allow-same-origin is deliberately absent from the sandbox.
  frame.src = 'data:text/html;base64,' + btoa(binary);
  frame.hidden = false;
  status.hidden = true;
}

function validSource(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PREVIEW_LENGTH;
}

function restore(): boolean {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (saved?.id === id && validSource(saved.source)) {display(saved.source); return true;}
  } catch { /* Storage may be disabled; an initially opened viewer still works. */ }
  return false;
}

if (!/^[a-f0-9]{32}$/.test(id)) status.textContent = 'Open an HTML preview from the Conversation header.';
else if (!restore()) {
  const channel = new BroadcastChannel(PREVIEW_CHANNEL_PREFIX + id);
  const timeout = setTimeout(() => {
    channel.close(); status.textContent = 'Preview expired. Open it again from the Conversation header.';
  }, 15_000);
  channel.onmessage = event => {
    if (event.data?.type !== 'source') return;
    clearTimeout(timeout);
    if (!validSource(event.data.source)) status.textContent = 'This HTML preview is empty or exceeds the 500,000 character limit.';
    else {
      try {sessionStorage.setItem(storageKey, JSON.stringify({id, source: event.data.source}));} catch { /* Reload is optional. */ }
      display(event.data.source);
    }
    channel.postMessage({type: 'received'});
    channel.close();
  };
  channel.postMessage({type: 'ready'});
}
