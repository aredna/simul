import type { ReplicaSourceDocumentIdentity } from './source-identity';

export {
  sameSourceDocument,
  type ReplicaSourceDocumentIdentity,
} from './source-identity';

export interface ReplicaSourceDomTextRecord {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly nodeId: number;
  readonly nodeType: 3;
  readonly revision: number;
  readonly source: string;
}

export interface ReplicaSourceControlTextRecord {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly nodeId: number;
  readonly nodeType: 1;
  readonly controlTarget: 'value' | 'placeholder' | 'label';
  readonly revision: number;
  readonly source: string;
}

export type ReplicaSourceTextRecord =
  | ReplicaSourceDomTextRecord
  | ReplicaSourceControlTextRecord;

export type ReplicaSourceTextChange =
  | {
      readonly kind: 'upsert';
      readonly record: ReplicaSourceTextRecord;
    }
  | {
      readonly kind: 'remove';
      readonly document: ReplicaSourceDocumentIdentity;
      readonly nodeId: number;
      readonly revision: number;
    };
