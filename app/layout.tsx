import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent 最小实验台",
  description: "配置工具并查看 Agent 每轮完整的模型输入、输出和上下文。",
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
