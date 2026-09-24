import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Trace Studio",
  description: "实时展示 Agent 接收问题、循环调用工具并生成结构化结果的执行台。",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
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
