"use client";

import { useEffect } from "react";

export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="error-screen" role="alert" aria-labelledby="error-title" aria-describedby="error-description">
      <section className="error-card">
        <p className="section-kicker">SYSTEM ERROR</p>
        <h1 id="error-title">FPL Terminal couldn&apos;t render this view.</h1>
        <p id="error-description">An unexpected error interrupted the page. Try again to reload the workspace.</p>
        <button type="button" className="primary-button" onClick={() => retry()}>TRY AGAIN</button>
      </section>
    </main>
  );
}
