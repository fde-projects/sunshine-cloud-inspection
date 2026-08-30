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
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // docker-compose 已注入环境变量
  }
}

loadRootEnv();

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
};

export default nextConfig;
