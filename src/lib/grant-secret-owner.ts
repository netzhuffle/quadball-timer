export type GrantSecretToken = Readonly<{
  generation: number;
  scopeKey: string;
}>;

export type GrantSecretOwner = {
  capture: (scopeKey: string) => GrantSecretToken;
  current: (token: GrantSecretToken) => boolean;
  commit: (token: GrantSecretToken, action: () => void) => boolean;
  invalidate: (scopeKey: string) => void;
  unmount: () => void;
};

const ALL_SCOPES = "*";

export function createGrantSecretOwner(): GrantSecretOwner {
  let generation = 0;
  let mounted = true;
  const activeGenerations = new Map<string, number>();

  const invalidate = (scopeKey: string) => {
    generation += 1;
    if (scopeKey === ALL_SCOPES) activeGenerations.clear();
    else activeGenerations.delete(scopeKey);
  };

  const capture = (scopeKey: string): GrantSecretToken => {
    generation += 1;
    const token = { generation, scopeKey };
    activeGenerations.set(scopeKey, generation);
    return token;
  };

  const current = (token: GrantSecretToken) =>
    mounted && activeGenerations.get(token.scopeKey) === token.generation;

  return {
    capture,
    current,
    commit: (token, action) => {
      if (!current(token)) return false;
      action();
      return true;
    },
    invalidate,
    unmount: () => {
      mounted = false;
      generation += 1;
      activeGenerations.clear();
    },
  };
}
