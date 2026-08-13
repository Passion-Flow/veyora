export type CapabilityDisposition =
  | "source-only"
  | "unavailable-local"
  | "native-runner-required";

export type PlatformCapability = Readonly<{
  id: string;
  disposition: CapabilityDisposition;
  secretBearing: boolean;
}>;

export const platformCapabilities: readonly PlatformCapability[] = Object.freeze([
  { id: "csprng", disposition: "source-only", secretBearing: true },
  { id: "argon2id-65536-3-1", disposition: "source-only", secretBearing: true },
  { id: "xchacha20poly1305", disposition: "source-only", secretBearing: true },
  { id: "exact-unicode", disposition: "source-only", secretBearing: true },
  { id: "clipboard-ownership", disposition: "native-runner-required", secretBearing: true },
  { id: "dialog-and-focus", disposition: "native-runner-required", secretBearing: false },
  { id: "forced-colors", disposition: "native-runner-required", secretBearing: false },
  { id: "reduced-motion", disposition: "native-runner-required", secretBearing: false },
  { id: "system-locale", disposition: "native-runner-required", secretBearing: false },
  { id: "encrypted-cache", disposition: "native-runner-required", secretBearing: true },
  { id: "platform-credential-wrapper", disposition: "native-runner-required", secretBearing: true },
  { id: "remote-origin-denial", disposition: "native-runner-required", secretBearing: false },
]);
