import type { ReactNode } from "react";
import { PublicPageFooter, PublicPageHeader } from "./PublicPageChrome";
import "./landing.css";
import "./legal.css";

export function LegalPage({
  page,
  title,
  eyebrow,
  description,
  children,
}: {
  page: "privacy" | "terms";
  title: string;
  eyebrow: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="landing legal-page">
      <a className="landing-skip" href="#main">
        Skip to content
      </a>
      <div className="landing-shell">
        <PublicPageHeader page={page} />
        <main id="main" className="legal-content">
          <header className="legal-heading">
            <span className="eyebrow">tmp.cash / {eyebrow}</span>
            <h1>{title}</h1>
            <p className="legal-lead">{description}</p>
            <p className="small muted">
              Last updated <time dateTime="2026-11-09">9 November 2026</time>
            </p>
          </header>
          <article aria-label={`tmp.cash ${title.toLowerCase()}`}>
            {children}
          </article>
        </main>
        <PublicPageFooter page={page} />
      </div>
    </div>
  );
}
