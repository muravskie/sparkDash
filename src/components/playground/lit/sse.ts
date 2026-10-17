// Incremental SSE framing; a CRLF pair may be split across network chunks.
export class SseParser {
  private line = '';
  private data: string[] = [];
  private afterCR = false;
  feed(text: string): {data: string}[] {
    const events: {data: string}[] = [];
    for (const c of text) {
      if (this.afterCR && c === '\n') { this.afterCR = false; continue; }
      this.afterCR = c === '\r';
      if (c !== '\r' && c !== '\n') { this.line += c; continue; }
      if (!this.line && this.data.length) { events.push({data: this.data.join('\n')}); this.data = []; }
      else if (this.line.startsWith('data:')) this.data.push(this.line.slice(5).replace(/^ /, ''));
      this.line = '';
    }
    return events;
  }
  /** Emit a last event when the body ends without the usual blank line. */
  finish(): {data: string}[] {
    if (this.line.startsWith('data:')) this.data.push(this.line.slice(5).replace(/^ /, ''));
    this.line = '';
    this.afterCR = false;
    if (!this.data.length) return [];
    const event = {data: this.data.join('\n')};
    this.data = [];
    return [event];
  }
}
