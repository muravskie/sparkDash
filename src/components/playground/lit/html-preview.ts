// Same-origin window transport only. Generated scripts never run on this origin.
export const PREVIEW_CHANNEL_PREFIX = 'spark-html-preview:';
export const MAX_PREVIEW_LENGTH = 500_000;

export function openHTMLPreview(source: string) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const channel = new BroadcastChannel(PREVIEW_CHANNEL_PREFIX + id);
  const timeout = setTimeout(() => channel.close(), 15_000);
  channel.onmessage = event => {
    if (event.data?.type === 'ready') channel.postMessage({type: 'source', source});
    if (event.data?.type === 'received') {clearTimeout(timeout); channel.close();}
  };
  window.open('/preview.html#' + id, '_blank', 'popup,width=1000,height=760,noopener,noreferrer');
}

export function previewDocument(source: string): string {
  // Prepend the policy before any model-provided markup is parsed. Additional
  // policies in that markup cannot relax this one. Do not sanitize away scripts:
  // isolation is enforced by the iframe sandbox and both documents' CSPs.
  return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;unsafe-inline&#39;; style-src &#39;unsafe-inline&#39;; img-src data: blob:; font-src data:; media-src data: blob:; connect-src &#39;none&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;; frame-src &#39;none&#39;; object-src &#39;none&#39;; worker-src &#39;none&#39;"><meta name="referrer" content="no-referrer"><style>body{margin:20px;font:16px/1.5 system-ui,sans-serif;color:#20252c;background:white}img,svg,canvas{max-width:100%}pre{overflow:auto}</style>' + source;
}
