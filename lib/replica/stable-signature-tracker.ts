interface SignatureState {
  baseline: string;
  candidate?: string;
  observations: number;
}

/**
 * Confirms an observed signature before promoting it to the new baseline.
 * Poll-driven sources use this to ignore values that change briefly and then
 * return to the last checkpointed state.
 */
export class StableSignatureTracker {
  #states = new WeakMap<object, SignatureState>();

  constructor(private readonly requiredObservations: number) {
    if (!Number.isSafeInteger(requiredObservations) || requiredObservations < 1) {
      throw new Error('Stable signature observations must be a positive integer.');
    }
  }

  prime(owner: object, signature: string): void {
    this.#states.set(owner, { baseline: signature, observations: 0 });
  }

  observe(owner: object, signature: string): boolean {
    const state = this.#states.get(owner);
    if (!state) {
      this.prime(owner, signature);
      return false;
    }
    if (signature === state.baseline) {
      state.candidate = undefined;
      state.observations = 0;
      return false;
    }
    if (signature !== state.candidate) {
      state.candidate = signature;
      state.observations = 1;
      return this.#promoteIfStable(state);
    }
    state.observations += 1;
    return this.#promoteIfStable(state);
  }

  reset(): void {
    this.#states = new WeakMap<object, SignatureState>();
  }

  #promoteIfStable(state: SignatureState): boolean {
    if (
      state.candidate === undefined ||
      state.observations < this.requiredObservations
    ) return false;
    state.baseline = state.candidate;
    state.candidate = undefined;
    state.observations = 0;
    return true;
  }
}
