/* tslint:disable */
/* eslint-disable */

export function credentialIdHash(method: number, authority_kind: number, authority_id: Uint8Array, raw_credential_id: Uint8Array): Uint8Array;

export function derivePasswordKey(password: Uint8Array, salt: Uint8Array): Uint8Array;

export function deriveRecordKey(root_key: Uint8Array, context_cbor: Uint8Array): Uint8Array;

export function generateNonce(): Uint8Array;

export function generatePassword(): Uint8Array;

export function generateRecoveryKit(): string;

export function openRecord(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ciphertext_and_tag: Uint8Array): Uint8Array;

export function sealRecord(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array;

export function serverIdentityHash(server_public_key: Uint8Array): Uint8Array;

export function validateProtocolCbor(bytes: Uint8Array): Uint8Array;

export function validateRecoveryKit(form: string): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly credentialIdHash: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly derivePasswordKey: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly deriveRecordKey: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly generateNonce: (a: number) => void;
    readonly generatePassword: (a: number) => void;
    readonly generateRecoveryKit: (a: number) => void;
    readonly openRecord: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly sealRecord: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly serverIdentityHash: (a: number, b: number, c: number) => void;
    readonly validateProtocolCbor: (a: number, b: number, c: number) => void;
    readonly validateRecoveryKit: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number, d: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
