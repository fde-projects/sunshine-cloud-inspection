/**
 * React 19 兼容：createRoot 从 react-dom/client 引入。
 * 供 next.config 别名替换 react-vant/es|lib/utils/dom/render。
 */
import type { ReactNode } from "react";
import { createRoot as createRootFn, type Root } from "react-dom/client";

const MARK = "__react_vant_root__";

type MarkedContainer = Element & {
  [MARK]?: Root;
};

export function render(node: ReactNode, container: Element) {
  const el = container as MarkedContainer;
  const root = el[MARK] || createRootFn(container);
  root.render(node);
  el[MARK] = root;
}

export async function unmount(container: Element) {
  const el = container as MarkedContainer;
  await Promise.resolve().then(() => {
    el[MARK]?.unmount();
    delete el[MARK];
  });
}
