export type ProbeReadiness = {
  ready: Promise<boolean>;
  observe: (bytes: Uint8Array) => void;
  finish: () => void;
};

export function createProbeReadiness(marker: string | undefined): ProbeReadiness {
  if (marker === undefined) {
    return { ready: Promise.resolve(true), observe: () => {}, finish: () => {} };
  }
  let resolved = false;
  let resolveReady: (value: boolean) => void = () => {};
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  let text = "";
  const decoder = new TextDecoder();
  const observe = (bytes: Uint8Array) => {
    if (resolved) return;
    text += decoder.decode(bytes, { stream: true });
    if (text.includes(marker)) {
      resolved = true;
      resolveReady(true);
    }
  };
  const finish = () => {
    if (!resolved) {
      resolved = true;
      resolveReady(false);
    }
  };
  return { ready, observe, finish };
}
