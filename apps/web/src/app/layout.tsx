import type { Metadata } from "next";
import AntdProvider from "@/components/AntdProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "阳光运维",
  description: "光伏 / 储能现场巡检与结算",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full">
      <body className="min-h-full">
        <AntdProvider>{children}</AntdProvider>
      </body>
    </html>
  );
}
