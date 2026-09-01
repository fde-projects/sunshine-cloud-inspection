import { readFileSync } from "fs";
import { resolve } from "path";
import type { NextConfig } from "next";

function loadRootEnv() {
  const file = resolve(__dirname, "../../.env");
  try {
    const text = readFileSync(file, "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i < 0) continue;
      const key = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      // 始终以仓库根 .env 为准，避免旧进程环境残留七牛等配置
      if (key) process.env[key] = value;
    }
  } catch {
    // docker-compose 已注入环境变量
  }
}

loadRootEnv();

const reactVantRender = resolve(__dirname, "src/m/lib/react-vant-render.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  devIndicators: false,
  transpilePackages: ["antd", "@ant-design/icons", "react-vant", "leaflet"],
  // 开发态穿透（cpolar）会从公网域名拉 /_next/*，默认会被拦导致卡在「正在进入」
  allowedDevOrigins: [
    "*.cpolar.cn",
    "*.cpolar.io",
    "*.vip.cpolar.cn",
    "*.r16.cpolar.cn",
    "*.r16.vip.cpolar.cn",
  ],
  // react-vant Toast/Dialog 在 React 19 下 createRoot 取不到，替换其 render 工具
  turbopack: {
    resolveAlias: {
      "react-vant/es/utils/dom/render.js": reactVantRender,
      "react-vant/es/utils/dom/render": reactVantRender,
      "react-vant/lib/utils/dom/render.js": reactVantRender,
      "react-vant/lib/utils/dom/render": reactVantRender,
    },
  },
  webpack: (config) => {
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...config.resolve.alias,
      "react-vant/es/utils/dom/render.js": reactVantRender,
      "react-vant/es/utils/dom/render": reactVantRender,
      "react-vant/lib/utils/dom/render.js": reactVantRender,
      "react-vant/lib/utils/dom/render": reactVantRender,
    };
    return config;
  },
};

export default nextConfig;
