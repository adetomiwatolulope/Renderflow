import type { Metadata } from "next";
import "../design-tokens.css";

export const metadata: Metadata = {
  title: "RenderFlow",
  description: "Background job processing",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
