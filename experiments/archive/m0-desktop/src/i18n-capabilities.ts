export type LocaleCapability = Readonly<{
  source: "platform-adapter";
  affectsProtocolBytes: false;
  systemLocaleEvidence: "unverified" | "native-runner-required";
}>;

export const localeCapability: LocaleCapability = Object.freeze({
  source: "platform-adapter",
  affectsProtocolBytes: false,
  systemLocaleEvidence: "unverified",
});
