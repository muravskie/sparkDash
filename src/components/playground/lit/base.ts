// Light DOM so the copied playground stylesheet can reach the markup.
import { LitElement } from "lit";

export class LightElement extends LitElement {
  protected createRenderRoot(): HTMLElement {
    return this;
  }
}
