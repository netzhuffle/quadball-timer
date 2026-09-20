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
      const errors: unknown[] = [];
      while (cleanups.length > 0) {
        try {
          cleanups.pop()?.();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, "Resource cleanup failed.");
    },
  };
}
