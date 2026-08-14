export type StartupResourceCleanup = () => void;

export function createStartupCleanup() {
  const cleanups: StartupResourceCleanup[] = [];
  let completed = false;

  return {
    add(cleanup: StartupResourceCleanup): void {
      if (completed) {
        cleanup();
        return;
      }
      cleanups.push(cleanup);
    },
    run(): void {
      if (completed) return;
      completed = true;
      while (cleanups.length > 0) cleanups.pop()?.();
    },
  };
}
