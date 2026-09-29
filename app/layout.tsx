import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Lab · 智能体实验台",
  description: "对照智能体架构，追踪模型请求、工具调用与执行结果。",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg?v=3",
    shortcut: "/favicon.svg?v=3",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
