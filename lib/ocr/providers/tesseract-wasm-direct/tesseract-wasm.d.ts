declare module 'tesseract-wasm' {
  export interface OCRClientInit {
    readonly createWorker?: (url: string) => Worker;
    readonly wasmBinary?: Uint8Array | ArrayBuffer;
    readonly workerURL?: string;
  }

  export interface TextItem {
    readonly rect: {
      readonly left: number;
      readonly top: number;
      readonly right: number;
      readonly bottom: number;
    };
    readonly flags: number;
    readonly confidence: number;
    readonly text: string;
  }

  export class OCRClient {
    constructor(init?: OCRClientInit);
    destroy(): Promise<void>;
    loadModel(model: string | ArrayBuffer): Promise<void>;
    loadImage(image: ImageBitmap | ImageData): Promise<void>;
    clearImage(): Promise<void>;
    getTextBoxes(unit: 'line' | 'word'): Promise<TextItem[]>;
  }

  export function supportsFastBuild(): boolean;
}
