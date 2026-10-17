import {html, type PropertyValues} from 'lit';
import {customElement, property, state} from 'lit/decorators.js';
import {unsafeHTML} from 'lit/directives/unsafe-html.js';
import {LightElement} from './base';
import {parseAnswer, sanitizeMarkdown} from './rendering';
import {openHTMLPreview} from './html-preview';

@customElement('spark-answer-view')
export class AnswerView extends LightElement {
  @property() declare content: string;
  @property() declare viewKey: string;
  @property({type: Boolean}) declare streaming: boolean;
  @property({type: Boolean}) declare plain: boolean;
  @state() private declare markup: string;
  @state() private declare documents: string[];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private renderedAt = 0;

  constructor() {
    super();
    this.content = '';
    this.viewKey = '';
    this.streaming = false;
    this.plain = false;
    this.markup = '';
    this.documents = [];
  }

  protected willUpdate(changed: PropertyValues) {
    if (changed.has('viewKey')) this.renderedAt = 0;
    if (changed.has('content') || changed.has('streaming') || changed.has('viewKey') || changed.has('plain') && !this.plain) {
      const delay = this.streaming && !changed.has('plain') ? Math.max(0, 120 - (performance.now() - this.renderedAt)) : 0;
      if (!delay) this.refresh();
      else if (!this.timer) this.timer = setTimeout(() => {this.timer = null; if (this.isConnected) this.refresh();}, delay);
    }
  }
  protected updated(changed: PropertyValues) {
    if (changed.has('documents') || changed.has('viewKey')) this.dispatchEvent(new CustomEvent('answer-capabilities', {bubbles: true, detail: {viewKey: this.viewKey, documents: this.documents.length}}));
    if (changed.has('markup') || changed.has('plain') || this.plain && changed.has('content')) this.dispatchEvent(new CustomEvent('answer-rendered', {bubbles: true}));
  }
  private refresh() {
    if (this.timer) {clearTimeout(this.timer); this.timer = null;}
    this.renderedAt = performance.now();
    if (this.plain && this.streaming) return;
    const result = parseAnswer(this.content);
    this.markup = this.plain ? '' : sanitizeMarkdown(result.markdown); this.documents = result.documents;
    this.renderedAt = performance.now();
  }
  disconnectedCallback() {super.disconnectedCallback(); if (this.timer) clearTimeout(this.timer); this.timer = null;}
  preview(index = 0) {
    const source = this.documents[index]; if (this.streaming || !source) return;
    openHTMLPreview(source);
  }
  render() {
    return html`<div class="message-content ${this.plain ? '' : 'markdown-content'}">${this.plain ? this.content : unsafeHTML(this.markup)}</div>`;
  }
}
