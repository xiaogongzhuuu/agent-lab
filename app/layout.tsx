import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent 调用可视化平台",
  description: "逐步学习 Tool Calling 与 ReAct 循环的交互实验室。",
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
