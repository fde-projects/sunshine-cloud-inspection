"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { HelpManual } from "./types";
import HelpTocPicker from "./HelpTocPicker";

function canScrollBox(node: Element | null): node is HTMLElement {
  if (!(node instanceof HTMLElement)) return false;
  const y = getComputedStyle(node).overflowY;
  return (y === "auto" || y === "scroll") && node.scrollHeight > node.clientHeight + 8;
}

function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const content = document.querySelector(".help-content");
  if (canScrollBox(content)) {
    const top = el.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop - 12;
    content.scrollTo({ top, behavior: "smooth" });
    return;
  }
  const page = document.querySelector(".help-page");
  if (canScrollBox(page)) {
    const top = el.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop - 12;
    page.scrollTo({ top, behavior: "smooth" });
    return;
  }
  const sticky = document.querySelector(".help-sticky");
  const offset = sticky instanceof HTMLElement ? sticky.getBoundingClientRect().height + 8 : 12;
  const top = el.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

export default function HelpManualView({
  manual,
  toolbar,
}: {
  manual: HelpManual;
  toolbar?: ReactNode;
}) {
  const [active, setActive] = useState(manual.sections[0]?.id || "");

  const toc = useMemo(
    () => manual.sections.map((s) => ({ id: s.id, title: s.title })),
    [manual.sections],
  );

  useEffect(() => {
    const nodes = manual.sections
      .map((s) => document.getElementById(s.id))
      .filter((n): n is HTMLElement => Boolean(n));
    if (!nodes.length) return;

    const content = document.querySelector(".help-content");
    const pageRoot = document.querySelector(".help-page");
    const root = canScrollBox(content) ? content : canScrollBox(pageRoot) ? pageRoot : null;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target.id) setActive(visible.target.id);
      },
      { root: root instanceof HTMLElement ? root : null, rootMargin: "-10% 0px -55% 0px", threshold: [0.1, 0.35] },
    );
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, [manual.sections]);

  const jumpTo = (id: string) => {
    setActive(id);
    requestAnimationFrame(() => scrollToId(id));
  };

  return (
    <div className="help-page">
      <aside className="help-toc" aria-label="手册目录">
        <h2 className="help-toc__title">{manual.title}</h2>
        <p className="help-toc__hint">点左边就能跳到对应步骤</p>
        <nav className="help-toc__nav">
          {toc.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`help-toc__link${active === item.id ? " is-active" : ""}`}
              onClick={() => jumpTo(item.id)}
            >
              {item.title}
            </button>
          ))}
        </nav>
      </aside>

      <div className="help-sticky">
        {toolbar}
        <div className="help-toc-mobile">
          <HelpTocPicker items={toc} value={active} onChange={jumpTo} />
        </div>
      </div>

      <article className="help-content">
        <header className="help-hero">
          <h1>{manual.title}</h1>
          <p>{manual.subtitle}</p>
        </header>

        {manual.sections.map((section) => (
          <section key={section.id} id={section.id} className="help-section">
            <h2 className="help-section__title">{section.title}</h2>
            {section.intro ? <p className="help-section__intro">{section.intro}</p> : null}
            {section.steps.map((step, index) => (
              <div key={step.id} id={step.id} className="help-step">
                <div className="help-step__head">
                  <span className="help-step__index">{index + 1}</span>
                  <h3 className="help-step__title">{step.title}</h3>
                </div>
                <figure className="help-step__figure">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={step.image} alt={step.imageAlt} />
                </figure>
                <div className="help-step__body">
                  {step.body.map((p) => (
                    <p key={p}>{p}</p>
                  ))}
                </div>
                {step.caution ? <div className="help-caution">⚠️ 注意事项：{step.caution}</div> : null}
              </div>
            ))}
          </section>
        ))}
      </article>
    </div>
  );
}
