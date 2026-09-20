import { Component, Suspense, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** A failed import is cached by React and may reference a retired deployment's asset.
 * Reloading gets both a fresh document/asset manifest and a fresh module cache.
 * Route credentials and admission remain owned by the destination page.
 */
export class DeferredRoute extends Component<
  { name: string; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (this.state.failed) {
      return (
        <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 p-6">
          <div role="alert">
            <h1 className="text-xl font-semibold">{this.props.name} could not load</h1>
            <p>Check your connection, then reload this page to try again.</p>
          </div>
          <Button onClick={() => window.location.reload()}>Reload page</Button>
          <a className="underline" href="/events?view=all">
            Back to Home
          </a>
        </main>
      );
    }

    return (
      <Suspense
        fallback={
          <main className="mx-auto flex min-h-screen max-w-xl items-center p-6">
            <p role="status" aria-live="polite">
              Loading {this.props.name}…
            </p>
          </main>
        }
      >
        {this.props.children}
      </Suspense>
    );
  }
}
