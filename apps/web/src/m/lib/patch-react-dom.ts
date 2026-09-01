"use client";

/**
 * 保留入口：React 19 下给 react-dom 挂 createRoot 在部分打包环境会失败（object is not extensible）。
 * Toast/Dialog 实际依赖 next.config 对 react-vant render 的别名替换。
 */
export {};
