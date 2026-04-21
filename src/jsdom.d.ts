declare module "jsdom" {
  export class JSDOM {
    constructor(html: string, options?: any);
    readonly window: Window & typeof globalThis;
    readonly document: Document;
  }
}