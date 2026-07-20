/**
 * Experimental Text Detection declarations. Runtime probing remains
 * authoritative because Chrome exposes this API only on some builds/platforms.
 */
type TextDetectorAvailability =
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';

interface TextDetectorOptions {
  readonly languages: readonly string[];
}

interface TextDetectorCreateOptions {
  readonly languages?: readonly string[];
  readonly signal?: AbortSignal;
}

interface DetectedText {
  readonly rawValue?: string;
  readonly boundingBox: DOMRectReadOnly;
  readonly cornerPoints?: readonly { readonly x: number; readonly y: number }[];
}

interface TextDetectorInstance {
  detect(image: ImageBitmapSource): Promise<readonly DetectedText[]>;
}

interface TextDetectorConstructor {
  new (): TextDetectorInstance;
  availability?(
    options: TextDetectorOptions,
  ): Promise<TextDetectorAvailability>;
  create?(
    options?: TextDetectorCreateOptions,
  ): Promise<TextDetectorInstance>;
}

declare const TextDetector: TextDetectorConstructor | undefined;
