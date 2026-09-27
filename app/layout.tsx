import type { Metadata } from "next";
import "../design-tokens.css";

export const metadata: Metadata = {
  title: "RenderFlow",
  description: "Background job processing",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <head>
        {/*
          DS-7: the .typography-* classes name these exact families, so they are
          loaded once here by name. next/font is not used because it renames the
          families and the classes would not match.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=Lora:wght@600&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
