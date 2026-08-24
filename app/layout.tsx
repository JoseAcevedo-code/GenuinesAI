import type { Metadata, Viewport } from "next";

import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE, SITE_URL } from "../lib/branding.ts";
import { STORAGE_KEYS } from "../lib/storage.ts";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_NAME,
  description: SITE_DESCRIPTION,
  openGraph: {
    title: SITE_NAME,
    description: SITE_TAGLINE,
    url: "/",
    siteName: SITE_NAME,
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: `${SITE_NAME} — ${SITE_TAGLINE}` }],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_NAME,
    description: SITE_TAGLINE,
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#121827" },
  ],
};

/**
 * Applies the saved (or system) theme before first paint. Without this the page
 * always renders light first and dark-mode users see a white flash on every load,
 * because the stored preference is only readable after React hydrates.
 *
 * It also clears the `no-js` class. The class ships in the server HTML and is
 * removed here, on the first line of script that runs — so if scripting is
 * unavailable it stays, and CSS hides the splash that would otherwise never
 * fade and would cover the page forever.
 */
const THEME_BOOTSTRAP = `(function(){document.documentElement.classList.remove("no-js");try{var t=localStorage.getItem(${JSON.stringify(STORAGE_KEYS.theme)});if(t!=="dark"&&t!=="light"){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.dataset.theme=t}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="no-js" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
